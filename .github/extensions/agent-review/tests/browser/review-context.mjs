import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual saved review.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
try {
    for (const theme of ["light", "dark"]) {
        for (const width of [1280, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 844 } });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${url}?scoutTheme=${theme}`);
            await page.locator("#overview-start").click();
            await page.locator("#source .code-row").first().waitFor({ state: "attached" });
            await page.locator("#source").evaluate((source) => { window.contextSourceRows = source.firstElementChild; });
            const sourceScroll = await page.locator("#source").evaluate((source) => {
                source.scrollTop = Math.min(280, source.scrollHeight - source.clientHeight);
                return source.scrollTop;
            });
            if (await page.locator("#workspace-context").isVisible()) await page.locator("#workspace-context").click();
            const context = page.locator("#source-review-context");
            await context.getByRole("heading", { name: "Who might be affected?", exact: true }).waitFor();
            assert.match(await context.textContent(), /What was verified\?.*What remains open\?/s);
            assert.match(await context.textContent(), /No linked-test run|Repository linked-test run/);
            assert.equal(await page.locator("#source-origin").evaluate((details) => details.open), false);
            await context.getByRole("button", { name: "Inspect impact", exact: true }).click();
            await page.locator("#workspace-return-source").click();
            await page.locator("#source").waitFor();
            await page.waitForFunction(() => document.activeElement === document.querySelector("#source"));
            assert.equal(await page.locator("#source").evaluate((source) => document.activeElement === source), true);
            assert.equal(await page.locator("#source").evaluate((source) => source.scrollTop), sourceScroll);
            if (await page.locator("#workspace-context").isVisible()) await page.locator("#workspace-context").click();
            await context.evaluate((panel) => { panel.parentElement.scrollTop = panel.parentElement.scrollHeight; });
            const tabs = await page.locator(".discussion-tabs").boundingBox();
            const side = await page.locator(".source-side").boundingBox();
            assert.ok(tabs.y >= side.y && tabs.y + tabs.height <= side.y + side.height, "Discussion controls remain in view");
            await page.locator("#workspace-discuss").focus();
            await page.keyboard.press("Enter");
            const question = page.locator("#item-question");
            await question.waitFor();
            await question.fill("Keep this question pinned to the current saved item.");
            await page.locator("#show-evidence").click();
            await page.locator("#workspace-discuss").click();
            assert.equal(await question.inputValue(), "Keep this question pinned to the current saved item.");
            await page.locator("#show-evidence").click();
            if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
                await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
                await page.locator(".source-side").evaluate((panel) => { panel.scrollTop = 0; });
                await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `context-${theme}-${width}.png`) });
            }
            await page.locator("#source-focus").click();
            assert.equal(await page.locator("#file-review-next").isVisible(), true, "focus mode keeps Mark & next");
            assert.equal(await page.locator("#file-review-note").isVisible(), false, "focus mode hides the rest of the decision bar");
            assert.equal(await page.locator(".source-side").isVisible(), false);
            assert.equal(await page.locator("#source").evaluate((source) => source.firstElementChild === window.contextSourceRows), true);
            assert.deepEqual(errors, []);
            await page.close();
            console.log(`PASS ${theme}/${width}: honest context, sticky discussion, keyboard Ask, pinned draft, cached focused source`);
        }
    }
} finally {
    await browser.close();
    const record = await fetch(endpoint).then((response) => response.json());
    const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({
        snapshot: record.snapshot, revision: record.revision, entries: original.entries, cursor: original.cursor,
    }) });
    assert.equal(response.status, 200, "Restore the actual review's original metadata.");
}
