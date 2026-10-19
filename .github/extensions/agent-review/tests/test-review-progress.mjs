import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReviewProgressStore } from "../review-progress.mjs";
import { effectiveDisposition, fileReviewId, fileReviewProgress, nextFileReview, nextReviewItem, reviewProgress } from "../web/review-ledger.mjs";
import { ReviewState } from "../review-state.mjs";
import { startReviewServer } from "../server.mjs";

test("whole-file completion never promotes a smaller priority or group acknowledgment", () => {
    const model = { changes: [{ path: "a.js", status: "modified" }, { path: "b.js", status: "added" }] };
    const entries = new Map([["review:function", { disposition: "reviewed", path: "a.js" }],
        ["section:group", { disposition: "reviewed" }], [fileReviewId("b.js"), { disposition: "follow-up" }]]);
    assert.deepEqual(fileReviewProgress(model, entries), { total: 2, reviewed: 0, followUp: 1, pending: 1 });
    entries.set(fileReviewId("a.js"), { disposition: "reviewed" });
    assert.equal(fileReviewProgress(model, entries).reviewed, 1);
    assert.equal(nextFileReview(model.changes, entries, "a.js").path, "b.js");
});
test("priority queue progress derives from whole-file decisions while concern triage still counts", () => {
    const plan = [{ id: "review:one", path: "a.js" }, { id: "review:two", path: "b.js" }, { id: "review:three", path: "c.js" }];
    const entries = new Map([[fileReviewId("a.js"), { disposition: "reviewed" }],
        ["review:two", { disposition: "false-positive" }], [fileReviewId("c.js"), { disposition: "follow-up" }]]);
    assert.equal(effectiveDisposition(plan[0], entries), "reviewed", "a reviewed file reviews its priority item");
    assert.equal(effectiveDisposition(plan[1], entries), "false-positive");
    assert.deepEqual(reviewProgress(plan, entries), { completed: 2, followUp: 1, total: 3 });
    assert.equal(nextReviewItem(plan, entries).id, "review:three");
    assert.deepEqual(fileReviewProgress({ changes: plan.map((item) => ({ path: item.path, status: "modified" })) }, entries),
        { total: 3, reviewed: 1, followUp: 1, pending: 1 }, "triage never marks a file reviewed");
});
test("session progress and cursor survive a new store instance without browser-origin dependence", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "review-progress-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new ReviewProgressStore(root);
    assert.equal((await store.read("snapshot-one")).revision, 0);
    const cursor = { path: "a.js", line: 3, side: "base", tab: "diff", item_id: "node", group: "group" };
    const result = await store.update("snapshot-one", 0, { [fileReviewId("a.js")]: {
        disposition: "reviewed", note: "Checked the boundary.", path: "a.js", line: 3,
    } }, cursor);
    assert.equal(result.durable, true);
    assert.equal(result.revision, 1);
    const reloaded = await new ReviewProgressStore(root).read("snapshot-one");
    assert.equal(reloaded.entries[fileReviewId("a.js")].note, "Checked the boundary.");
    assert.deepEqual(reloaded.cursor, cursor);
    assert.deepEqual((await store.read("snapshot-two")).entries, {});
});
test("concurrent/stale saves conflict explicitly rather than losing a decision", async () => {
    const store = new ReviewProgressStore();
    const results = await Promise.allSettled([
        store.update("same", 0, { one: { disposition: "reviewed" } }, null),
        store.update("same", 0, { two: { disposition: "reviewed" } }, null),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const failed = results.find((result) => result.status === "rejected");
    assert.equal(failed.reason.code, "review_progress_conflict");
    assert.equal(Object.keys((await store.read("same")).entries).length, 1);
    await assert.rejects(store.update("same", 1, null, null), /entries must be an object/);
    await assert.rejects(store.update("same", 1, {}, { path: "a.js", line: 0 }), /Invalid saved review cursor/);
});
test("progress API restores decisions on a different server origin and rejects stale or wrong-snapshot saves", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "review-progress-http-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const model = { metadata: { repo_root: root, base_sha: "base", head_sha: "head" }, coverage: {}, warnings: [],
        nodes: [], edges: [], evidence: {}, attention: [], changes: [{ path: "a.js", status: "modified" }],
        source_files: { "a.js": { current: "one\ntwo\n", baseline: "old\n", diff: "@@ -1 +1,2 @@\n-old\n+one\n+two\n" } } };
    const create = () => {
        const state = new ReviewState(root, { workspacePath: root, readWorktreeFingerprint: null });
        state.model = model;
        state.reviewTarget = { mode: "worktree" };
        return state;
    };
    const first = create();
    const one = await startReviewServer(first);
    const initial = await fetch(`${one.url}api/review-progress`).then((response) => response.json());
    const input = { snapshot: initial.snapshot, revision: 0, cursor: { path: "a.js", line: 2, side: "current", tab: "current" },
        entries: { [fileReviewId("a.js")]: { disposition: "reviewed", path: "a.js", note: "Whole file checked." } } };
    const saved = await fetch(`${one.url}api/review-progress`, { method: "POST", body: JSON.stringify(input) });
    assert.equal(saved.status, 200);
    const conflict = await fetch(`${one.url}api/review-progress`, { method: "POST", body: JSON.stringify(input) });
    assert.equal(conflict.status, 409);
    const second = create();
    const two = await startReviewServer(second);
    await one.close();
    await first.dispose();
    try {
        assert.notEqual(one.url, two.url);
        const restored = await fetch(`${two.url}api/review-progress`).then((response) => response.json());
        assert.equal(restored.entries[fileReviewId("a.js")].note, "Whole file checked.");
        assert.equal(restored.cursor.line, 2);
        const wrong = await fetch(`${two.url}api/review-progress`, { method: "POST",
            body: JSON.stringify({ ...input, snapshot: "different", revision: 1 }) });
        assert.notEqual(wrong.status, 200);
        await assert.rejects(second.saveReviewProgress({ ...input, revision: 1,
            cursor: { ...input.cursor, item_id: "unknown:item" } }), /Unknown review item/);
        await assert.rejects(second.saveReviewProgress({ ...input, revision: 1,
            cursor: { ...input.cursor, line: 999 } }), /line is not available/);
        await assert.rejects(second.saveReviewProgress({ ...input, revision: 1,
            entries: { [fileReviewId("missing.js")]: { disposition: "reviewed", path: "missing.js" } } }),
        /must identify a changed file/);
        assert.equal((await second.progressForReview()).revision, 1, "invalid saves must not mutate durable progress");
    } finally { await two.close(); await second.dispose(); }
});
