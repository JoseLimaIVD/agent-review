import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to the real large review.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
// Layer order opens foundations first, which may be short; seed the reading point on a long changed file instead.
const longFile = await (async () => {
    const { model } = await fetch(new URL("/api/state", url)).then((response) => response.json());
    for (const change of model.changes.filter((item) => item.status !== "unchanged" && item.status !== "deleted")) {
        const source = await fetch(new URL(`/api/source?path=${encodeURIComponent(change.path)}`, url)).then((response) => response.json());
        if (typeof source.current === "string" && source.current.split("\n").length >= 120) return change.path;
    }
    throw new Error("The large review needs a changed file with at least 120 lines.");
})();
const seed = { path: longFile, line: 1, side: "current", tab: "current", item_id: `file:${longFile}` };
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const restore = async (cursor = original.cursor) => {
    for (let attempt = 0; attempt < 3; attempt++) {
        const record = await fetch(endpoint).then((response) => response.json());
        const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({
            snapshot: record.snapshot, revision: record.revision, entries: original.entries, cursor,
        }) });
        if (response.status === 409) continue;
        assert.equal(response.status, 200);
        return;
    }
    throw new Error("Unable to restore cursor metadata after pending autosave writes.");
};
try {
    for (const theme of ["light", "dark"]) {
        await restore(seed);
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
        await page.locator("#overview-start").click();
        await page.waitForFunction((path) => document.querySelector("#source-title")?.textContent.startsWith(path)
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true", longFile);
        await page.locator(".tab[data-tab='current']").click();
        const row = page.locator('#source .code-row[data-new-line="100"]');
        await row.waitFor({ state: "attached" });
        const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/review-progress"
            && response.request().method() === "POST" && response.status() === 200
            && response.request().postDataJSON().cursor?.line === 100);
        await row.scrollIntoViewIfNeeded();
        await page.locator("#source").evaluate((source) => {
            const target = source.querySelector('[data-new-line="100"]');
            source.scrollTop += target.getBoundingClientRect().top - source.getBoundingClientRect().top;
        });
        assert.equal((await (await saved).json()).cursor.line, 100);
        await page.reload();
        await page.locator("#overview-start").click();
        await page.waitForFunction(() => document.querySelector("#source-title")?.textContent.endsWith(":100")
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true");
        await page.waitForFunction(() => {
            const source = document.querySelector("#source").getBoundingClientRect();
            const row = document.querySelector('#source .code-row[data-new-line="100"]').getBoundingClientRect();
            return row.top >= source.top && row.bottom <= source.bottom;
        });
        await page.waitForTimeout(1200);
        assert.equal((await fetch(endpoint).then((response) => response.json())).cursor.line, 100,
            "Final viewport layout must not autosave an earlier line over the restored reading point.");
        assert.equal(await page.locator(".tab[data-tab='current']").evaluate((button) => button.classList.contains("active")), true);
        await page.close();
        console.log(`PASS ${theme}: source scrolling is persisted and Continue restores the exact current-side line100`);
    }
} finally {
    await browser.close();
    await restore();
}
