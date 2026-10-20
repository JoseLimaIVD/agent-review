import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// Split diff pairs edits side by side without changing what a line is: every line stays one .code-row, so
// selection, line links, citations and coverage keep working; narrow windows always read unified.
const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review with modified files.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const ready = (page) => page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
    && document.querySelector("#source .code-row"));
try {
    for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
        await page.locator("#overview-start").click();
        await ready(page);
        await page.locator(".tab[data-tab='diff']").click();
        await ready(page);
        const unified = await page.locator("#source .code-row[data-new-line], #source .code-row[data-old-line]").evaluateAll((rows) =>
            rows.map((row) => `${row.dataset.oldLine || ""}:${row.dataset.newLine || ""}`).sort());
        await page.locator("#diff-layout button[data-layout='split']").click();
        await page.waitForFunction(() => document.querySelector("#source .code-lines.split-diff"));
        await ready(page);
        const split = await page.locator("#source .code-row[data-new-line], #source .code-row[data-old-line]").evaluateAll((rows) =>
            rows.map((row) => `${row.dataset.oldLine || ""}:${row.dataset.newLine || ""}`).sort());
        assert.deepEqual(split, unified, "split shows exactly the same numbered lines as unified");
        const pairs = await page.locator("#source .split-pair").evaluateAll((items) => items.map((pair) => {
            const [left, right] = pair.children;
            return { left: left.className, right: right.className,
                aligned: Math.abs(left.getBoundingClientRect().top - right.getBoundingClientRect().top) < 1 };
        }));
        assert.ok(pairs.length, "modified files show paired rows");
        for (const pair of pairs) {
            assert.match(pair.left, /diff-delete|split-filler/, "base side is on the left");
            assert.match(pair.right, /diff-add|split-filler/, "current side is on the right");
            assert.ok(pair.aligned, "paired sides share a row");
        }
        if (await page.locator("#source .code-row.diff-delete").count() && await page.locator("#source .code-row.diff-add").count()) {
            assert.ok(pairs.some((pair) => /diff-delete/.test(pair.left) && /diff-add/.test(pair.right)), "a modified line pairs base with current");
        }
        const mirrored = await page.locator("#source .code-row.diff-context").evaluateAll((rows) =>
            rows.every((row) => row.dataset.mirror === row.querySelector("code").textContent));
        assert.equal(mirrored, true, "unchanged context shows the same text on both sides");
        assert.equal(await page.locator("#source .code-row.diff-delete[class*='coverage-']").count(), 0, "coverage marks only the current side");
        assert.equal(await page.evaluate(() => { const source = document.querySelector("#source"); return source.scrollWidth <= source.clientWidth + 1; }), true,
            "split lines wrap inside their half instead of scrolling");
        // Line-anchored navigation still lands on the exact current-side line.
        const target = await page.locator("#source .split-pair .code-row.diff-add").first().getAttribute("data-new-line");
        await page.locator("#source-location").click();
        await page.reload();
        await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
        await page.locator("#overview-start").click();
        await ready(page);
        await page.locator(".tab[data-tab='diff']").click();
        await ready(page);
        assert.equal(await page.locator("#source .code-lines.split-diff").count(), 1, "the split choice is remembered");
        assert.equal(await page.locator(`#source .code-row.diff-add[data-new-line="${target}"]`).count(), 1);
        await page.locator("#source").focus();
        await page.keyboard.press("u");
        await page.waitForFunction(() => !document.querySelector("#source .code-lines.split-diff"));
        await page.keyboard.press("u");
        await page.waitForFunction(() => document.querySelector("#source .code-lines.split-diff"));
        await page.setViewportSize({ width: 1000, height: 900 });
        await page.waitForFunction(() => !document.querySelector("#source .code-lines.split-diff"));
        assert.equal(await page.locator("#diff-layout").isVisible(), false, "narrow windows offer only unified");
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme}: split pairs ${pairs.length} rows, keeps every line, remembers the choice, U toggles, unified below 1100px`);
        await context.close();
    }
} finally {
    await browser.close();
    const current = await fetch(endpoint).then((response) => response.json());
    await fetch(endpoint, { method: "POST", body: JSON.stringify({ snapshot: current.snapshot, revision: current.revision,
        entries: original.entries, cursor: original.cursor }) });
}
