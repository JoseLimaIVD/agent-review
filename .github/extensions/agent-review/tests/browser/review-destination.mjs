import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// The Overview and Finish primaries must always name the place they open, after any way of moving through the review.
const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review with several changed files and attention items.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const restore = async (entries = original.entries, cursor = original.cursor) => {
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await fetch(endpoint).then((response) => response.json());
        const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({
            snapshot: current.snapshot, revision: current.revision, entries, cursor }) });
        if (response.status === 409) continue;
        assert.equal(response.status, 200);
        return;
    }
    throw new Error("Unable to restore test review metadata.");
};
const sourceReady = (page) => page.waitForFunction(() => document.querySelector("#source-title")?.textContent
    && document.querySelector("#source")?.getAttribute("aria-busy") !== "true" && !document.querySelector("#source-panel").classList.contains("hidden"));
const openedPath = async (page) => (await page.locator("#source-title").textContent()).replace(/:\d+$/, "");

// Leave to Overview, check the label names the file just read, check Finish agrees, then follow the label.
async function assertDestination(page, step) {
    const expected = await openedPath(page);
    await page.locator("#workflow-overview").click();
    const label = await page.locator("#overview-start").textContent();
    assert.ok(label.includes(expected.split("/").at(-1)), `${step}: Overview label "${label}" names ${expected}`);
    await page.locator("#workflow-finish").click();
    const finish = await page.locator("#review-finish .review-next").first().textContent();
    assert.equal(finish.replace(/^Continue at /, ""), label.replace(/^(Continue|Start review) · /, ""), `${step}: Finish and Overview agree`);
    await page.locator("#workflow-overview").click();
    await page.locator("#overview-start").click();
    await sourceReady(page);
    assert.equal(await openedPath(page), expected, `${step}: the primary opens what it names`);
    assert.equal(await page.locator("#error").isVisible(), false, `${step}: resuming never errors`);
}

try {
    for (const theme of ["light", "dark"]) {
        await restore({}, null);
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
        await page.locator("#overview-start").click();
        await sourceReady(page);
        await assertDestination(page, "start");

        const files = page.locator("#workspace-nav-list .workspace-file");
        const current = await openedPath(page);
        const other = (await files.evaluateAll((items) => items.map((item) => item.dataset.path))).find((path) => path !== current);
        await page.locator(`#workspace-nav-list .workspace-file[data-path="${other}"]`).first().click();
        await page.waitForFunction((path) => document.querySelector("#source-title")?.textContent.startsWith(path)
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true", other);
        await assertDestination(page, "rail");

        await page.locator("#source").focus();
        const before = await openedPath(page);
        await page.keyboard.press("j");
        await page.waitForFunction((path) => !document.querySelector("#source-title")?.textContent.startsWith(path)
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true", before);
        await assertDestination(page, "J");

        await page.locator(".workspace-explore summary").click();
        await page.locator("#explore-priorities").click();
        const rows = page.locator("#graph .review-plan-row");
        if (await rows.count()) {
            await rows.last().click();
            await sourceReady(page);
            await assertDestination(page, "Attention");
        }

        // A source reference opened from AI text keeps the previous selection; the saved cursor must not mix the two.
        await page.locator("#workflow-overview").click();
        await page.locator("#review-background > summary").click();
        const reference = page.locator("#change-brief .brief-ai-section button.source-reference").first();
        if (await reference.count()) {
            await reference.click();
            await sourceReady(page);
            await assertDestination(page, "Focus point");
            await page.waitForTimeout(400);
            await page.reload();
            await page.waitForFunction(() => !document.querySelector("#overview-start").disabled && /·/.test(document.querySelector("#overview-start").textContent));
            await page.locator("#overview-start").click();
            await sourceReady(page);
            assert.equal(await page.locator("#error").isVisible(), false, "Continue after reload never errors");
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme}: Overview and Finish name the file they open after Start, rail, J, Attention and AI references`);
        await page.close();
    }
} finally {
    await browser.close();
    await restore();
}
