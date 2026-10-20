import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual repository review.");
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
try {
    for (const theme of ["light", "dark"]) {
        for (const width of [1280, 900, 390]) {
            const height = width === 390 ? 844 : 800;
            const page = await browser.newPage({ viewport: { width, height } });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${url}?scoutTheme=${theme}`);
            const start = page.locator("#overview-start");
            await start.waitFor();
            const bounds = await start.boundingBox();
            assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height,
                `Primary review action must be above the fold at ${width}px: ${JSON.stringify(bounds)}`);
            assert.equal(await page.locator("#review-background").evaluate((details) => details.open), false);
            assert.match(await page.locator("#overview-progress").textContent(), /changed files?/);
            assert.equal(await page.locator("#breadcrumbs").isVisible(), false, "the Overview has one reading path, not a Review plan link");
            assert.equal(await page.locator("#summary").isVisible(), false, "metric cards stay behind the change-summary disclosure");
            assert.equal(await page.locator("#review-target-label").isVisible(), false, "the target identity appears once, in the workflow row");
            assert.equal(await page.locator("#review-overview .review-next, #overview-start").count(), 1, "one green primary on the Overview");
            if (width === 390) assert.ok(bounds.y <= 420, `Primary action must sit high on narrow screens: ${bounds.y}`);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
                await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `overview-${theme}-${width}.png`) });
            }
            await start.focus();
            await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
            await start.press("Enter");
            await page.locator("#source-panel").waitFor();
            await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
                && document.querySelector("#source")?.querySelector(".code-row"));
            await page.locator("#source-close").click();
            assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#review-navigation, #review-workflow"))), true,
                "Closing source returns to visible navigation in the review workspace");
            await page.locator("#workflow-overview").click();
            await page.locator("#review-background > summary").click();
            assert.equal(await page.locator("#change-brief").isVisible(), true);
            await page.locator("#review-background > summary").click();
            await page.locator("#overview-files").click();
            await page.locator("#workspace-files[aria-pressed='true']").waitFor();
            assert.deepEqual(errors, []);
            console.log(`PASS ${theme} ${width}: visible next action, compact defaults, keyboard source/return, full details and all-file access`);
            await page.close();
        }
    }
} finally { await browser.close(); }
