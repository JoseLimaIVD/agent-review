import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { ReviewState } from "../review-state.mjs";
import { normalizePath } from "../test-run.mjs";
import { createReviewHandoff } from "../review-handoff.mjs";
import { baseTestId, layerTestStatus, linkedTestOutcome, mergeTestRuns, scopeDecisionMap } from "../web/decision-map.mjs";

const decision = (line) => ({ kind: "exit", outcome: "value", value: "1", when: [], when_mode: "one", only_if: [], context: [], loop: null,
    on_error: null, thresholds: [], line, end_line: line });
const callable = (id, path, qualname, line, adapter_id) => ({ id, qualname, path, line, change: "added", counts: { added: 1 }, adapter_id,
    entries: [{ status: "added", decision: decision(line + 1), evidence: { level: "none", tests: [] } }] });
const quote = callable("symbol:quote", "shop/quote.py", "quote", 1, "python");
const ship = callable("symbol:ship", "shop/ship.py", "ship", 1, "python");
const card = callable("symbol:card", "web/card.ts", "Card", 1, "node");
const tests = [
    { id: "tests/test_quote.py::test_quote", link: "direct", name: "test_quote", path: "tests/test_quote.py", line: 1, callables: ["quote"], adapter_id: "python" },
    { id: "tests/test_ship.py::test_ship", link: "direct", name: "test_ship", path: "tests/test_ship.py", line: 1, callables: ["ship"], adapter_id: "python" },
    { id: "tests/test_ship.py::test_ship_names", link: "name-only", name: "test_ship_names", path: "tests/test_ship.py", line: 9, callables: ["ship"], adapter_id: "python" },
];
const map = { status: "complete", adapter_ids: ["python", "node"], callables: [quote, ship, card], verification: { tests } };

test("a layer's slice keeps its callables and the tests that reach them, and narrows languages", () => {
    const scoped = scopeDecisionMap(map, ["shop/quote.py"]);
    assert.deepEqual(scoped.callables.map((item) => item.id), ["symbol:quote"]);
    assert.deepEqual(scoped.verification.tests.map((item) => item.id), ["tests/test_quote.py::test_quote"]);
    assert.equal(scoped.adapter_id, "python", "a Python-only layer runs with the Python adapter even in a mixed review");
    assert.equal(scoped.adapter_ids, undefined);
    const byTestFile = scopeDecisionMap(map, ["tests/test_ship.py"]);
    assert.deepEqual(byTestFile.verification.tests.map((item) => item.id), ["tests/test_ship.py::test_ship", "tests/test_ship.py::test_ship_names"],
        "tests declared in the layer's own files belong to it");
    assert.equal(scopeDecisionMap({ status: "loading" }, ["x"]).status, "loading");
});

test("layer status reports not run, partial, passing, failing and stale states", () => {
    const paths = ["shop/quote.py", "shop/ship.py"];
    assert.deepEqual(layerTestStatus(map, null, paths), { state: "not-run", outcome: "not-run", linked: 2, ran: 0,
        counts: { passed: 0, failed: 0, error: 0, skipped: 0, not_run: 2 }, stale: false });
    const one = { status: "complete", tests: [{ id: "tests/test_quote.py::test_quote", outcome: "passed" }] };
    assert.equal(layerTestStatus(map, one, paths).state, "partial");
    const both = { ...one, tests: [...one.tests, { id: "tests/test_ship.py::test_ship[a]", outcome: "failed" }] };
    assert.equal(layerTestStatus(map, both, paths).state, "failing", "a failing parametrized case fails its linked test");
    assert.equal(layerTestStatus(map, { ...one, stale: true }, ["shop/quote.py"]).stale, true);
    assert.equal(layerTestStatus(map, null, ["web/card.ts"]).state, "none");
    assert.equal(layerTestStatus({ status: "loading" }, null, paths).state, "loading");
    assert.equal(layerTestStatus(map, { status: "running", scope: { paths: ["shop/ship.py"] } }, paths).state, "running");
});

