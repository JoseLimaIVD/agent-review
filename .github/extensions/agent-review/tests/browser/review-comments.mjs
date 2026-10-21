import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { commentableLines } from "../../pr-review.mjs";

// Line comments: draft on a diff line by clicking its number or pressing C, edit, persist across reloads, delete.
// Drafts are never submitted here, so this is safe against a pull request target as well as a local one.
const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review.");
const draftsEndpoint = new URL("/api/pr-review/drafts", url);
const reviewEndpoint = new URL("/api/pr-review", url);
const progressEndpoint = new URL("/api/review-progress", url);
const originalProgress = await fetch(progressEndpoint).then((response) => response.json());
const before = await fetch(reviewEndpoint).then((response) => response.json());
const existing = new Set(before.drafts.comments.map((comment) => comment.id));
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const { model } = await fetch(new URL("/api/state", url)).then((response) => response.json());
const drafts = async () => (await fetch(reviewEndpoint).then((response) => response.json())).drafts.comments.filter((comment) => !existing.has(comment.id));

async function openReview(page, theme) {
    await page.goto(`${url}?scoutTheme=${theme}`);
    await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
    await page.locator("#overview-start").click();
    await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
        && document.querySelector("#source .code-row.diff-add, #source .code-row.diff-del"));
}

