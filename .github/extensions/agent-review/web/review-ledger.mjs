export const REVIEW_DISPOSITIONS = [
    ["pending", "Not reviewed"],
    ["reviewed", "Reviewed"],
    ["follow-up", "Needs follow-up"],
    ["accepted", "Accepted risk"],
    ["false-positive", "False positive"],
];

const validDispositions = new Set(REVIEW_DISPOSITIONS.map(([value]) => value));
const completedDispositions = new Set(["reviewed", "accepted", "false-positive"]);

function hashText(hash, text) {
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function reviewSnapshotKey(model, target) {
    if (model?.review_snapshot_key) return model.review_snapshot_key;
    const meta = model?.metadata || {};
    let hash = 2166136261;
    const changes = [...(model?.changes || [])].sort((a, b) => a.path.localeCompare(b.path));
    for (const change of changes) {
        const source = model?.source_files?.[change.path] || {};
        hash = hashText(hash, `${change.path}\0${change.status}\0${source.base || ""}\0${source.current || ""}\0`);
    }
    return `agent-review.ledger:${JSON.stringify([
        meta.repo_root,
        meta.base_sha,
        meta.head_sha,
        target?.mode,
        target?.ref || null,
        hash.toString(16).padStart(8, "0"),
    ])}`;
}

export function parseReviewLedger(value) {
    const parsed = value ? JSON.parse(value) : {};
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Saved review ledger is not an object.");
    const entries = new Map();
    for (const [id, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== "object" || !validDispositions.has(entry.disposition)) {
            throw new Error(`Invalid review ledger entry for ${id}.`);
        }
        if (entry.note != null && typeof entry.note !== "string") throw new Error(`Invalid review note for ${id}.`);
        entries.set(id, {
            disposition: entry.disposition,
            note: entry.note || "",
            path: typeof entry.path === "string" ? entry.path : "",
            line: Number.isInteger(entry.line) ? entry.line : null,
            updated_at: typeof entry.updated_at === "string" ? entry.updated_at : null,
        });
    }
    return entries;
}

export function serializeReviewLedger(entries) {
    return JSON.stringify(Object.fromEntries(entries), null, 0);
}

// One progress model: a priority item without its own triage inherits its file's whole-file decision.
export function effectiveDisposition(item, entries) {
    const own = entries.get(item.id)?.disposition;
    if (own && own !== "pending") return own;
    return (item.path && entries.get(fileReviewId(item.path))?.disposition) || "pending";
}

export function reviewProgress(plan, entries) {
    let completed = 0;
    let followUp = 0;
    for (const item of plan) {
        const disposition = effectiveDisposition(item, entries);
        if (completedDispositions.has(disposition)) completed += 1;
        if (disposition === "follow-up") followUp += 1;
    }
    return { completed, followUp, total: plan.length };
}

export function nextReviewItem(plan, entries) {
    return plan.find((item) => effectiveDisposition(item, entries) === "pending")
        || plan.find((item) => effectiveDisposition(item, entries) === "follow-up")
        || null;
}

export function isReviewComplete(disposition) {
    return completedDispositions.has(disposition);
}

export const fileReviewId = (path) => `review-file:${path}`;

const SET_ASIDE = new Set(["accepted", "false-positive"]);

// A concern's own triage, recorded on its planned unit (code or package) or on the concern itself.
export function concernTriage(finding, entries) {
    const packageId = finding.package_id || (String(finding.id || "").startsWith("package:") ? finding.id : null);
    for (const id of [finding.node_id && `review:${finding.node_id}`, packageId && `review:${packageId}`, finding.id, finding.id && `review:${finding.id}`]) {
        const disposition = id && entries.get(id)?.disposition;
        if (disposition && disposition !== "pending") return disposition;
    }
    return null;
}

// Accepted risks and false positives are set aside: not counted as active and not listed as open priorities.
export const isConcernSetAside = (finding, entries) => SET_ASIDE.has(concernTriage(finding, entries));

export function fileReviewProgress(model, entries) {
    const files = (model?.changes || []).filter((file) => file.status !== "unchanged");
    let reviewed = 0, followUp = 0;
    for (const file of files) {
        const disposition = entries.get(fileReviewId(file.path))?.disposition;
        if (disposition === "reviewed") reviewed++;
        if (disposition === "follow-up") followUp++;
    }
    return { total: files.length, reviewed, followUp, pending: files.length - reviewed - followUp };
}

export function nextFileReview(files, entries, current = null) {
    const target = typeof current === "string" ? { path: current, group: null } : current;
    let index = target ? files.findIndex((file) => file.path === target.path && file.group === target.group) : -1;
    if (index < 0 && target) index = files.findIndex((file) => file.path === target.path);
    const ordered = index >= 0 ? [...files.slice(index + 1), ...files.slice(0, index + 1)] : files;
    return ordered.find((file) => (entries.get(fileReviewId(file.path))?.disposition || "pending") === "pending")
        || ordered.find((file) => entries.get(fileReviewId(file.path))?.disposition === "follow-up") || null;
}
