import { pathEvidence } from "./decision-map.mjs";
import { countLabel } from "./count-format.mjs";

const MIN_FINDING_SCORE = 65;
const MAX_REVIEW_ITEMS = 15;

const evidenceGroup = (evidence) => evidence?.level === "confirmed"
    ? "confirmed"
    : ["asserted", "exercised", "reachable", "possible"].includes(evidence?.level)
        ? "inferred"
        : "untested";

function nodeChurn(node) {
    return node?.metrics?.lines_changed
        ?? ((node?.metrics?.lines_added || 0) + (node?.metrics?.lines_removed || 0));
}

function nodeCallers(node) {
    return (node?.metrics?.direct_callers || 0) + (node?.metrics?.transitive_callers || 0);
}

function nodeQualification(node, staticScore, evidence) {
    const churn = nodeChurn(node);
    const callers = nodeCallers(node);
    const complexityDelta = Number(node?.metrics?.complexity_current) - Number(node?.metrics?.complexity_base);
    if (staticScore >= MIN_FINDING_SCORE) return { eligible: true, floor: staticScore };
    if (complexityDelta >= 2 && (callers >= 3 || churn >= 10)) return { eligible: true, floor: 65 };
    if (churn >= 50) return { eligible: true, floor: 60 };
    if ((callers >= 10 && churn >= 3) || (callers >= 5 && churn >= 10)) {
        return { eligible: true, floor: 60 };
    }
    if (evidence.untested >= 3 && churn >= 15) return { eligible: true, floor: 50 };
    return { eligible: false, floor: 0 };
}

function scoreNode(node, qualification, evidence) {
    const churn = nodeChurn(node);
    const callers = nodeCallers(node);
    const evidenceGap = Math.min(18, evidence.untested * 6 + evidence.inferred * 2);
    const churnWeight = churn >= 10 ? Math.min(12, Math.ceil(Math.log2(churn + 1) * 2)) : 0;
    const reachWeight = callers >= 3 ? Math.min(12, callers * 2) : 0;
    return Math.min(100, qualification.floor + evidenceGap + churnWeight + reachWeight);
}

function evidenceSummary(callable, run) {
    const summary = { confirmed: 0, inferred: 0, untested: 0, entries: [] };
    for (const entry of callable.entries || []) {
        const evidence = pathEvidence(callable, entry, run);
        if (!evidence) continue;
        const group = evidenceGroup(evidence);
        summary[group] += 1;
        summary.entries.push({ entry, evidence, group });
    }
    return summary;
}

function planReasons(node, evidence, findings) {
    const reasons = [];
    const callers = nodeCallers(node);
    const churn = nodeChurn(node);
    if (evidence.untested) reasons.push(countLabel(evidence.untested, "untested path"));
    if (evidence.inferred) reasons.push(countLabel(evidence.inferred, "inferred path"));
    if (callers) reasons.push(node?.metrics?.transitive_callers
        ? `${countLabel(callers, "caller")} incl. transitive` : countLabel(callers, "caller"));
    if (churn) reasons.push(countLabel(churn, "changed line"));
    for (const finding of findings) {
        if (finding.title && !reasons.includes(finding.title)) reasons.push(finding.title);
    }
    return reasons.slice(0, 4);
}

function preferredEntry(evidence) {
    return evidence.entries.find((item) => item.group === "untested")
        || evidence.entries.find((item) => item.group === "inferred")
        || evidence.entries[0]
        || null;
}

