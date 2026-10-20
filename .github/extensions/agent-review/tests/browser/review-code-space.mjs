import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// Reading space is a product requirement: chrome above and below the code must not crowd it out.
const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
const { review_target: target } = await fetch(new URL("/api/state", url)).then((response) => response.json());
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const minimum = { 1280: target?.mode === "worktree" ? 500 : 600, 390: 300 };
try {
    for (const [width, height, theme] of [[1280, 800, "light"], [1280, 800, "dark"], [390, 844, "light"]]) {
        const page = await browser.newPage({ viewport: { width, height } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
        await page.locator("#overview-start").click();
        await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
            && document.querySelector("#source .code-row"));
        const code = await page.locator("#source").evaluate((source) => source.getBoundingClientRect().height);
        assert.ok(code >= minimum[width], `${theme} ${width}px: code area ${Math.round(code)}px is below ${minimum[width]}px`);
        const strip = page.locator("#source-strip");
        if (await strip.isVisible()) {
            const toggle = page.locator("#source-strip-toggle");
            if (width >= 1100) assert.ok((await toggle.boundingBox()).height <= 36, "the selection strip is one line on desktop");
            await toggle.click();
            assert.equal(await page.locator("#source-strip-body").isVisible(), true, "details are one click away");
            await toggle.click();
        }
        assert.equal(await page.locator("#worktree-notice").isVisible(), false, "no freshness banner over the code unless opened");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme} ${width}px: ${Math.round(code)}px of code (minimum ${minimum[width]})`);
        await page.close();
    }
} finally {
    await browser.close();
    const current = await fetch(endpoint).then((response) => response.json());
    await fetch(endpoint, { method: "POST", body: JSON.stringify({ snapshot: current.snapshot, revision: current.revision,
        entries: original.entries, cursor: original.cursor }) });
}
