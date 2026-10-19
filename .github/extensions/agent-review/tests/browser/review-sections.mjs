import assert from "node:assert/strict";
import { openReviewTool } from "./review-details-helper.mjs";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual repository review.");
const data = await fetch(new URL("/api/review-sections", url)).then((response) => {
    assert.equal(response.status, 200);
    return response.json();
});
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
try {
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await openReviewTool(page, "groups");
        const sections = page.locator(".review-sections");
        await sections.waitFor();
        assert.match(await sections.textContent(), new RegExp(`${data.represented_files} changed files? represented`));
        const first = page.locator(".section-card:not(.supporting-sections)").first();
        if (await first.count()) {
            await first.locator(":scope > summary").click();
            await first.getByRole("button", { name: "Open first range", exact: true }).click();
            await page.locator("#source-panel").waitFor();
            await page.locator("#source-section").click();
            assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SUMMARY");
            assert.match(await first.textContent(), /\d+ of \d+ files? reviewed/, "section progress derives from whole-file decisions");
            assert.equal(await first.getByRole("button", { name: "Mark section reviewed", exact: true }).count(), 0);
            await first.getByRole("button", { name: "Ask about section", exact: true }).click();
            await page.locator("#item-question").waitFor();
            await page.locator("#item-discussion").getByText(/Read-only/).waitFor();
            assert.match(await page.locator("#item-discussion").textContent(), /Read-only/);
            await page.locator("#source-close").click();
            assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Ask about section");
        }
        if (data.sections.some((section) => section.ranges.some((range) => range.path.includes("cedar-point")))) {
            await page.locator("#review-search").fill("cedar-point");
            const filtered = page.locator(".section-card:not(.supporting-sections)").first();
            if (await filtered.count()) {
                if (!await filtered.evaluate((node) => node.open)) await filtered.locator(":scope > summary").click();
                await filtered.getByRole("button", { name: "Open first range", exact: true }).click();
                await page.waitForFunction(() => document.querySelector("#source-title")?.textContent.includes("cedar-point"));
                await page.locator("#source-close").click();
            }
            await page.locator("#review-search").fill("");
        }
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await sections.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `review-sections-${theme}.png`),
        });
        console.log(`PASS ${theme}: ${data.represented_files} changed files represented, range/section navigation, manual progress, pinned section chat, filters and narrow layout`);
        await page.close();
    }
} finally { await browser.close(); }
