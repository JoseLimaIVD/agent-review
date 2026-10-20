import assert from "node:assert/strict";
import test from "node:test";
import { restoreSharedBaselines, runAnalyzerProcess } from "../review-state.mjs";
import { buildCodePathRequest } from "../node-review-adapter.mjs";

// A repository that commits built bundles must still produce a bounded analyzer model.
test("unchanged text sent once is restored for every consumer that reads both sides", async () => {
    const payload = { source_files: {
        "src/app.ts": { current: "export const a = 1;\n", diff: "", baseline_same: true },
        "src/new.ts": { current: "x", diff: "+x", baseline: null },
        "assets/kept-9z8y7x6w.js": { generated: true, omitted: true },
    } };
    const model = await runAnalyzerProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`]);
    assert.equal(model.source_files["src/app.ts"].baseline, "export const a = 1;\n");
    assert.equal(Object.hasOwn(model.source_files["src/app.ts"], "baseline_same"), false);
    assert.equal(model.source_files["src/new.ts"].baseline, null, "an added file keeps its missing base");
    assert.deepEqual(restoreSharedBaselines({}), {});
});

test("generated bundles are never handed to the code-path extractor as import sources", () => {
    const model = {
        symbols: [{ id: "f", kind: "function", classification: "modified", path: "src/app.ts", qualname: "run" }],
        source_files: {
            "src/app.ts": { current: "export function run() {}\n", baseline: "export function run() { return 1; }\n" },
            "assets/index-CO33IrX7.js": { current: "!function(){}();", baseline: null, generated: true },
            "assets/kept-9z8y7x6w.js": { generated: true, omitted: true },
        },
        changes: [{ path: "src/app.ts", added_lines: [1] }],
    };
    const request = buildCodePathRequest(model, "repo");
    assert.deepEqual(request.sources.map((source) => source.path), ["src/app.ts"]);
});
