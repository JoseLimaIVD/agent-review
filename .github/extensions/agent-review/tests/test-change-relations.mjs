import assert from "node:assert/strict";
import test from "node:test";
import { changedFileRelations } from "../change-relations.mjs";
import { workspaceNavigation } from "../web/review-workspace.mjs";

const model = (files, extra = {}) => ({
    changes: Object.keys(files).map((path) => ({ path, status: "modified" })),
    source_files: Object.fromEntries(Object.entries(files).map(([path, current]) => [path, { current }])),
    nodes: [], edges: [], ...extra,
});

test("relations resolve package-relative Python imports the analyzer missed, only between changed files", () => {
    const relations = changedFileRelations(model({
        "backend/main.py": "import os\n\ndef run():\n    from refchecker.utils.paper_metadata import resolve_paper_authors\n",
        "src/refchecker/utils/paper_metadata.py": "from .helpers import clean\nfrom ..services import pdf_processor\n",
        "src/refchecker/utils/helpers.py": "def clean(): pass\n",
        "src/refchecker/services/pdf_processor.py": "x = 1\n",
        "tests/unit/test_paper_authors.py": "from refchecker.utils.paper_metadata import resolve_paper_authors\n",
    }));
    const pairs = relations.map(({ from, to, line }) => `${from}->${to}:${line}`);
    assert.ok(pairs.includes("backend/main.py->src/refchecker/utils/paper_metadata.py:4"));
    assert.ok(pairs.includes("src/refchecker/utils/paper_metadata.py->src/refchecker/utils/helpers.py:1"));
    assert.ok(pairs.includes("src/refchecker/utils/paper_metadata.py->src/refchecker/services/pdf_processor.py:2"));
    assert.ok(pairs.includes("tests/unit/test_paper_authors.py->src/refchecker/utils/paper_metadata.py:1"));
    assert.equal(relations.some((item) => item.to === "os"), false, "unchanged or external modules are ignored");
});

test("relations resolve relative JS/TS imports and requires, and keep analyzer edges between changed files", () => {
    const relations = changedFileRelations(model({
        "web/src/components/Card.jsx": "import { format } from '../utils/format';\nconst x = require(\"./List.jsx\");\n",
        "web/src/components/List.jsx": "export const List = 1;\n",
        "web/src/utils/format.js": "export const format = 1;\n",
        "web/src/utils/index.ts": "export * from './format.js';\n",
        "web/src/app.ts": "import { format } from './utils';\n",
    }, { nodes: [{ id: "a", path: "web/src/components/List.jsx" }, { id: "b", path: "web/src/utils/format.js" }, { id: "c", path: "lib/unchanged.js" }],
        edges: [{ type: "calls", source: "a", target: "b" }, { type: "calls", source: "a", target: "c" }] }));
    const pairs = relations.map(({ from, to, kind }) => `${kind}:${from}->${to}`);
    assert.ok(pairs.includes("import:web/src/components/Card.jsx->web/src/utils/format.js"));
    assert.ok(pairs.includes("import:web/src/components/Card.jsx->web/src/components/List.jsx"));
    assert.ok(pairs.includes("import:web/src/utils/index.ts->web/src/utils/format.js"));
    assert.ok(pairs.includes("import:web/src/app.ts->web/src/utils/index.ts"), "a folder import resolves to its index");
    assert.ok(pairs.includes("call:web/src/components/List.jsx->web/src/utils/format.js"));
    assert.equal(pairs.some((pair) => pair.includes("lib/unchanged.js")), false, "edges to unchanged files never order layers");
});

test("a test is attached to the file it imports rather than a file whose symbol shares its name", () => {
    const files = { "backend/main.py": "def paper_authors(): pass\n", "src/pkg/utils/paper_metadata.py": "def resolve_paper_authors(): pass\n",
        "tests/unit/test_paper_authors.py": "from pkg.utils.paper_metadata import resolve_paper_authors\n" };
    const reviewed = model(files);
    const range = (path, symbol) => ({ path, side: "current", line: 1, end_line: 1, symbol_id: symbol });
    const navigation = workspaceNavigation(reviewed, { sections: [
        { id: "s1", number: 1, kind: "behavior", title: "Change paper_authors", subject_id: "m", ranges: [range("backend/main.py", "m")], tests: [] },
        { id: "s2", number: 2, kind: "behavior", title: "Change resolve_paper_authors", subject_id: "p", ranges: [range("src/pkg/utils/paper_metadata.py", "p")], tests: [] },
    ], file_relations: changedFileRelations(reviewed) });
    const metadata = navigation.groups.find((group) => group.primaries[0] === "src/pkg/utils/paper_metadata.py");
    assert.equal(metadata.roles.get("tests/unit/test_paper_authors.py"), "test");
});
