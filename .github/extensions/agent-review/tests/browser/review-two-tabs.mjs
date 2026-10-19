import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileReviewId } from "../../web/review-ledger.mjs";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review with several changed files.");
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
        const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ snapshot: current.snapshot, revision: current.revision, entries, cursor }) });
        if (response.status !== 409) return assert.equal(response.status, 200);
    }
    throw new Error("Unable to restore test review metadata.");
};
const ready = (page) => page.waitForFunction(() => document.querySelector("#source .code-row")
    && !document.querySelector("#file-review-next")?.disabled);

try {
    await restore({}, null);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const first = await context.newPage();
    const second = await context.newPage();
    const errors = [];
    for (const page of [first, second]) page.on("pageerror", (error) => errors.push(error.message));
    await first.goto(url);
    await first.locator("#overview-start").click();
    await ready(first);
    const path = await first.locator(".workspace-file[aria-current='location']").first().getAttribute("data-path");
    await second.goto(url);
    await second.locator("#overview-start").click();
    await ready(second);
    await second.locator(".workspace-file").nth(3).click();
    await second.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true");
    await second.waitForTimeout(1200);
    const moved = await fetch(endpoint).then((response) => response.json());
    assert.ok(moved.revision > 0, "the second tab saved its reading position");
    await first.locator("#file-review-note").fill("Saved after another tab moved.");
    await first.locator("#file-review-disposition").selectOption("follow-up");
    await first.locator("#file-review-save").click();
    await first.waitForFunction(() => !document.querySelector("#file-review-save").disabled);
    const saved = await fetch(endpoint).then((response) => response.json());
    assert.equal(saved.entries[fileReviewId(path)]?.disposition, "follow-up", "a reading-position change in another tab does not block a decision");
    assert.equal(saved.entries[fileReviewId(path)]?.note, "Saved after another tab moved.");
    assert.equal(await first.locator("#file-review-status").textContent().then((text) => /changed elsewhere/i.test(text || "")), false);
    // A real conflict on the same file is still reported, never overwritten.
    await second.reload();
    await second.locator("#overview-start").click();
    await ready(second);
    await second.locator(`.workspace-file[data-path="${path}"]`).first().click();
    await second.waitForFunction((value) => document.querySelector("#file-review-disposition")?.value === value, "follow-up");
    await first.locator("#file-review-disposition").selectOption("reviewed");
    await first.locator("#file-review-save").click();
    await first.waitForFunction(() => !document.querySelector("#file-review-save").disabled);
    await second.locator("#file-review-disposition").selectOption("pending");
    await second.locator("#file-review-note").fill("");
    await second.locator("#file-review-save").click();
    await second.locator("#file-review-status").getByText(/changed elsewhere/i).waitFor();
    const kept = await fetch(endpoint).then((response) => response.json());
    assert.equal(kept.entries[fileReviewId(path)]?.disposition, "reviewed", "a competing decision on the same file is not overwritten");
    assert.deepEqual(errors, []);
    console.log("PASS: another tab's reading position no longer blocks saves; same-file conflicts are still reported");
    await context.close();
} finally {
    await browser.close();
    await restore();
}
