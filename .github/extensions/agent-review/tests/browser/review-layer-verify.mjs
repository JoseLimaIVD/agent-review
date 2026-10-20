import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// Per-layer Verify: the reader runs the current layer's linked tests beside the code and sees outcomes on the rail,
// in the gutter, on Finish and in the handoff. Executes the reviewed repository's tests; point it at a demo review.
const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review.");
const progressEndpoint = new URL("/api/review-progress", url);
const originalProgress = await fetch(progressEndpoint).then((response) => response.json());
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });

try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?scoutTheme=light`);
    await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
    await page.locator("#overview-start").click();
    await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true" && document.querySelector("#source .code-row"));
    const block = page.locator(".layer-verify");
    await block.waitFor({ timeout: 30_000 });
    const run = block.locator(".layer-verify-run");
    if (!await run.count()) {
        console.log(`SKIP no linked tests for the first layer: ${await block.innerText()}`);
        process.exit(0);
    }
    await page.waitForFunction(() => !document.querySelector(".layer-verify-run")?.disabled, null, { timeout: 30_000 });
    const linked = Number(/(\d+) linked tests?/.exec(await block.innerText())?.[1] || /Rerun/.test(await run.innerText()) && -1);
    await run.click();
    await page.locator(".workspace-layer-tests .layer-tests-running").waitFor({ timeout: 10_000 }).catch(() => {});
    await page.waitForFunction(() => /passed|failed|error/.test(document.querySelector(".layer-verify-status")?.textContent || "")
        && !/running/i.test(document.querySelector(".layer-verify-status")?.textContent || ""), null, { timeout: 240_000 });
    const status = await block.locator(".layer-verify-status").innerText();
    const chips = await page.locator(".workspace-layer-tests .layer-tests").allInnerTexts();
    const chip = chips.find((text) => /passed|failing|tested/.test(text));
    assert.ok(chip, `the rail shows the run layer's outcome (chips: ${chips.join(", ")})`);
    assert.match(await run.innerText(), /Rerun/);
    const traced = await page.locator("#source .line-number[data-trace]").count();
    if (traced) assert.equal(await block.locator(".trace-legend").count(), 1, "trace marks come with a legend");
    // Finish lists the same outcome per layer, and the handoff records the run.
    await page.locator("button:has-text('Finish')").first().click();
    await page.locator(".finish-layers .layer-tests").first().waitFor();
    const preview = await fetch(new URL("/api/review-handoff/preview", url), { method: "POST", body: "{}" }).then((response) => response.json());
    assert.match(preview.markdown, /Linked tests: \d+ (passed|failed)/);
    assert.match(preview.markdown, /Test runs in this review[\s\S]*Layer \d+\./);
    assert.deepEqual(errors, []);
    console.log(`PASS layer verify: ${status} · rail "${chip}" · ${traced} traced lines · ${linked > 0 ? `${linked} linked` : "rerun"}`);
} finally {
    await browser.close();
    const current = await fetch(progressEndpoint).then((response) => response.json());
    await fetch(progressEndpoint, { method: "POST", body: JSON.stringify({ snapshot: current.snapshot, revision: current.revision,
        entries: originalProgress.entries, cursor: originalProgress.cursor }) });
}
