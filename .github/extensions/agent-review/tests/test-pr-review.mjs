import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commentableLines, parsePullRequestUrl, pullRequestCommentableLines, pullRequestThreads, ReviewDraftStore, setFileViewed, submitPullRequestReview,
    validateDraftComment } from "../pr-review.mjs";

const url = "https://github.com/example/repo/pull/7";
const head = "c".repeat(40);
const diff = "diff --git a/s.py b/s.py\n--- a/s.py\n+++ b/s.py\n@@ -3,4 +3,6 @@ def quote\n     x = 1\n-    return 5\n+    if amount < 0:\n+        raise ValueError\n+    return 5\n     y = 2\n";
const model = { changes: [{ path: "s.py", status: "modified" }], source_files: { "s.py": { diff } } };

test("comments anchor only to lines GitHub can place: added/context on the right, removed/context on the left", () => {
    const lines = commentableLines(diff);
    assert.deepEqual([...lines.RIGHT], [3, 4, 5, 6, 7]);
    assert.deepEqual([...lines.LEFT], [3, 4, 5]);
    assert.deepEqual(validateDraftComment({ path: "s.py", line: 4, side: "RIGHT", body: " Guard negative amounts. " }, model),
        { path: "s.py", line: 4, side: "RIGHT", body: "Guard negative amounts." });
    assert.throws(() => validateDraftComment({ path: "s.py", line: 40, side: "RIGHT", body: "x" }, model), /outside the diff/);
    assert.throws(() => validateDraftComment({ path: "other.py", line: 4, side: "RIGHT", body: "x" }, model), /not a changed file/);
    assert.throws(() => validateDraftComment({ path: "s.py", line: 4, side: "RIGHT", body: "  " }, model), /1-4000 characters/);
    assert.equal(parsePullRequestUrl(url).repo, "example/repo");
    assert.throws(() => parsePullRequestUrl("https://example.com/pull/1"), /pull request URL/);
});

test("on a pull request, GitHub's own patch decides commentable lines even when the saved diff has wider context", async () => {
    const calls = [];
    // GitHub's hunk keeps one line of context above the change; the saved diff above keeps two.
    const run = async (args) => { calls.push(args[1]); return [{ filename: "s.py", patch: "@@ -4,3 +4,5 @@ def quote\n-    return 5\n+    if amount < 0:\n+        raise ValueError\n+    return 5\n     y = 2" }]; };
    const lines = await pullRequestCommentableLines(url, "C:\\repo", run);
    assert.match(calls[0], /repos\/example\/repo\/pulls\/7\/files\?per_page=100&page=1/);
    assert.deepEqual([...lines["s.py"].RIGHT], [4, 5, 6, 7]);
    assert.ok(commentableLines(diff).RIGHT.has(3), "the saved diff would allow line 3");
    assert.throws(() => validateDraftComment({ path: "s.py", line: 3, side: "RIGHT", body: "x" }, model, lines), /outside the pull request's diff on GitHub/);
    assert.equal(validateDraftComment({ path: "s.py", line: 5, side: "RIGHT", body: "ok" }, model, lines).line, 5);
    assert.throws(() => validateDraftComment({ path: "s.py", line: 5, side: "RIGHT", body: "x" }, model, {}), /outside the pull request's diff/,
        "a file GitHub shows without a patch takes no comments");
});

test("drafts persist per snapshot and two tabs cannot overwrite each other", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pr-drafts-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new ReviewDraftStore(root);
    const added = await store.update("snap", 0, { action: "add", comment: { path: "s.py", line: 4, side: "RIGHT", body: "One" } });
    assert.equal(added.comments.length, 1);
    await assert.rejects(store.update("snap", 0, { action: "add", comment: { path: "s.py", line: 5, side: "RIGHT", body: "Two" } }), /another tab/);
    const edited = await store.update("snap", 1, { action: "edit", id: added.comments[0].id, body: "Edited" });
    assert.equal(edited.comments[0].body, "Edited");
    const reread = await new ReviewDraftStore(root).read("snap");
    assert.equal(reread.comments[0].body, "Edited", "drafts survive a restart");
    assert.equal((await store.read("other")).comments.length, 0, "another snapshot has its own drafts");
    assert.equal((await store.update("snap", 2, { action: "delete", id: added.comments[0].id })).comments.length, 0);
});

test("a review posts the verdict and line comments once, refuses self-approval and a moved head", async () => {
    const calls = [];
    const github = (author = "teammate") => async (args, input) => {
        calls.push({ args, input });
        if (args[1] === "graphql") return { data: { viewer: { login: "me" }, repository: { pullRequest: { id: "PR_1", author: { login: author }, headRefOid: head, state: "OPEN", files: { nodes: [] } } } } };
        const payload = JSON.parse(input);
        return { id: 99, html_url: `${url}#pullrequestreview-99`, commit_id: payload.commit_id, state: { COMMENT: "COMMENTED", APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" }[payload.event] };
    };
    const comments = [{ path: "s.py", line: 4, side: "RIGHT", body: "Guard negative amounts." }];
    const receipt = await submitPullRequestReview({ url, commit: head, event: "REQUEST_CHANGES", body: "Summary", comments }, ".", github());
    assert.equal(receipt.state, "CHANGES_REQUESTED");
    const posted = calls.at(-1);
    assert.deepEqual(posted.args, ["api", "--method", "POST", "repos/example/repo/pulls/7/reviews", "--input", "-"]);
    assert.deepEqual(JSON.parse(posted.input), { commit_id: head, event: "REQUEST_CHANGES", body: "Summary", comments });
    await assert.rejects(submitPullRequestReview({ url, commit: head, event: "APPROVE", body: "" }, ".", github("me")), /your own pull request/);
    const before = calls.length;
    await assert.rejects(submitPullRequestReview({ url, commit: "d".repeat(40), event: "COMMENT", body: "x" }, ".", github()), /head changed/);
    assert.equal(calls.length, before + 1, "a moved head stops before posting");
    await assert.rejects(submitPullRequestReview({ url, commit: head, event: "COMMENT", body: " " }, ".", github()), /summary or add line comments/);
    assert.equal((await submitPullRequestReview({ url, commit: head, event: "APPROVE", body: "" }, ".", github())).state, "APPROVED", "approval needs no text");
});

test("threads and Viewed state are read and written through the reviewer's GitHub identity", async () => {
    const pages = [Array.from({ length: 100 }, (_, index) => ({ id: index, path: "s.py", line: index ? 4 : null, original_line: 4, body: "b", user: { login: "x" } })), []];
    const threads = await pullRequestThreads(url, ".", async (args) => pages[Number(/&page=(\d+)/.exec(args[1])[1]) - 1]);
    assert.equal(threads.length, 100);
    assert.equal(threads[0].outdated, true, "a comment GitHub no longer anchors is marked outdated");
    const calls = [];
    await setFileViewed({ url, pullRequestId: "PR_1", path: "s.py", viewed: true }, ".", async (args) => { calls.push(args); return { data: {} }; });
    assert.match(calls[0][3], /markFileAsViewed/);
    await setFileViewed({ url, pullRequestId: "PR_1", path: "s.py", viewed: false }, ".", async (args) => { calls.push(args); return { data: {} }; });
    assert.match(calls[1][3], /unmarkFileAsViewed/);
    await assert.rejects(setFileViewed({ url, pullRequestId: "PR_1", path: "s.py", viewed: true }, ".", async () => ({ errors: [{ message: "denied" }] })), /denied/);
});
