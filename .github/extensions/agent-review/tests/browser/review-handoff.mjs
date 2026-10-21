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
const restore = async (entries = original.entries, cursor = original.cursor) => {
    for (let attempt = 0; attempt < 3; attempt++) {
        const record = await fetch(endpoint).then((response) => response.json());
        const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({
            snapshot: record.snapshot, revision: record.revision, entries, cursor,
        }) });
        if (response.status === 409) continue;
        assert.equal(response.status, 200);
        return;
    }
    throw new Error("Could not restore this test's progress metadata.");
};
const contents = async (download) => {
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
};
try {
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
        await restore({}, null);
        const page = await browser.newPage({ viewport: { width, height: 844 }, acceptDownloads: true });
        const errors = [];
        let submissions = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/review-handoff/submit") submissions++; });
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.locator("#overview-start").click();
        await page.locator("#file-review-note").fill("Handoff QA: inspect this saved boundary.");
        await page.locator("#file-review-disposition").selectOption("follow-up");
        const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/review-progress"
            && response.request().method() === "POST" && response.status() === 200);
        await page.locator("#file-review-save").click();
        await saved;
        await page.locator("#workflow-finish").click();
        await page.getByRole("button", { name: "Preview / export handoff", exact: true }).click();
        await page.locator("#handoff-markdown-save").waitFor();
        await page.waitForFunction(() => !document.querySelector("#handoff-markdown-save").disabled);
        assert.match(await page.locator("#handoff-markdown").inputValue(), /Handoff QA: inspect this saved boundary/);
        assert.equal(await page.locator("#handoff-confirm").isDisabled(), true, "local review never requires a PR");
        const markdownDownload = page.waitForEvent("download");
        await page.locator("#handoff-markdown-save").click();
        const markdown = await contents(await markdownDownload);
        assert.match(markdown, /No completed linked-test result|Repository linked-test results: /);
        assert.doesNotMatch(markdown, /127\.0\.0\.1/);
        const stateDownload = page.waitForEvent("download");
        await page.locator("#handoff-state-save").click();
        const artifact = JSON.parse(await contents(await stateDownload));
        assert.equal(artifact.kind, "agent-review-handoff");
        assert.equal(Object.hasOwn(artifact, "source_files"), false);
        assert.equal(Object.hasOwn(artifact, "discussions"), false);
        const choose = (value) => page.locator("#handoff-import-file").setInputFiles({
            name: "decisions.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)),
        });
        await choose({ ...artifact, identity: "different-snapshot" });
        await page.locator("#handoff-import-error").getByText(/does not match the loaded saved source/).waitFor();
        assert.equal(await page.locator("#handoff-import-confirm").isDisabled(), true);
        const before = await fetch(endpoint).then((response) => response.json());
        await choose(artifact);
        await page.locator("#handoff-import-preview").getByText(/nothing would change/).waitFor();
        assert.equal(await page.locator("#handoff-import-confirm").isDisabled(), true, "re-importing identical decisions offers nothing to confirm");
        const other = artifact.scope.find((file) => !Object.hasOwn(artifact.entries, `review-file:${file.path}`));
        const addition = structuredClone(artifact);
        addition.entries[`review-file:${other.path}`] = { disposition: "reviewed", note: "", path: other.path, line: 1, updated_at: new Date().toISOString() };
        await choose(addition);
        await page.locator("#handoff-import-preview").getByText(/1 decision would change/).waitFor();
        await page.waitForFunction(() => !document.querySelector("#handoff-import-confirm").disabled);
        assert.equal((await fetch(endpoint).then((response) => response.json())).revision, before.revision, "preview does not import");
        await page.locator("#handoff-import-confirm").click();
        await page.locator("#handoff-import-preview").getByText(/1 decision imported and saved/).waitFor();
        const conflict = structuredClone(artifact);
        Object.values(conflict.entries)[0].note = "Conflicting note";
        await choose(conflict);
        await page.locator("#handoff-import-error").getByText(/conflicts with an existing decision/).waitFor();
        assert.doesNotMatch(await page.locator("#handoff-import-preview").textContent(), /Exact saved source matches|imported and saved/);
        assert.ok(await page.locator("#handoff-import-error").evaluate((error) => {
            const box = error.getBoundingClientRect(), dialog = document.querySelector("#review-handoff").getBoundingClientRect();
            return box.top >= dialog.top && box.bottom <= dialog.bottom;
        }), "Current import failure must be visible beside its controls, not offscreen");
        assert.equal(await page.locator("#handoff-import-confirm").isDisabled(), true);
        await page.route("**/api/review-handoff/preview", (route) => route.fulfill({
            status: 503, contentType: "application/json", body: '{"error":"Deliberate preview transport failure"}',
        }));
        await page.locator("#handoff-refresh").click();
        await page.locator("#handoff-error").getByText(/Deliberate preview transport failure/).waitFor();
        assert.equal(await page.locator("#handoff-markdown-save").isDisabled(), true);
        await page.unroute("**/api/review-handoff/preview");
        await page.locator("#handoff-refresh").click();
        await page.waitForFunction(() => !document.querySelector("#handoff-markdown-save").disabled);
        await page.locator("#handoff-markdown").focus();
        await page.keyboard.press("Tab");
        assert.equal(await page.locator("#handoff-markdown-save").evaluate((button) => document.activeElement === button), true);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
            await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
            await page.locator("#review-handoff").evaluate((dialog) => { dialog.scrollTop = 0; });
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `handoff-${theme}-${width}.png`) });
        }
        assert.ok(await page.locator("#review-handoff").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1));
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#review-handoff").isVisible(), false);
        assert.equal(submissions, 0, "export/import must never publish remotely");
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`PASS ${theme}/${width}: real saved decisions, exact preview/downloads, explicit import, mismatch/conflict/failure, keyboard and no publishing`);
    }
} finally { await browser.close(); await restore(); }
