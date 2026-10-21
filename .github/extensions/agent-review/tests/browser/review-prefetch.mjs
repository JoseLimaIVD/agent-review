import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// Copilot explanations are prefetched one step ahead: the first reading-path item while the Overview summary shows,
// and the next item while the reader is on the current one. Summary and annotation requests are answered in the page,
// so no model call is made. Point it at a review without saved explanations (for example the PR sandbox host).
const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review.");
const progressEndpoint = new URL("/api/review-progress", url);
const original = await fetch(progressEndpoint).then((response) => response.json());
// Start with nothing reviewed so there is always a next item; the original progress is restored at the end.
await fetch(progressEndpoint, { method: "POST", body: JSON.stringify({ snapshot: original.snapshot, revision: original.revision, entries: {}, cursor: null }) });
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requested = [];
    await page.route("**/api/annotation", async (route) => {
        const { id } = JSON.parse(route.request().postData() || "{}");
        requested.push(id);
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ annotation: {
            id: `annotation:${id}`, item_id: id, body: `## What this code is\n\nPrefetch check for ${id}.`, evidence_ids: [], prompt_version: 2 } }) });
    });
    await page.route("**/api/overview", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ annotation: {
        id: "annotation:overview", item_id: "overview", body: "## Summary\n\nPrefetch check summary.", evidence_ids: [], basis: "saved-code" } }) }));
    await page.goto(`${url}?scoutTheme=light`);
    await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
    await page.waitForFunction(() => /Prefetch check summary|./.test(document.querySelector("#overview-description")?.textContent || ""));
    await page.waitForTimeout(1500);
    assert.ok(requested.length <= 1, `the Overview prefetches at most the first item once the summary shows (requested ${requested.join(", ")})`);
    const first = requested[0];
    await page.locator("#overview-start").click();
    await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true" && document.querySelector("#source .code-row"));
    await page.waitForFunction(() => document.querySelector("#source-annotation .annotation-body, #source-annotation")?.textContent.trim().length > 40, null, { timeout: 10_000 });
    if (first) assert.equal(requested.filter((id) => id === first).length, 1, "opening the first item reuses its prefetched explanation");
    for (let waited = 0; waited < 10_000 && !requested.some((id) => id !== first); waited += 250) await page.waitForTimeout(250);
    // The next item is prefetched now, unless an earlier review already saved its explanation.
    const next = requested.find((id) => id !== first) || null;
    const before = requested.length;
    await page.locator("#file-review-next").click();
    await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true");
    if (next) await page.waitForFunction((id) => document.querySelector("#source-annotation")?.textContent.includes(`Prefetch check for ${id}`), next, { timeout: 10_000 });
    else await page.waitForFunction(() => document.querySelector("#source-annotation")?.textContent.trim().length > 40, null, { timeout: 10_000 });
    await page.waitForTimeout(500);
    assert.deepEqual(requested.slice(before), [], `opening the next item needs no new request (requested afterwards: ${requested.slice(before).join(", ")})`);
    assert.deepEqual(errors, []);
    console.log(`PASS prefetch: overview → ${first || "(already saved)"}, then ${next || "(already saved)"}; ${requested.length} requests in total`);
} finally {
    await browser.close();
    const current = await fetch(progressEndpoint).then((response) => response.json());
    await fetch(progressEndpoint, { method: "POST", body: JSON.stringify({ snapshot: current.snapshot, revision: current.revision,
        entries: original.entries, cursor: original.cursor }) });
}