test("layer runs accumulate: newer outcomes replace older ones and counts are recomputed", () => {
    const first = { status: "complete", tests: [{ id: "a", outcome: "failed" }, { id: "b", outcome: "passed" }],
        executed: { "x:1": [] }, ran: { x: 2 }, counts: { passed: 1, failed: 1, error: 0, skipped: 0 } };
    const second = { status: "complete", tests: [{ id: "a", outcome: "passed" }], executed: { "x:1": [{ id: "a", outcome: "passed" }] }, ran: { x: 1 } };
    const merged = mergeTestRuns(first, second, ["a"]);
    assert.deepEqual(merged.counts, { passed: 2, failed: 0, error: 0, skipped: 0 });
    assert.deepEqual(merged.executed["x:1"], [{ id: "a", outcome: "passed" }]);
    // xUnit names each result after its timestamped TRX file; a rerun still replaces the earlier result of that test.
    const trx = (stamp, outcome) => ({ id: `Demo.Tests.PolicyTests.Rejects[markruss_${stamp}_net10.0.trx:Rejects]`, outcome });
    const rerun = mergeTestRuns({ tests: [trx("14_43_06", "failed")] }, { tests: [trx("14_51_10", "passed")] }, ["Demo.Tests.PolicyTests.Rejects"]);
    assert.deepEqual(rerun.tests.map((test) => test.outcome), ["passed"], "a passing rerun clears an earlier failure");
    assert.equal(baseTestId("tests/t.py::test_counts[[1, 2, 3]]"), "tests/t.py::test_counts", "nested parametrize brackets");
    assert.equal(baseTestId("tests/t.py::test_x[a-[b]]"), "tests/t.py::test_x");
    assert.equal(linkedTestOutcome({ tests: [{ id: "tests/t.py::test_counts[[1, 2, 3]]", outcome: "failed" }] }, "tests/t.py::test_counts"), "failed");
});

function stubModel() {
    return {
        metadata: {}, summary: {}, nodes: [], edges: [], attention: [], coverage: {}, warnings: [], evidence: {},
        changes: ["shop/quote.py", "shop/ship.py", "tests/test_quote.py", "tests/test_ship.py"].map((path) => ({ path, status: "added", lines_added: 2, lines_removed: 0 })),
        source_files: {}, symbols: [
            { id: "symbol:quote", kind: "function", qualname: "quote", classification: "added", path: "shop/quote.py" },
            { id: "symbol:ship", kind: "function", qualname: "ship", classification: "added", path: "shop/ship.py" },
        ],
    };
}