export function buildReviewPlan(model, decisionMap, testRun, findings = []) {
    if (!model) return [];
    const nodes = new Map((model.nodes || []).map((node) => [node.id, node]));
    const findingsByNode = new Map();
    const packageFindings = new Map();
    for (const finding of findings) {
        if (finding.node_id) {
            const items = findingsByNode.get(finding.node_id) || [];
            items.push(finding);
            findingsByNode.set(finding.node_id, items);
        }
        if (finding.package_id) packageFindings.set(finding.package_id, finding);
    }

    const units = [];
    const callableIds = new Set();
    for (const callable of decisionMap?.status === "complete" ? decisionMap.callables || [] : []) {
        const node = nodes.get(callable.id);
        if (!node) continue;
        callableIds.add(callable.id);
        const nodeFindings = findingsByNode.get(callable.id) || [];
        const evidence = evidenceSummary(callable, testRun);
        const staticScore = Math.max(0, ...nodeFindings.map((finding) => finding.impact_score || 0));
        const qualification = nodeQualification(node, staticScore, evidence);
        if (!qualification.eligible) continue;
        units.push({
            id: `review:${callable.id}`,
            kind: "callable",
            title: callable.qualname || node.display_name || node.name || callable.id,
            path: callable.path || node.path,
            line: callable.line || node.start_line,
            score: scoreNode(node, qualification, evidence),
            reasons: planReasons(node, evidence, nodeFindings),
            evidence,
            finding: nodeFindings[0] || null,
            findingTypes: [...new Set(nodeFindings.map((finding) => finding.type).filter(Boolean))],
            node,
            callable,
            preferred: preferredEntry(evidence),
        });
    }

    for (const [nodeId, nodeFindings] of findingsByNode) {
        if (callableIds.has(nodeId)) continue;
        const node = nodes.get(nodeId);
        if (!node) continue;
        const staticScore = Math.max(0, ...nodeFindings.map((finding) => finding.impact_score || 0));
        const evidence = { confirmed: 0, inferred: 0, untested: 0, entries: [] };
        const qualification = nodeQualification(node, staticScore, evidence);
        if (!qualification.eligible) continue;
        units.push({
            id: `review:${nodeId}`,
            kind: "node",
            title: node.display_name || node.name || nodeId,
            path: node.path,
            line: node.start_line,
            score: scoreNode(node, qualification, evidence),
            reasons: planReasons(node, evidence, nodeFindings),
            evidence,
            finding: nodeFindings[0],
            findingTypes: [...new Set(nodeFindings.map((finding) => finding.type).filter(Boolean))],
            node,
        });
    }

    for (const item of model.package_changes || []) {
        const finding = packageFindings.get(item.id);
        const declarations = item.declared_current?.length ? item.declared_current : item.declared_base || [];
        const direct = declarations.some((entry) => !entry.transitive);
        const runtime = declarations.some((entry) => ["runtime", "optional"].includes(entry.group));
        const major = (() => {
            const before = item.declared_base?.[0]?.resolved_version;
            const current = item.resolved_current;
            if (!before || !current) return false;
            const oldMajor = Number.parseInt(String(before).replace(/^v/, "").split(".")[0], 10);
            const newMajor = Number.parseInt(String(current).replace(/^v/, "").split(".")[0], 10);
            return Number.isInteger(oldMajor) && Number.isInteger(newMajor) && oldMajor !== newMajor;
        })();
        if (!direct || !(item.change === "added" || (item.change === "removed" && runtime) || major)) continue;
        const score = finding?.impact_score || (item.change === "added" ? 45 : 35);
        const usageCount = item.usage_locations?.length || 0;
        units.push({
            id: `review:${item.id}`,
            kind: "package",
            title: item.name,
            path: item.declared_current?.[0]?.source || item.declared_base?.[0]?.source,
            score,
            reasons: [
                `${item.change} dependency`,
                usageCount ? countLabel(usageCount, "usage location") : "no resolved usage",
            ],
            evidence: { confirmed: 0, inferred: 0, untested: 0, entries: [] },
            finding: finding || null,
            package: item,
        });
    }

    const callableUnits = units.filter((item) => item.kind === "callable");
    const focused = units.filter((item) => {
        if (item.kind !== "node" || !["module", "class"].includes(item.node?.kind)) return true;
        const aggregateOnly = item.findingTypes.length > 0
            && item.findingTypes.every((type) => ["size", "complexity", "new_complexity"].includes(type));
        if (!aggregateOnly) return true;
        return !callableUnits.some((candidate) =>
            candidate.path === item.path
            && (!item.node.start_line || !candidate.line
                || (candidate.line >= item.node.start_line && candidate.line <= (item.node.end_line || candidate.line))));
    });
    const ordered = focused.sort((a, b) => b.score - a.score
        || (b.evidence.untested - a.evidence.untested)
        || String(a.path || a.title).localeCompare(String(b.path || b.title)));
    const plan = ordered.slice(0, MAX_REVIEW_ITEMS);
    plan.omitted = Math.max(0, ordered.length - plan.length);
    plan.qualifying = ordered.length;
    plan.units = units;
    return plan;
}

// One priority per concern, shown identically everywhere: the planned unit's score when the concern's code or package is
// planned, otherwise the analyzer's static impact for that concern.
export function concernPriorities(plan) {
    const byNode = new Map();
    const byPackage = new Map();
    for (const unit of plan.units || plan) {
        if (unit.node?.id) byNode.set(unit.node.id, Math.max(unit.score, byNode.get(unit.node.id) ?? -1));
        if (unit.package?.id) byPackage.set(unit.package.id, unit.score);
    }
    return (finding) => {
        const packageId = finding.package_id || (String(finding.id || "").startsWith("package:") ? finding.id : null);
        return byNode.get(finding.node_id) ?? (packageId ? byPackage.get(packageId) : undefined) ?? finding.impact_score ?? null;
    };
}
