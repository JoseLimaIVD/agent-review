import assert from "node:assert/strict";
import test from "node:test";
import { fileTree, groupForSource, reviewSequence, workspaceNavigation } from "../web/review-workspace.mjs";
import { fileReviewId, nextFileReview } from "../web/review-ledger.mjs";

test("navigation represents every changed file without turning related unchanged source into a changed member", () => {
    const model = { changes: [
        { path: "src/a.js", status: "modified" }, { path: "src/b.js", status: "added" },
        { path: "removed.js", status: "removed" }, { path: "unchanged.js", status: "unchanged" },
    ] };
    const data = { sections: [{ id: "group", title: "Change a", kind: "behavior", ranges: [
        { path: "src/a.js", side: "current", line: 1, end_line: 5 },
        { path: "src/a.js", side: "base", line: 1, end_line: 4 },
        { path: "unchanged.js", side: "current", line: 1, end_line: 3 },
    ] }] };
    const navigation = workspaceNavigation(model, data);
    assert.equal(navigation.files.length, 3);
    assert.deepEqual(navigation.groups[0].files.map((file) => file.path), ["src/a.js"]);
    assert.equal(new Set(navigation.groups.flatMap((group) => group.files.map((file) => file.path))).size, 3);
    assert.equal(groupForSource(navigation, { path: "unchanged.js", start_line: 2 }), null);
});
test("exact range ownership wins over an earlier group in the same file", () => {
    const navigation = workspaceNavigation({ changes: [{ path: "a.js", status: "modified" }] }, { sections: [
        { id: "first", title: "First change", kind: "behavior", ranges: [{ path: "a.js", side: "current", line: 1, end_line: 5 }] },
        { id: "second", title: "Second change", kind: "behavior", ranges: [{ path: "a.js", side: "current", line: 10, end_line: 20 }] },
    ] });
    assert.equal(groupForSource(navigation, { path: "a.js", start_line: 15 }, "first").id, "second");
    assert.equal(groupForSource(navigation, { path: "a.js", start_line: 30 }, "first"), null);
    assert.equal(groupForSource(navigation, { path: "a.js" }, "first").id, "first");
});
test("files remain accessible before grouping completes and their tree preserves exact paths", () => {
    const navigation = workspaceNavigation({ changes: [
        { path: ".generated/data.json", status: "modified" }, { path: "src/routing/a.js", status: "modified" },
        { path: "README.md", status: "modified" },
    ] }, null);
    assert.equal(navigation.groups.length, 1);
    assert.equal(navigation.groups[0].files.length, 3);
    const tree = fileTree(navigation.files);
    assert.equal(tree.files[0].path, "README.md");
    assert.equal(tree.directories.get("src").directories.get("routing").files[0].path, "src/routing/a.js");
});

test("mark reviewed & next follows the visible rail without skipping same-group or earlier groups", () => {
    const model = { changes: ["backend/export.py", "tests/unit/test_export.py", "src/cited.js", "src/authors.js", "src/meta.py", "docs/readme.md"]
        .map((path) => ({ path, status: "modified" })) };
    const range = (path) => ({ path, side: "current", line: 1, end_line: 2 });
    const sections = { sections: [
        { id: "g1", title: "Change correction fields", kind: "behavior", ranges: [range("tests/unit/test_export.py"), range("backend/export.py")] },
        { id: "g2", title: "Change cited", kind: "behavior", ranges: [range("src/cited.js")] },
        { id: "g3", title: "Change authors", kind: "behavior", ranges: [range("src/authors.js"), range("backend/export.py")] },
        { id: "g4", title: "Change metadata", kind: "behavior", ranges: [range("src/meta.py")] },
    ] };
    const navigation = workspaceNavigation(model, sections);
    const sequence = reviewSequence(navigation);
    assert.deepEqual(sequence.map(({ path, group }) => `${group}:${path}`), [
        "g1:backend/export.py", "g1:tests/unit/test_export.py", "g2:src/cited.js",
        "g3:backend/export.py", "g3:src/authors.js", "g4:src/meta.py", "workspace:supporting:docs/readme.md",
    ], "groups in order, folders alphabetically before files as rendered");
    const entries = new Map([[fileReviewId("backend/export.py"), { disposition: "reviewed" }]]);
    assert.equal(nextFileReview(sequence, entries, { path: "backend/export.py", group: "g1" }).path, "tests/unit/test_export.py");
    assert.equal(nextFileReview(sequence, entries, { path: "backend/export.py", group: "g3" }).path, "src/authors.js",
        "an overlapping file advances from the group being read");
    entries.set(fileReviewId("src/meta.py"), { disposition: "reviewed" });
    entries.set(fileReviewId("docs/readme.md"), { disposition: "reviewed" });
    assert.equal(nextFileReview(sequence, entries, { path: "docs/readme.md", group: "workspace:supporting" }).path, "tests/unit/test_export.py",
        "wraps to the earliest unreviewed file instead of finishing");
    assert.deepEqual(reviewSequence(navigation, "files").map(({ path }) => path),
        ["backend/export.py", "docs/readme.md", "src/cited.js", "src/authors.js", "src/meta.py", "tests/unit/test_export.py"],
        "Files mode follows the rendered tree: folders alphabetically, files in model order");
});