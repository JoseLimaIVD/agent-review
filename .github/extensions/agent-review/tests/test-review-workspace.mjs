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
test("sections sharing a changed file become one file group, and any line of that file resolves to it", () => {
    const navigation = workspaceNavigation({ changes: [{ path: "a.js", status: "modified" }] }, { sections: [
        { id: "first", number: 1, title: "Change first", kind: "behavior", subject_id: "f1",
            ranges: [{ path: "a.js", side: "current", line: 1, end_line: 5, symbol_id: "f1" }], tests: [] },
        { id: "second", number: 2, title: "Change second", kind: "behavior", subject_id: "f2",
            ranges: [{ path: "a.js", side: "current", line: 10, end_line: 20, symbol_id: "f2" }], tests: [] },
    ] });
    assert.equal(navigation.groups.length, 1);
    assert.equal(navigation.groups[0].label, "a.js — first, second");
    assert.equal(groupForSource(navigation, { path: "a.js", start_line: 15 }).id, navigation.groups[0].id);
    assert.equal(groupForSource(navigation, { path: "a.js", start_line: 30 }).id, navigation.groups[0].id);
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

test("layers order areas foundations-first, list every file once with its role, and Next follows the rail", () => {
    const paths = ["web/src/utils/format.js", "web/src/utils/format.test.js", "web/src/components/Card.jsx",
        "web/src/components/Card.test.jsx", "web/src/components/List.jsx", "web/src/components/List.test.jsx",
        "web/src/components/Header.jsx", "server/routes/export.py", "README.md"];
    const model = { changes: paths.map((path) => ({ path, status: "modified" })),
        nodes: [
            { id: "fmt", path: "web/src/utils/format.js" }, { id: "card", path: "web/src/components/Card.jsx" },
            { id: "list", path: "web/src/components/List.jsx" }, { id: "header", path: "web/src/components/Header.jsx" },
            { id: "export", path: "server/routes/export.py" },
        ],
        edges: [{ type: "calls", source: "card", target: "fmt" }, { type: "imports", source: "list", target: "card" }] };
    const range = (path, symbol) => ({ path, side: "current", line: 1, end_line: 2, ...(symbol ? { symbol_id: symbol } : {}) });
    const section = (number, subject, path, extra = {}) => ({ id: `s${number}`, number, kind: "behavior", subject_id: subject,
        title: `Change ${subject}`, ranges: [range(path, subject), ...(extra.ranges || [])], tests: extra.tests || [] });
    const data = { sections: [
        section(1, "fmt", "web/src/utils/format.js", { tests: [{ id: "t1", path: "web/src/utils/format.test.js" }] }),
        section(2, "card", "web/src/components/Card.jsx"),
        section(3, "list", "web/src/components/List.jsx", { ranges: [range("web/src/components/Card.jsx", "card")],
            tests: [{ id: "t3", path: "web/src/components/List.test.jsx" }] }),
        section(4, "export", "server/routes/export.py"),
        section(5, "header", "web/src/components/Header.jsx"),
        { id: "section:file:README.md", number: 6, kind: "supporting", title: "Documentation: README.md", ranges: [range("README.md")], tests: [] },
    ], file_relations: [
        { from: "web/src/components/Card.jsx", to: "web/src/utils/format.js", kind: "call" },
        { from: "web/src/components/List.jsx", to: "web/src/components/Card.jsx", kind: "import", line: 1 },
        { from: "web/src/utils/format.test.js", to: "web/src/utils/format.js", kind: "import", line: 1 },
    ] };
    const navigation = workspaceNavigation(model, data);
    assert.deepEqual(navigation.layers.map((layer) => [layer.number, layer.name, layer.dependsOn.map((item) => `${item.number}:${item.example}`)]),
        [[1, "Utilities", []], [2, "User interface", ["1:components/Card.jsx calls utils/format.js"]], [3, "Backend", []], [null, "Supporting files", []]]);
    const listed = navigation.groups.flatMap((group) => group.files.map((file) => file.path));
    assert.deepEqual([...listed].sort(), [...paths].sort(), "every changed file exactly once");
    const card = navigation.groups.find((group) => group.primaries[0] === "web/src/components/Card.jsx");
    assert.equal(card.roles.get("web/src/components/Card.test.jsx"), "name-matched test");
    const list = navigation.groups.find((group) => group.primaries[0] === "web/src/components/List.jsx");
    assert.deepEqual(list.related, [{ path: "web/src/components/Card.jsx", group: card.id }], "a shared file stays with its own group");
    assert.equal(navigation.groups.find((group) => group.title === "format.js").roles.get("web/src/utils/format.test.js"), "test");
    const sequence = reviewSequence(navigation);
    assert.deepEqual(sequence.map(({ path }) => path), ["web/src/utils/format.js", "web/src/utils/format.test.js",
        "web/src/components/Card.jsx", "web/src/components/Card.test.jsx", "web/src/components/List.jsx",
        "web/src/components/List.test.jsx", "web/src/components/Header.jsx", "server/routes/export.py", "README.md"]);
    const entries = new Map([[fileReviewId("web/src/utils/format.js"), { disposition: "reviewed" }]]);
    assert.equal(nextFileReview(sequence, entries, { path: "web/src/utils/format.js", group: sequence[0].group }).path,
        "web/src/utils/format.test.js");
    entries.set(fileReviewId("README.md"), { disposition: "reviewed" });
    assert.equal(nextFileReview(sequence, entries, { path: "README.md", group: "workspace:supporting" }).path, "web/src/utils/format.test.js",
        "wraps to the earliest unreviewed file instead of finishing");
    assert.equal(groupForSource(navigation, { path: "web/src/components/Card.jsx", start_line: 400 }).id, card.id);
    assert.deepEqual(reviewSequence(navigation, "files").map(({ path }) => path).slice(0, 2), ["server/routes/export.py", "web/src/components/Card.jsx"],
        "Files mode keeps the alphabetical folder tree");
});