try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openReview(page, "light");
    assert.equal(await page.locator("#workspace-comment").isVisible(), true, "the Comment button is visible on desktop");
    assert.equal(await page.locator("#workspace-comment").isDisabled(), false, "a changed file can be commented on");

    // Clicking a changed line's number opens the editor for that line, focused; Escape cancels without saving.
    const added = page.locator("#source .code-row.diff-add").first();
    const side = await added.count() ? "RIGHT" : "LEFT";
    const row = side === "RIGHT" ? added : page.locator("#source .code-row.diff-del").first();
    const line = Number(await row.getAttribute(side === "RIGHT" ? "data-new-line" : "data-old-line"));
    await row.locator(".line-number").nth(side === "RIGHT" ? 1 : 0).click();
    const textarea = page.locator(".review-comment-editor textarea");
    await textarea.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches(".review-comment-editor textarea"));
    assert.match(await page.locator(".review-comment-target").textContent(), new RegExp(`:${line}\\b`));
    await textarea.fill("discard me");
    await textarea.press("Escape");
    assert.equal(await page.locator(".review-comment-editor").count(), 0, "Escape closes the editor");
    assert.deepEqual(await drafts(), [], "a cancelled comment is not saved");

    // C comments on the line being read; Ctrl+Enter saves a draft that the server stores with its anchor.
    await page.locator("#source").focus();
    await page.keyboard.press("c");
    await textarea.waitFor();
    await textarea.fill("Browser check: is this branch covered?");
    await textarea.press("Control+Enter");
    const draft = page.locator(".review-comment.review-comment-draft");
    await draft.waitFor();
    let saved = await drafts();
    assert.equal(saved.length, 1);
    assert.ok(saved[0].path && Number.isInteger(saved[0].line) && ["LEFT", "RIGHT"].includes(saved[0].side), "the draft keeps its anchor");
    assert.match(await draft.locator(".review-comment-kind").textContent(), /posts with your review|included in the handoff/);

    // Editing replaces the body in place.
    await draft.getByRole("button", { name: "Edit" }).click();
    await textarea.waitFor();
    assert.equal(await textarea.inputValue(), "Browser check: is this branch covered?");
    await textarea.fill("Browser check: edited.");
    await page.getByRole("button", { name: "Save comment" }).click();
    await page.locator(".review-comment-draft .review-comment-body", { hasText: "Browser check: edited." }).waitFor();
    saved = await drafts();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].body, "Browser check: edited.");

    // Drafts survive a reload and appear under the same line.
    await openReview(page, "dark");
    await page.locator(".review-comment-draft .review-comment-body", { hasText: "Browser check: edited." }).waitFor();

    // Typed text is never discarded implicitly: opening another line, deleting another draft or switching files keeps it.
    const here = saved[0].path;
    const source = await fetch(new URL(`/api/source?path=${encodeURIComponent(here)}`, url)).then((response) => response.json());
    // On a pull request GitHub's own patch, not the saved diff, decides which lines take comments.
    const githubLines = before.commentable?.[here];
    const diffLines = before.commentable ? { RIGHT: new Set(githubLines?.RIGHT || []), LEFT: new Set(githubLines?.LEFT || []) } : commentableLines(source.diff);
    const lineOf = (side, value) => page.locator(`#source .code-row[data-${side === "LEFT" ? "old" : "new"}-line="${value}"] > .line-number`).nth(side === "LEFT" ? 0 : 1);
    const otherLine = [...diffLines.RIGHT].find((value) => value !== saved[0].line) ?? null;
    await lineOf(saved[0].side, saved[0].line).click();
    const first = page.locator(`.review-comment-editor textarea`).first();
    await first.waitFor();
    await first.fill("Unsaved A");
    if (otherLine) {
        await lineOf("RIGHT", otherLine).click();
        await page.waitForFunction(() => document.querySelectorAll(".review-comment-editor").length === 2);
        const values = await page.locator(".review-comment-editor textarea").evaluateAll((nodes) => nodes.map((node) => node.value));
        assert.ok(values.includes("Unsaved A"), "opening a second editor keeps the first editor's text");
    }
    await page.locator(".review-comment-draft").first().getByRole("button", { name: /^Delete/ }).click();
    await page.waitForFunction(() => !document.querySelector(".review-comment-draft"));
    assert.ok((await page.locator(".review-comment-editor textarea").evaluateAll((nodes) => nodes.map((node) => node.value))).includes("Unsaved A"),
        "deleting another draft keeps unsaved text");
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#source")), true, "focus returns to the code after Delete");
    const otherFile = (model.changes || []).find((file) => file.status !== "unchanged" && file.path !== here)?.path;
    const openFile = async (path) => {
        await page.locator("#workspace-find").click();
        await page.locator("#review-command-query").fill(path);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.waitForFunction((path) => document.querySelector("#source-title")?.textContent?.startsWith(path)
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true", path);
    };
    if (otherFile) {
        await openFile(otherFile);
        await openFile(here);
        await page.locator(".review-comment-editor").first().waitFor();
        assert.ok((await page.locator(".review-comment-editor textarea").evaluateAll((nodes) => nodes.map((node) => node.value))).includes("Unsaved A"),
            "switching files and back keeps unsaved text");
    }
    while (await page.locator(".review-comment-editor").count()) await page.locator(".review-comment-editor").first().getByRole("button", { name: "Cancel" }).click();

    // Editing a draft that another tab deleted keeps the text and offers to add it as a new comment.
    await lineOf(saved[0].side, saved[0].line).click();
    await textarea.waitFor();
    await textarea.fill("Conflict draft");
    await textarea.press("Control+Enter");
    await page.locator(".review-comment-draft").waitFor();
    await page.locator(".review-comment-draft").getByRole("button", { name: /^Edit/ }).click();
    await textarea.waitFor();
    await textarea.fill("My careful edit");
    const [remote] = await drafts();
    const latest = (await fetch(reviewEndpoint).then((response) => response.json())).drafts;
    await fetch(draftsEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: latest.revision, action: "delete", id: remote.id }) });
    await page.getByRole("button", { name: "Save comment" }).click();
    await page.locator(".review-comment-editor .error:not(.hidden)", { hasText: "deleted in another tab" }).waitFor();
    assert.equal(await textarea.inputValue(), "My careful edit", "the edit survives the conflict");
    await page.getByRole("button", { name: "Add comment" }).click();
    await page.locator(".review-comment-draft .review-comment-body", { hasText: "My careful edit" }).waitFor();
    assert.deepEqual((await drafts()).map((comment) => comment.body), ["My careful edit"]);

    // A line outside the diff explains itself beside the line, not with the page-wide banner.
    const shown = await page.locator("#source .code-row[data-new-line]").evaluateAll((rows) => rows.map((row) => Number(row.dataset.newLine)));
    const outside = shown.find((value) => value && !diffLines.RIGHT.has(value)) || null;
    if (outside) {
        assert.equal(await lineOf("RIGHT", outside).evaluate((node) => node.classList.contains("commentable")), false, "no pointer on a line GitHub cannot anchor");
        await lineOf("RIGHT", outside).click();
        await page.locator(".review-comment-inline-note", { hasText: /is outside .*diff/ }).waitFor();
        assert.equal(await page.locator("#error").isVisible(), false);
    }
    assert.deepEqual(errors, []);
    await page.close();

    // On a phone-width screen the comment box stays inside the visible code area.
    const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await openReview(narrow, "light");
    const box = narrow.locator(".review-comment-draft").first();
    await box.waitFor();
    const fits = await box.evaluate((node) => node.getBoundingClientRect().right <= document.querySelector("#source").getBoundingClientRect().right + 1);
    assert.equal(fits, true, "the comment box fits the 390px code area");
    assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

    // Delete removes the draft from the page and the server.
    await box.getByRole("button", { name: "Delete" }).click();
    await narrow.waitForFunction(() => !document.querySelector(".review-comment-draft"));
    assert.deepEqual(await drafts(), []);
    await narrow.close();
    console.log(`PASS line comments on ${side === "RIGHT" ? "new" : "base"} line ${line}: open, cancel, C, save, edit, reload, unsaved text kept, deleted-elsewhere conflict, outside-diff note, 390px, delete`);
} finally {
    await browser.close();
    for (const comment of await drafts()) {
        const { drafts: current } = await fetch(reviewEndpoint).then((response) => response.json());
        await fetch(draftsEndpoint, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision: current.revision, action: "delete", id: comment.id }) });
    }
    const current = await fetch(progressEndpoint).then((response) => response.json());
    await fetch(progressEndpoint, { method: "POST", body: JSON.stringify({ snapshot: current.snapshot, revision: current.revision,
        entries: originalProgress.entries, cursor: originalProgress.cursor }) });
}
