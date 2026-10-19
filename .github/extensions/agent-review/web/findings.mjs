export function findingsForNode(model, node, findings) {
    const nodes = new Map(model.nodes.map((item) => [item.id, item]));
    return findings.filter((finding) => {
        const target = nodes.get(finding.node_id);
        return target && (node.id === target.id
            || (node.kind === "module" && target.module_id === node.id)
            || (node.kind === "component" && target.component_id === node.id));
    });
}

export function findingKey(finding) {
    return JSON.stringify([finding.id, [...(finding.evidence_ids || [])].sort(), [...(finding.related_findings || [])].sort()]);
}

export function isFindingClosed(finding, closedKeys) {
    return (finding.members || [finding]).every((item) => closedKeys.has(findingKey(item)));
}

export function orderFindings(findings, closedKeys) {
    return [...findings].sort((a, b) => Number(isFindingClosed(a, closedKeys)) - Number(isFindingClosed(b, closedKeys))
        || (b.impact_score || 0) - (a.impact_score || 0));
}

export function groupFindings(items) {
    const groups = new Map();
    for (const item of items) {
        const key = item.node_id ? `node:${item.node_id}` : item.edge_id ? `edge:${item.edge_id}` : item.id;
        const existing = groups.get(key);
        if (!existing) {
            groups.set(key, { ...item, evidence_ids: [...(item.evidence_ids || [])], impact_factors: [...(item.impact_factors || [])], related_findings: [item.type] });
            continue;
        }
        existing.evidence_ids = [...new Set([...existing.evidence_ids, ...(item.evidence_ids || [])])];
        existing.impact_factors = [...new Set([...existing.impact_factors, ...(item.impact_factors || [])])];
        existing.related_findings = [...new Set([...existing.related_findings, item.type])];
        if ((item.impact_score || 0) > (existing.impact_score || 0)) {
            existing.type = item.type;
            existing.title = item.title;
            existing.reason = item.reason;
            existing.severity = item.severity;
            existing.impact_score = item.impact_score;
        }
    }
    return [...groups.values()].map((item) => {
        if (item.related_findings.length > 1) {
            item.reason = `${item.reason} Also flagged for ${item.related_findings.filter((type) => type !== item.type).join(", ").replaceAll("_", " ")}.`;
        }
        return item;
    }).sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0));
}
