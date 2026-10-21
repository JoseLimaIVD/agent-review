import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewHandoff, handoffIdentity, submitGitHubHandoff, validateHandoffImport } from "../review-handoff.mjs";
import { ReviewState } from "../review-state.mjs";

const head = "a".repeat(40), base = "b".repeat(40);
const modelFor = (root = "C:\\source\\sample") => ({
    metadata: { repo_root: root, head_sha: head, base_sha: base },
    changes: [{ path: "a.js", status: "modified", lines_added: 1, lines_removed: 1 }],
    nodes: [], edges: [], evidence: {}, attention: [{ title: "Priority, not proof" }], warnings: [],
    source_files: { "a.js": { current: "secret_new_body\nline2\n", baseline: "secret_old_body\n", diff: "secret_diff" } },
    coverage: { available: true },
});
const target = { mode: "commit", label: "Commit aaaaaaa", currentRef: head, baseRef: base };
const entry = { disposition: "follow-up", note: "Check <script> and [links](https://example.invalid).", path: "a.js", line: 2 };
const progress = { entries: { "review-file:a.js": entry }, cursor: { path: "a.js", line: 2, side: "current", tab: "current", item_id: "file:a.js" } };
const offline = async () => { throw new Error("offline test"); };

test("handoff defaults contain decisions and evidence limits, never source, transcripts, origin prompts or loopback links", () => {
    const result = createReviewHandoff(modelFor(), target, progress, {
        testRun: { status: "complete", stale: true, counts: { passed: 6, failed: 1, error: 2 } },
    });
    const output = JSON.stringify(result);
    assert.doesNotMatch(output, /secret_new_body|secret_old_body|secret_diff|127\.0\.0\.1|C:\\\\source/);
    assert.equal(result.artifact.repository, "sample");
    assert.deepEqual(result.artifact.entries, progress.entries);
    assert.deepEqual(result.artifact.scope, [{ path: "a.js", status: "modified" }]);
    assert.match(result.markdown, /6 passed, 1 failed, 2 error.*STALE/);
    assert.match(result.markdown, /outcomes are not per-path proof/);
    assert.match(result.markdown, /0\/1 changed files marked reviewed; 0 not reviewed; 1 need follow-up/);
    assert.doesNotMatch(result.markdown, /<script>/);
    assert.match(result.markdown, /not a self-contained source archive/);
    assert.throws(() => validateHandoffImport({ ...result.artifact, entries: undefined }, modelFor(), target), /must be an object/);
});

