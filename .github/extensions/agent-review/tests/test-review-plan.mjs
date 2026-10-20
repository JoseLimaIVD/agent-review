import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPlan, concernPriorities } from "../web/review-plan.mjs";
import { concernTriage, isConcernSetAside } from "../web/review-ledger.mjs";

test("a concern has one priority: its planned unit's score, else its static impact", () => {
    const plan = [{ node: { id: "n1" }, score: 100 }, { package: { id: "package:npm:x" }, score: 52 }];
    plan.units = plan;
    const priority = concernPriorities(plan);
    assert.equal(priority({ node_id: "n1", impact_score: 84 }), 100);
    assert.equal(priority({ package_id: "package:npm:x", impact_score: 40 }), 52);
    assert.equal(priority({ id: "package:npm:x", impact_score: 40 }), 52);
    assert.equal(priority({ node_id: "other", impact_score: 68 }), 68);
    assert.equal(priority({ title: "no score" }), null);
});

test("concern triage is read from the planned unit and only accepted risks and false positives are set aside", () => {
    const entries = new Map([["review:n1", { disposition: "accepted" }], ["review:package:npm:x", { disposition: "follow-up" }],
        ["review:n3", { disposition: "pending" }]]);
    assert.equal(concernTriage({ node_id: "n1" }, entries), "accepted");
    assert.equal(isConcernSetAside({ node_id: "n1" }, entries), true);
    assert.equal(concernTriage({ package_id: "package:npm:x" }, entries), "follow-up");
    assert.equal(isConcernSetAside({ package_id: "package:npm:x" }, entries), false, "follow-up stays active");
    assert.equal(concernTriage({ node_id: "n3" }, entries), null, "an explicit Not triaged is no triage");
});

const node = {
    id: "resolver",
    kind: "function",
    name: "resolveReference",
    path: "src/resolver.js",
    start_line: 1,
    metrics: { lines_changed: 6, direct_callers: 2, transitive_callers: 1 },
};
const callable = {
    id: node.id,
    qualname: node.name,
    path: node.path,
    line: 1,
    entries: [
        { status: "added", decision: { line: 3 }, evidence: { level: "asserted", tests: [{ id: "test::empty" }] } },
        { status: "added", decision: { line: 6 }, evidence: { level: "exercised", tests: [{ id: "test::legacy" }] } },
    ],
};
const model = {
    nodes: [node],
    package_changes: [{
        id: "package:npm:colors",
        name: "colors",
        change: "added",
        usage_locations: ["src/view.js:2"],
        declared_current: [{ source: "package.json" }],
    }],
};
const findings = [
    { id: "complexity", node_id: node.id, type: "complexity", title: "Complexity increased", impact_score: 68 },
    { id: "dependency", package_id: "package:npm:colors", title: "Dependency added", impact_score: 62 },
];
const decisionMap = { status: "complete", callables: [callable] };

test("review plan combines static impact, reach, churn, and inferred evidence gaps", () => {
    const plan = buildReviewPlan(model, decisionMap, null, findings);
    assert.deepEqual(plan.map((item) => item.title), ["resolveReference", "colors"]);
    assert.ok(plan[0].score > 62);
    assert.deepEqual(plan[0].evidence, {
        confirmed: 0,
        inferred: 2,
        untested: 0,
        entries: plan[0].evidence.entries,
    });
    assert.match(plan[0].reasons.join(" · "), /2 inferred paths.*3 callers.*6 changed lines/);
});

test("review plan reranks from actual linked-test evidence", () => {
    const run = {
        status: "complete",
        stale: false,
        ran: { resolver: 1 },
        executed: {
            "resolver:3": [{ id: "test::empty", outcome: "passed" }],
            "resolver:6": [],
        },
    };
    const [resolver] = buildReviewPlan(model, decisionMap, run, findings);
    assert.equal(resolver.evidence.confirmed, 1);
    assert.equal(resolver.evidence.untested, 1);
    assert.equal(resolver.preferred.entry.decision.line, 6);
    assert.match(resolver.reasons[0], /1 untested path/);
});

test("simple low-churn changes do not become review items solely because evidence is absent", () => {
    const simpleNode = {
        id: "simple",
        kind: "function",
        name: "renameLabel",
        path: "src/label.js",
        start_line: 1,
        metrics: { lines_changed: 5, direct_callers: 0, transitive_callers: 0 },
    };
    const simpleMap = { status: "complete", callables: [{
        id: simpleNode.id,
        qualname: simpleNode.name,
        path: simpleNode.path,
        entries: [{ status: "changed", decision: { line: 3 }, evidence: { level: "none", tests: [] } }],
    }] };
    assert.equal(buildReviewPlan(
        { nodes: [simpleNode], package_changes: [] },
        simpleMap,
        null,
        [],
    ).length, 0);
});

test("meaningful absolute churn or several untested paths can qualify without a rule finding", () => {
    const changed = {
        id: "large",
        kind: "function",
        name: "rewritePipeline",
        path: "src/pipeline.js",
        metrics: { lines_changed: 55, direct_callers: 0, transitive_callers: 0 },
    };
    const plan = buildReviewPlan({ nodes: [changed], package_changes: [] }, {
        status: "complete",
        callables: [{
            id: changed.id,
            qualname: changed.name,
            path: changed.path,
            entries: [{ status: "changed", decision: { line: 1 }, evidence: { level: "none", tests: [] } }],
        }],
    }, null, []);
    assert.deepEqual(plan.map((item) => item.title), ["rewritePipeline"]);
    assert.ok(plan[0].score >= 55);
});

test("ordinary and transitive version bumps stay in package details but out of the focused plan", () => {
    const packages = [
        {
            id: "package:npm:axios",
            name: "axios",
            change: "modified",
            resolved_current: "1.20.0",
            declared_base: [{ resolved_version: "1.18.1", group: "runtime" }],
            declared_current: [{ resolved_version: "1.20.0", group: "runtime" }],
        },
        {
            id: "package:npm:source-map-js",
            name: "source-map-js",
            change: "modified",
            resolved_current: "1.2.2",
            declared_base: [{ resolved_version: "1.2.1", group: "transitive", transitive: true }],
            declared_current: [{ resolved_version: "1.2.2", group: "transitive", transitive: true }],
        },
    ];
    const packageFindings = packages.map((item) => ({
        id: `finding:${item.name}`,
        package_id: item.id,
        title: "Package dependency modified",
        impact_score: 48,
    }));
    assert.equal(buildReviewPlan(
        { nodes: [], package_changes: packages },
        { status: "complete", callables: [] },
        null,
        packageFindings,
    ).length, 0);
});

test("focused plan is capped and reports additional qualifying changes", () => {
    const nodes = Array.from({ length: 35 }, (_, index) => ({
        id: `node:${index}`,
        kind: "function",
        name: `changed${index}`,
        path: `src/changed${index}.js`,
        metrics: { lines_changed: 10, direct_callers: 0, transitive_callers: 0 },
    }));
    const findings = nodes.map((item) => ({
        id: `finding:${item.id}`,
        node_id: item.id,
        title: "Public callable contract changed",
        impact_score: 70,
    }));
    const plan = buildReviewPlan(
        { nodes, package_changes: [] },
        { status: "complete", callables: [] },
        null,
        findings,
    );
    assert.equal(plan.length, 15);
    assert.equal(plan.omitted, 20);
    assert.equal(plan.qualifying, 35);
});