test("verifying one layer runs only its linked tests, keeps earlier layers' results, and records each run", async () => {
    const pythonMap = { callables: [quote, ship].map(({ adapter_id, ...rest }) => rest), verification: { tests: tests.map(({ adapter_id, ...rest }) => rest) }, totals: {}, warnings: [] };
    const plans = [];
    let finish;
    const state = new ReviewState(process.cwd(), {
        readWorktreeFingerprint: null,
        runAnalyzer: async () => stubModel(),
        runDecisions: async () => pythonMap,
        runTests: (options) => {
            plans.push(options.plan.tests);
            return new Promise((resolve, reject) => {
                finish = resolve;
                options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
            });
        },
    });
    await state.refresh();
    await state.decisionMapFor();
    state.reviewTarget = { mode: "worktree" };
    state.worktreeChanged = false;
    const layerOne = { id: "layer:quote", name: "Quote rules", number: 1, paths: ["shop/quote.py", "tests/test_quote.py"] };
    const layerTwo = { id: "layer:ship", name: "Shipping", number: 2, paths: ["shop/ship.py"] };
    await assert.rejects(state.runLinkedTests({ layer: { ...layerOne, paths: ["elsewhere.py"] } }), /changed files from this review/);
    const plan = await state.testRunPlan({ layer: layerOne });
    assert.equal(plan.available, true, plan.reason);
    assert.deepEqual(plan.tests, ["tests/test_quote.py::test_quote"]);
    assert.deepEqual(plan.scope.paths, layerOne.paths);

    const running = await state.runLinkedTests({ layer: layerOne });
    assert.equal(running.scope.id, "layer:quote");
    assert.deepEqual(plans.at(-1), ["tests/test_quote.py::test_quote"], "only the layer's linked tests run");
    finish({ exit_code: 0, output: "1 passed", trace: { tests: {
        "tests/test_quote.py::test_quote": { outcome: "passed", lines: { [normalizePath(join(process.cwd(), "shop/quote.py"))]: [2] } } } } });
    await state.testRunPromise;
    assert.deepEqual(state.testRun.executed["symbol:quote:2"], [{ id: "tests/test_quote.py::test_quote", outcome: "passed" }]);

    await state.runLinkedTests({ layer: layerTwo });
    assert.deepEqual(plans.at(-1), ["tests/test_ship.py::test_ship"]);
    finish({ exit_code: 1, output: "1 failed", trace: { tests: { "tests/test_ship.py::test_ship": { outcome: "failed", lines: {} } } } });
    await state.testRunPromise;
    assert.deepEqual(state.testRun.counts, { passed: 1, failed: 1, error: 0, skipped: 0 }, "layer two's results join layer one's");
    assert.deepEqual(state.testRun.executed["symbol:quote:2"], [{ id: "tests/test_quote.py::test_quote", outcome: "passed" }]);
    assert.deepEqual(state.testRun.history.map((run) => [run.scope.id, run.status, run.counts.passed, run.counts.failed]),
        [["layer:quote", "complete", 1, 0], ["layer:ship", "complete", 0, 1]]);

    await state.runLinkedTests({ layer: layerOne });
    // While a run is in progress, results recorded before it stay visible to every layer and to the handoff.
    assert.equal(state.testRun.status, "running");
    assert.equal(layerTestStatus(state.decisionMap, state.testRun, layerTwo.paths).state, "failing");
    const rerunning = layerTestStatus(state.decisionMap, state.testRun, layerOne.paths);
    assert.deepEqual([rerunning.state, rerunning.outcome, rerunning.counts.passed], ["running", "passed", 1], "the layer being rerun keeps its earlier result");
    const midRun = createReviewHandoff({ ...state.model, metadata: { repo_root: "C:\\source\\shop", head_sha: "a".repeat(40), base_sha: "b".repeat(40) } },
        { mode: "commit", label: "Commit aaaaaaa", currentRef: "a".repeat(40), baseRef: "b".repeat(40) }, { entries: {}, cursor: null }, {
            testRun: state.testRun, decisionMap: state.decisionMap, layers: [{ ...layerOne, files: layerOne.paths }] }).markdown;
    assert.match(midRun, /Linked tests: 1 passed of 1 \(recorded before the run now in progress\)\./);
    assert.match(midRun, /A test run is in progress; these are the results recorded before it started\./);
    assert.equal(state.testRun.history.length, 2);
    state.cancelTestRun();
    assert.equal(state.testRun.status, "complete", "cancelling a layer run keeps the evidence earlier runs established");
    assert.deepEqual(state.testRun.counts, { passed: 1, failed: 1, error: 0, skipped: 0 });
    assert.equal(state.testRun.history.at(-1).status, "cancelled");
    assert.equal(state.testRun.history.at(-1).scope.id, "layer:quote");

    // A full run also builds on the history; cancelling it keeps everything.
    await state.runLinkedTests();
    state.cancelTestRun();
    assert.deepEqual(state.testRun.counts, { passed: 1, failed: 1, error: 0, skipped: 0 });
    assert.deepEqual(state.testRun.history.map((run) => run.scope?.id || "all"), ["layer:quote", "layer:ship", "layer:quote", "all"]);
    await state.runLinkedTests();
    assert.deepEqual(plans.at(-1), ["tests/test_quote.py::test_quote", "tests/test_ship.py::test_ship"]);
    finish({ exit_code: 0, output: "2 passed", trace: { tests: {
        "tests/test_quote.py::test_quote": { outcome: "passed", lines: {} }, "tests/test_ship.py::test_ship": { outcome: "passed", lines: {} } } } });
    await state.testRunPromise;
    assert.deepEqual(state.testRun.counts, { passed: 2, failed: 0, error: 0, skipped: 0 }, "a full rerun replaces each earlier result once");
    assert.equal(state.testRun.history.length, 5, "a full run keeps the layer history");
    // Reset to the state the handoff assertions below describe.
    await state.runLinkedTests({ layer: layerTwo });
    finish({ exit_code: 1, output: "1 failed", trace: { tests: { "tests/test_ship.py::test_ship": { outcome: "failed", lines: {} } } } });
    await state.testRunPromise;

    const head = "a".repeat(40), base = "b".repeat(40);
    const { markdown } = createReviewHandoff({ ...state.model, metadata: { repo_root: "C:\\source\\shop", head_sha: head, base_sha: base } },
        { mode: "commit", label: "Commit aaaaaaa", currentRef: head, baseRef: base }, { entries: {}, cursor: null }, {
        testRun: state.testRun, decisionMap: state.decisionMap,
        layers: [{ ...layerOne, files: layerOne.paths }, { ...layerTwo, files: layerTwo.paths }] });
    assert.match(markdown, /### 1\. Quote rules — 0\/2 reviewed[\s\S]*Linked tests: 1 passed of 1\./);
    assert.match(markdown, /### 2\. Shipping — 0\/1 reviewed[\s\S]*Linked tests: 1 failed of 1\./);
    assert.match(markdown, /Test runs in this review[\s\S]*Layer 1\. Quote rules: 1 passed · 1 linked test planned[\s\S]*Layer 2\. Shipping: 1 failed[\s\S]*Layer 1\. Quote rules: cancelled[\s\S]*All linked tests: cancelled[\s\S]*All linked tests: 2 passed/);
    await state.dispose();
});
