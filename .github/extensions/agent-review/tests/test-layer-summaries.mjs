import assert from "node:assert/strict";
import test from "node:test";
import { layerSummaryContext, layerSummaryPrompt, layerSummarySchema, validateLayerSummaries } from "../layer-summaries.mjs";
import { ReviewState } from "../review-state.mjs";
import { workspaceNavigation } from "../web/review-workspace.mjs";

const model = {
    metadata: {}, attention: [], warnings: [], edges: [],
    changes: [{ path: "src/utils/format.js", status: "modified", lines_added: 3, lines_removed: 1 },
        { path: "src/components/Card.jsx", status: "modified", lines_added: 2, lines_removed: 0 }, { path: "README.md", status: "modified" }],
    nodes: [{ id: "fmt", path: "src/utils/format.js", name: "format", kind: "function", change: "modified" },
        { id: "card", path: "src/components/Card.jsx", name: "Card", kind: "function", change: "modified" }],
    source_files: { "src/utils/format.js": { current: "x", diff: "@@ -1 +1 @@\n-old secret line\n+return value.trim();\n" },
        "src/components/Card.jsx": { current: "y", diff: "@@ -1 +1 @@\n+<Card title={format(t)} />\n" } },
};
const data = { sections: [
    { id: "s1", number: 1, kind: "behavior", title: "Change format", subject_id: "fmt", tests: [],
        ranges: [{ path: "src/utils/format.js", side: "current", line: 1, end_line: 2, symbol_id: "fmt" }] },
    { id: "s2", number: 2, kind: "behavior", title: "Change Card", subject_id: "card", tests: [],
        ranges: [{ path: "src/components/Card.jsx", side: "current", line: 1, end_line: 2, symbol_id: "card" }] },
], file_relations: [{ from: "src/components/Card.jsx", to: "src/utils/format.js", kind: "call" }] };

test("layer intent context is bounded to supplied diffs and never includes supporting layers", () => {
    const navigation = workspaceNavigation(model, data);
    const context = layerSummaryContext(model, navigation);
    assert.deepEqual(context.layers.map((layer) => layer.name), ["Utilities", "User interface"]);
    assert.match(context.layers[0].diff_excerpts[0].diff, /return value\.trim/);
    assert.equal(context.layers[1].builds_on[0], "Utilities");
    assert.match(layerSummaryPrompt(context), /at most 16 words/);
    assert.deepEqual(layerSummarySchema(context).properties.layers.items.properties.id.enum, context.layers.map((layer) => layer.id));
    assert.equal(navigation.layers.at(-1).summary, "1 file without a source relationship to the layers above");
    assert.equal(navigation.layers[0].summary, "Changes format");
});

test("layer intents must cover every layer with one short plain sentence", () => {
    const context = layerSummaryContext(model, workspaceNavigation(model, data));
    const [utils, ui] = context.layers.map((layer) => layer.id);
    assert.deepEqual(validateLayerSummaries({ layers: [{ id: utils, intent: "Trims formatted values" }, { id: ui, intent: "Cards render formatted titles" }] }, context),
        { [utils]: "Trims formatted values", [ui]: "Cards render formatted titles" });
    assert.throws(() => validateLayerSummaries({ layers: [{ id: utils, intent: "Trims formatted values" }] }, context), /every supplied layer/);
    assert.throws(() => validateLayerSummaries({ layers: [{ id: utils, intent: "See [docs](https://x)" }, { id: ui, intent: "Cards render formatted titles" }] }, context), /plain sentence/);
    const long = Array.from({ length: 24 }, (_, index) => `word${index}`).join(" ");
    assert.throws(() => validateLayerSummaries({ layers: [{ id: utils, intent: long }, { id: ui, intent: "Cards render formatted titles" }] }, context), /at most 16 words/);
});

test("layer summaries are generated once per review and cached with its annotations", async () => {
    let calls = 0;
    const state = new ReviewState("C:\\repo", { generateLayerSummaries: async (context) => {
        calls++;
        return Object.fromEntries(context.layers.map((layer) => [layer.id, `Changes in ${layer.name}`]));
    } });
    state.model = model;
    state.reviewTarget = { mode: "commit" };
    const [first, second] = await Promise.all([state.layerSummariesFor(), state.layerSummariesFor()]);
    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(Object.keys(first.intents).length, 2);
    assert.equal(state.annotations.layers, first);
    await state.layerSummariesFor();
    assert.equal(calls, 1, "a cached intent set is reused");
    await state.dispose();
});
