import { posix } from "node:path";

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;
const SCRIPT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"];

function lineOf(text, index) {
    let line = 1;
    for (let position = text.indexOf("\n"); position >= 0 && position < index; position = text.indexOf("\n", position + 1)) line++;
    return line;
}

// Relationships between changed files only, so reading order reflects this change rather than repository-wide history.
export function changedFileRelations(model) {
    const changed = (model?.changes || []).filter((change) => change.status !== "unchanged" && change.status !== "deleted" && change.status !== "removed");
    const paths = new Set(changed.map((change) => change.path));
    const withoutExtension = new Map();
    for (const path of paths) {
        const bare = path.replace(/\.[^./]+$/, "");
        withoutExtension.set(bare, [...withoutExtension.get(bare) || [], path]);
        if (/\/__init__$|\/index$/.test(bare)) {
            const folder = bare.replace(/\/(?:__init__|index)$/, "");
            withoutExtension.set(folder, [...withoutExtension.get(folder) || [], path]);
        }
    }
    const relations = new Map();
    const add = (from, to, kind, line) => {
        if (!from || !to || from === to || !paths.has(from) || !paths.has(to)) return;
        const key = `${from}\0${to}`;
        if (!relations.has(key)) relations.set(key, { from, to, kind, ...(line ? { line } : {}) });
    };
    const nodes = new Map((model?.nodes || []).map((node) => [node.id, node]));
    for (const edge of model?.edges || []) {
        if (!["calls", "imports", "inherits"].includes(edge.type)) continue;
        add(nodes.get(edge.source)?.path, nodes.get(edge.target)?.path, edge.type === "imports" ? "import" : "call");
    }
    // Python modules may be imported by a package-relative name (refchecker.utils.x) for src/refchecker/utils/x.py.
    const bySuffix = (module) => {
        const found = [];
        for (const [bare, targets] of withoutExtension) {
            if (bare === module || bare.endsWith(`/${module}`)) found.push(...targets);
        }
        return found.length === 1 || new Set(found).size === 1 ? found.slice(0, 1) : [];
    };
    for (const path of paths) {
        const text = model.source_files?.[path]?.current;
        if (typeof text !== "string" || text.length > 1_000_000) continue;
        if (path.endsWith(".py")) {
            const directory = posix.dirname(path);
            for (const match of text.matchAll(/^[ \t]*(?:from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([\w., \t()]+)|import[ \t]+([\w.]+))/gm)) {
                const line = lineOf(text, match.index);
                if (match[4]) { for (const target of bySuffix(match[4].replaceAll(".", "/"))) add(path, target, "import", line); continue; }
                const module = match[2].replaceAll(".", "/");
                const names = match[3].replace(/[()]/g, "").split(",").map((name) => name.trim().split(/\s+/)[0]).filter(Boolean);
                if (match[1]) {
                    let base = directory;
                    for (let level = 1; level < match[1].length; level++) base = posix.dirname(base);
                    const root = module ? posix.join(base, module) : base;
                    for (const candidate of [root, ...names.map((name) => posix.join(root, name))]) {
                        for (const target of withoutExtension.get(candidate) || []) add(path, target, "import", line);
                    }
                } else if (module) {
                    const targets = bySuffix(module);
                    if (targets.length) targets.forEach((target) => add(path, target, "import", line));
                    else for (const name of names) for (const target of bySuffix(`${module}/${name}`)) add(path, target, "import", line);
                }
            }
        } else if (SCRIPT.test(path)) {
            const directory = posix.dirname(path);
            for (const match of text.matchAll(/(?:\bfrom[ \t]*|\bimport[ \t]*\(?[ \t]*|\brequire[ \t]*\([ \t]*)["'](\.{1,2}\/[^"']+)["']/g)) {
                const resolved = posix.normalize(posix.join(directory, match[1])).replace(/\.[cm]?[jt]sx?$/i, "");
                const line = lineOf(text, match.index);
                for (const candidate of [resolved, ...SCRIPT_EXTENSIONS.map((extension) => `${resolved}/index${extension}`.replace(/\.[^./]+$/, ""))]) {
                    for (const target of withoutExtension.get(candidate) || []) add(path, target, "import", line);
                }
            }
        }
    }
    return [...relations.values()];
}