test("handoff lists every remaining file and the open concerns grouped the same way as Finish", () => {
    const paths = Array.from({ length: 20 }, (_, index) => `src/file-${String(index).padStart(2, "0")}.js`);
    const model = { ...modelFor(), changes: paths.map((path) => ({ path, status: "modified" })),
        nodes: [{ id: "n1", name: "parse", path: "src/file-03.js", start_line: 12 }],
        attention: [
            { id: "a1", node_id: "n1", type: "complexity", title: "Complexity increased", impact_score: 84 },
            { id: "a2", node_id: "n1", type: "callers", title: "Broad caller impact", impact_score: 100 },
            { id: "a3", type: "package", title: "Package dependency added", impact_score: 40 },
        ] };
    const { markdown } = createReviewHandoff(model, target, { entries: {}, cursor: null });
    assert.match(markdown, /<details><summary>20 files not yet reviewed<\/summary>/);
    for (const path of paths) assert.ok(markdown.includes(path), `${path} is listed`);
    assert.match(markdown, /## Open review priorities\n2 open concerns, highest static priority first/);
    assert.match(markdown, /Broad caller impact · `` src\/file-03\.js:12 ``|Broad caller impact · ` src\/file-03\.js:12 `/);
    assert.match(markdown, /static priority 100\/100/);
    assert.match(markdown, /- 2 saved review concerns \(2 open\), not confirmed defects/);
});

test("handoff priorities use the shared static priority and leave set-aside triage out of open priorities", () => {
    const model = { ...modelFor(), changes: [{ path: "src/a.js", status: "modified" }],
        nodes: [{ id: "n1", name: "parse", path: "src/a.js", start_line: 3 }, { id: "n2", name: "emit", path: "src/a.js", start_line: 9 }],
        attention: [
            { id: "a1", node_id: "n1", type: "callers", title: "Broad caller impact", impact_score: 84 },
            { id: "a2", node_id: "n2", type: "complexity", title: "Complexity increased", impact_score: 70 },
        ] };
    const priority = (concern) => ({ a1: 100, a2: 71 })[concern.id];
    const entries = { "review:n2": { disposition: "accepted", note: "Intentional", path: "src/a.js" } };
    const { markdown } = createReviewHandoff(model, target, { entries, cursor: null }, { priority });
    assert.match(markdown, /1 open concern, highest static priority first; 1 set aside by triage/);
    assert.match(markdown, /Broad caller impact · ` src\/a\.js:3 ` · static priority 100\/100/, "the shared priority, not the raw impact score");
    assert.doesNotMatch(markdown, /Complexity increased/, "an accepted risk is not an open priority");
    assert.match(markdown, /## Concern triage\n.*\n- emit in ` src\/a\.js `: Accepted risk — Intentional/);
    assert.match(markdown, /JSON contains only file decisions|No source bodies, per-item AI explanations|Neither includes source bodies, per-item AI explanations/);
});

test("handoff reads by layer and collapses identical concerns into one line naming their subjects", () => {
    const model = { ...modelFor(), changes: ["src/a.js", "src/b.js", "README.md"].map((path) => ({ path, status: "modified" })),
        attention: ["left-pad", "lodash", "picocolors"].map((name, index) => ({ id: `p${index}`, type: "package",
            title: "Package dependency added", package_id: `package:npm:${name}`, impact_score: 74 })) };
    const layers = [{ number: 1, name: "Utilities", intent: "Trims formatted values", files: ["src/a.js", "src/b.js"] },
        { number: null, name: "Supporting files", summary: "1 file without a source relationship to the layers above", files: ["README.md"] }];
    const { markdown } = createReviewHandoff(model, target, { entries: { "review-file:src/a.js": { disposition: "reviewed", path: "src/a.js" } }, cursor: null }, { layers });
    assert.match(markdown, /## Review by layer\n\n### 1\. Utilities — 1\/2 reviewed\nAI summary \(verify in code\): Trims formatted values\n- Not reviewed · ` src\/b\.js `/);
    assert.match(markdown, /### Supporting files — 0\/1 reviewed/);
    assert.doesNotMatch(markdown, /## Remaining files/);
    assert.match(markdown, /- Package dependency added ×3: ` left-pad `, ` lodash `, ` picocolors ` · static priority 74\/100/);
    assert.match(markdown, /AI-written layer titles and one-line layer summaries \(each marked\)/, "the sharing disclosure names the AI text it includes");
    assert.equal(markdown.match(/Package dependency added/g).length, 1);
});

test("portable identity ignores local clone paths but never accepts different saved content or unavailable binary worktrees", () => {
    const one = modelFor(), two = modelFor("D:\\another\\clone");
    assert.equal(handoffIdentity(one, target), handoffIdentity(two, target));
    const artifact = createReviewHandoff(one, target, progress).artifact;
    assert.equal(validateHandoffImport(artifact, two, target).size, 1);
    two.source_files["a.js"].current += "newer content";
    assert.throws(() => validateHandoffImport(artifact, two, target), /does not match/);
    const binary = modelFor();
    binary.source_files["a.js"] = { binary: true };
    const worktree = { mode: "worktree" };
    const blocked = createReviewHandoff(binary, worktree, { entries: {}, cursor: null });
    assert.equal(blocked.artifact.importable, false);
    assert.throws(() => validateHandoffImport(blocked.artifact, binary, worktree), /Cannot establish exact worktree content/);
});

test("imports preview without mutation, retain current position, reject conflicting decisions and validate record scope", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "review-handoff-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const state = new ReviewState(root, { workspacePath: root, runAnalyzer: async () => modelFor(root) });
    state.model = modelFor(root);
    state.reviewTarget = target;
    const artifact = createReviewHandoff(state.model, target, progress).artifact;
    const preview = await state.importHandoff({ artifact, revision: 0 });
    assert.equal(preview.records, 1);
    assert.equal(preview.changes, 1);
    assert.equal((await state.progressForReview()).revision, 0);
    const saved = await state.importHandoff({ artifact, revision: 0, confirm: true });
    assert.equal(saved.entries["review-file:a.js"].note, entry.note);
    assert.equal(saved.changes, 1);
    assert.equal(saved.cursor.line, 2);
    const again = await state.importHandoff({ artifact, revision: 1, confirm: true });
    assert.equal(again.unchanged, true, "re-importing identical decisions changes nothing");
    assert.equal((await state.progressForReview()).revision, 1, "an unchanged import does not bump the saved revision");
    const conflict = structuredClone(artifact);
    conflict.entries["review-file:a.js"].note = "Different note";
    await assert.rejects(state.importHandoff({ artifact: conflict, revision: 1 }), /conflicts with an existing decision for a\.js;/);
    await assert.rejects(state.importHandoff({ artifact, revision: 0, confirm: true }), /progress changed/);
    const invalid = { ...artifact, entries: { "review-file:missing.js": { ...entry, path: "missing.js" } } };
    await assert.rejects(state.importHandoff({ artifact: invalid, revision: 1 }), /must identify a changed file/);
    const invalidCursor = { ...artifact, cursor: { ...artifact.cursor, line: 999 } };
    const blank = new ReviewState(root, { runAnalyzer: async () => modelFor(root) });
    blank.model = state.model;
    blank.reviewTarget = target;
    await assert.rejects(blank.importHandoff({ artifact: invalidCursor, revision: 0 }), /line is not available/);
    const cloneRoot = join(root, "other-clone");
    const clone = new ReviewState(cloneRoot, { workspacePath: join(root, "clone-session"),
        runAnalyzer: async () => modelFor(cloneRoot) });
    clone.model = modelFor(cloneRoot);
    clone.reviewTarget = target;
    const imported = await clone.importHandoff({ artifact, revision: 0, confirm: true });
    assert.equal(imported.entries["review-file:a.js"].note, entry.note, "portable decisions restore in a different clone path");
    assert.equal(imported.cursor.line, 2);
    clone.model.source_files["a.js"].current += "newer worktree text";
    await assert.rejects(clone.importHandoff({ artifact, revision: 1 }), /does not match the loaded saved source/);
    assert.equal((await clone.progressForReview()).revision, 0, "newer source has a separate empty ledger");
    assert.equal((await state.progressForReview()).revision, 1);
    const reset = await state.progressForReview();
    await state.saveReviewProgress({ snapshot: reset.snapshot, revision: reset.revision, cursor: reset.cursor,
        entries: { "review-file:a.js": { ...reset.entries["review-file:a.js"], disposition: "pending", note: "" } } });
    const reimported = await state.importHandoff({ artifact, revision: reset.revision + 1, confirm: true });
    assert.equal(reimported.entries["review-file:a.js"].disposition, entry.disposition,
        "a reset Not reviewed record without a note does not block a teammate import");
    await state.dispose();
    await blank.dispose();
    await clone.dispose();
});

test("provider handoff requires explicit fresh confirmation, pins exact preview, and cannot submit twice concurrently", async () => {
    const calls = [];
    const state = new ReviewState("C:\\source\\sample", { runAnalyzer: async () => modelFor(), github: offline,
        submitHandoffReview: async (input) => { calls.push(input); return { id: 42, commit: input.commit }; } });
    state.model = modelFor();
    state.reviewTarget = { ...target, mode: "pr", url: "https://github.com/example/repo/pull/1" };
    let preview = await state.prepareHandoff();
    assert.equal(calls.length, 0, "preview must never publish");
    await assert.rejects(state.submitHandoff({ token: preview.token, confirm: false }), /explicit confirmation/);
    const results = await Promise.allSettled([
        state.submitHandoff({ token: preview.token, confirm: true }),
        state.submitHandoff({ token: preview.token, confirm: true }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, preview.markdown);
    assert.equal(calls[0].commit, head);
    preview = await state.prepareHandoff();
    const current = await state.progressForReview();
    await state.saveReviewProgress({ ...current, entries: progress.entries });
    await assert.rejects(state.submitHandoff({ token: preview.token, confirm: true }), /decisions or comments changed/);
    preview = await state.prepareHandoff();
    state.model = modelFor();
    await assert.rejects(state.submitHandoff({ token: preview.token, confirm: true }), /target changed/);
    assert.equal(calls.length, 1);
    await state.dispose();
});

test("a PR review posts the chosen verdict with drafted line comments once, then clears the posted drafts", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pr-submit-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const calls = [];
    const diffModel = () => ({ ...modelFor(), source_files: { "a.js": { current: "x\ny\n", baseline: "x\n", diff: "@@ -1 +1,2 @@\n x\n+y\n" } } });
    const state = new ReviewState(root, { runAnalyzer: async () => diffModel(), workspacePath: root, github: offline,
        submitHandoffReview: async (input) => { calls.push(input); return { id: 7, state: "CHANGES_REQUESTED", commit: input.commit }; } });
    state.model = diffModel();
    state.reviewTarget = { ...target, mode: "pr", url: "https://github.com/example/repo/pull/1" };
    await assert.rejects(state.updateReviewDraft({ revision: 0, action: "add", comment: { path: "a.js", line: 9, side: "RIGHT", body: "x" } }), /outside the diff/);
    await state.updateReviewDraft({ revision: 0, action: "add", comment: { path: "a.js", line: 2, side: "RIGHT", body: "Check y." } });
    const preview = await state.prepareHandoff();
    assert.equal(preview.provider.comments, 1);
    assert.doesNotMatch(preview.markdown, /## Line comments/, "on a PR, comments are posted inline rather than in the summary");
    await assert.rejects(state.submitHandoff({ token: preview.token, confirm: true, event: "MERGE" }), /Comment, Approve or Request changes/);
    const fresh = await state.prepareHandoff();
    await state.submitHandoff({ token: fresh.token, confirm: true, event: "REQUEST_CHANGES" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, "REQUEST_CHANGES");
    assert.deepEqual(calls[0].comments, [{ path: "a.js", line: 2, side: "RIGHT", body: "Check y." }]);
    assert.equal((await state.reviewDrafts()).comments.length, 0, "posted drafts are cleared");
    state.reviewTarget = { ...target, mode: "commit" };
    const local = await state.reviewDrafts();
    await state.updateReviewDraft({ revision: local.revision, action: "add", comment: { path: "a.js", line: 2, side: "RIGHT", body: "Local note." } });
    assert.match((await state.prepareHandoff()).markdown, /## Line comments\n.*\n- ` a\.js:2 ` — Local note\./, "without a PR, comments travel in the summary");
    await state.dispose();
});

test("a moved PR head pauses posting and Viewed sync, and threads stay anchored to the reviewed commit", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pr-moved-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const moved = "c".repeat(40);
    let prHead = head;
    const mutations = [], posted = [];
    const github = async (args) => {
        const query = args.find((arg) => String(arg).startsWith("query=")) || "";
        if (query.startsWith("query=mutation")) { mutations.push(query); return { data: {} }; }
        if (query) return { data: { viewer: { login: "reviewer" }, repository: { pullRequest: { id: "PR_1", author: { login: "author" },
            headRefOid: prHead, state: "OPEN", files: { nodes: [{ path: "a.js", viewerViewedState: "UNVIEWED" }] } } } } };
        if (String(args[1]).includes("/comments")) return [
            { id: 1, path: "a.js", line: null, original_line: 2, side: "RIGHT", commit_id: moved, original_commit_id: head, body: "On the reviewed commit", user: { login: "x" } },
            { id: 2, path: "a.js", line: 1, original_line: 1, side: "RIGHT", commit_id: moved, original_commit_id: moved, body: "On the newer commit", user: { login: "x" } },
        ];
        throw new Error(`unexpected gh call ${args.join(" ")}`);
    };
    const diffModel = () => ({ ...modelFor(), source_files: { "a.js": { current: "x\ny\n", baseline: "x\n", diff: "@@ -1 +1,2 @@\n x\n+y\n" } } });
    const state = new ReviewState(root, { runAnalyzer: async () => diffModel(), workspacePath: root, github,
        submitHandoffReview: async (input) => { posted.push(input); return { id: 8, state: "COMMENTED", commit: input.commit }; } });
    state.model = diffModel();
    state.reviewTarget = { ...target, mode: "pr", url: "https://github.com/example/repo/pull/1" };
    const reviewed = { "review-file:a.js": { disposition: "reviewed", path: "a.js" } };

    prHead = moved;
    state.prStateCache = null;
    const sync = await state.syncViewed({}, reviewed);
    assert.equal(sync.head_moved, true);
    assert.deepEqual(sync.paths, ["a.js"]);
    assert.match(sync.message, /newer commits \(ccccccc\)/);
    assert.equal(mutations.length, 0, "Viewed is not set for code the reviewer has not seen");
    const view = await state.prReview();
    assert.equal(view.head_matches, false);
    assert.equal(view.head, moved);
    const [onReviewed, onNewer] = view.threads;
    assert.deepEqual([onReviewed.line, onReviewed.outdated], [2, false], "a thread written on the reviewed commit stays on its original line");
    assert.equal(onNewer.outdated, true, "a thread on a newer commit is set aside");
    const blocked = await state.prepareHandoff();
    assert.equal(blocked.provider.available, false);
    assert.equal(blocked.provider.head_moved, true);
    assert.match(blocked.provider.reason, /newer commits/);
    await assert.rejects(state.updateReviewDraft({ revision: 0, action: "add", comment: { path: "a.js", line: 2, side: "RIGHT", body: "x" } }),
        /newer commits \(ccccccc\)/, "no new drafts against a moved head");

    prHead = head;
    state.prStateCache = null;
    assert.equal((await state.syncViewed({}, reviewed)).synced, 1);
    assert.equal(mutations.length, 1);
    assert.match(mutations[0], /markFileAsViewed/);
    const ready = await state.prepareHandoff();
    assert.equal(ready.provider.available, true);
    await assert.rejects(state.submitHandoff({ token: ready.token, confirm: true, summary: 42 }), /summary must be text/);
    const again = await state.prepareHandoff();
    await state.submitHandoff({ token: again.token, confirm: true, event: "COMMENT", summary: "  Looks right; one question inline.  " });
    assert.match(posted[0].body, /^Looks right; one question inline\.\n\n---\n\n# Agent Review handoff/, "the reviewer's words lead the review body");
    await state.dispose();
});

test("GitHub contract checks current head, posts only COMMENT on the reviewed commit, validates receipts and exposes unknown outcomes", async () => {
    const url = "https://github.com/example/repo/pull/1";
    const input = { url, commit: head, body: "Human review summary", cwd: "C:\\source\\sample" };
    const calls = [];
    const receipt = await submitGitHubHandoff(input, async (args, stdin) => {
        calls.push({ args, stdin });
        return args[0] === "pr" ? { headRefOid: head, state: "OPEN" }
            : { id: 9, commit_id: head, state: "COMMENTED", html_url: `${url}#pullrequestreview-9` };
    });

    assert.equal(receipt.commit, head);
    assert.deepEqual(JSON.parse(calls[1].stdin), { commit_id: head, body: input.body, event: "COMMENT" });
    assert.deepEqual(calls[1].args, ["api", "--method", "POST", "repos/example/repo/pulls/1/reviews", "--input", "-"]);
    let checked = 0;
    await assert.rejects(submitGitHubHandoff(input, async () => { checked++; return { headRefOid: base, state: "OPEN" }; }), /head changed/);
    assert.equal(checked, 1, "no POST after moved head");
    await assert.rejects(submitGitHubHandoff(input, async (args) => {
        if (args[0] === "pr") return { headRefOid: head, state: "OPEN" };
        throw new Error("connection lost");
    }), /outcome is unknown.*Check the PR/);
});

test("a refreshed preview cannot start another provider review while a receipt is pending", async () => {
    let entered, release;
    const started = new Promise((resolve) => { entered = resolve; });
    const receipt = new Promise((resolve) => { release = resolve; });
    const state = new ReviewState("C:\\source\\sample", { runAnalyzer: async () => modelFor(), github: offline,
        submitHandoffReview: async () => { entered(); return receipt; } });
    state.model = modelFor();
    state.reviewTarget = { ...target, mode: "pr", url: "https://github.com/example/repo/pull/1" };
    const first = await state.prepareHandoff();
    const pending = state.submitHandoff({ token: first.token, confirm: true });
    await started;
    const refreshed = await state.prepareHandoff();
    assert.equal(refreshed.provider.available, false);
    await assert.rejects(state.submitHandoff({ token: refreshed.token, confirm: true }), /fresh preview and explicit confirmation/);
    release({ id: 1 });
    await pending;
    await state.dispose();
});
