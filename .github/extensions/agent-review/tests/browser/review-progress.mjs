import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileReviewId } from "../../web/review-ledger.mjs";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to the real two-file Python review.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const restore = async (entries = original.entries, cursor = original.cursor) => {
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = await fetch(endpoint).then((response) => response.json());
        const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({
            snapshot: current.snapshot, revision: current.revision, entries, cursor,
        }) });
        if (response.status === 409) continue;
        assert.equal(response.status, 200, "restore only this test's review metadata");
        return;
    }
    throw new Error("Unable to restore test review metadata after pending cursor writes.");
};
try {
    await restore({}, null);
    for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.locator("#overview-start").click();
        await page.locator("#file-review-next").waitFor();
        await page.locator("#file-review-disposition").selectOption("follow-up");
        await page.locator("#file-review-note").fill("Check this boundary before handoff.");
        const first = await page.locator("#source-title").textContent();
        const path = first.replace(/:\d+$/, "");
        await page.route("**/api/review-progress", (route) => route.request().method() === "POST"
            ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Deliberate progress-save failure"}' })
            : route.continue());
        await page.locator("#file-review-next").click();
        await page.locator("#file-review-status").getByText(/Deliberate progress-save failure/).waitFor();
        assert.equal(await page.locator("#source-title").textContent(), first);
        assert.equal(await page.locator("#file-review-note").inputValue(), "Check this boundary before handoff.");
        let saved = await fetch(endpoint).then((response) => response.json());
        assert.notEqual(saved.entries[fileReviewId(path)]?.disposition, "follow-up", "failed save must not produce progress");
        await page.unroute("**/api/review-progress");
        await page.locator("#file-review-retry").click();
        await page.waitForFunction(() => !document.querySelector("#file-review-next").disabled);
        await page.locator("#file-review-next").click();
        await page.waitForFunction((title) => document.querySelector("#source-title")?.textContent !== title
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true", first);
        saved = await fetch(endpoint).then((response) => response.json());
        assert.equal(saved.entries[fileReviewId(path)].disposition, "follow-up");
        assert.equal(saved.entries[fileReviewId(path)].note, "Check this boundary before handoff.");
        await page.locator("#file-review-next").click();
        await page.locator("#workflow-finish").click();
        await page.locator("#review-finish").getByText("Review has remaining work", { exact: true }).waitFor();
        assert.match(await page.locator("#review-finish").textContent(), /1 reviewed.*1 need follow-up|1 of 2 changed files reviewed/);
        await page.locator("#review-finish").getByRole("button", { name: /^Continue at / }).click();
        await page.waitForFunction(() => document.querySelector("#file-review-disposition")?.value === "follow-up");
        await page.locator("#file-review-disposition").selectOption("reviewed");
        await page.locator("#file-review-next").click();
        await page.locator("#review-finish").getByText("Changed files marked reviewed", { exact: true }).waitFor();
        assert.match(await page.locator("#review-finish").textContent(), /do not prove correctness/);
        await context.close();
        const clean = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const resumed = await clean.newPage();
        await resumed.goto(`${url}?scoutTheme=${theme}`);
        await resumed.waitForFunction(() => document.querySelector("#overview-start")?.textContent === "Review summary"
            && !document.querySelector("#overview-start").disabled);
        assert.match(await resumed.locator("#overview-progress").textContent(), /2 of 2 changed files reviewed/);
        await resumed.locator("#overview-start").click();
        await resumed.locator("#review-finish").waitFor();
        assert.match(await resumed.locator("#review-finish").textContent(), /Check this boundary before handoff/);
        assert.deepEqual(errors, []);
        await clean.close();
        await restore({}, null);
        console.log(`PASS ${theme}: save failure retains draft/no advance; follow-up, save-next, Finish and clean-browser durable resume`);
    }
} finally { await browser.close(); await restore(); }
