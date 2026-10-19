export function workspaceNavigation(model, data) {
    const files = (model?.changes || []).filter((change) => change.status !== "unchanged");
    const paths = new Set(files.map((file) => file.path));
    const byPath = new Map(files.map((file) => [file.path, file]));
    const groups = [];
    const represented = new Set();
    for (const section of data?.sections || []) {
        if (section.kind !== "behavior") continue;
        const members = [...new Set(section.ranges.map((range) => range.path))].filter((path) => paths.has(path));
        if (!members.length) continue;
        members.forEach((path) => represented.add(path));
        groups.push({ id: section.id, title: section.title, section,
            files: members.map((path) => byPath.get(path)) });
    }
    const supporting = files.filter((file) => !represented.has(file.path));
    if (supporting.length) groups.push({ id: "workspace:supporting", title: groups.length ? "Supporting files" : "Changed files",
        files: supporting, section: null });
    return { files, groups };
}

export function groupForSource(navigation, source, preferred = null) {
    const owns = (group) => group.files.some((file) => file.path === source?.path);
    const existing = navigation.groups.find((group) => group.id === preferred && owns(group));
    const matches = (group) => owns(group) && (!group.section || group.section.ranges.some((range) => range.path === source?.path
        && range.side === (source.focus_side || "current") && source.start_line >= range.line && source.start_line <= range.end_line));
    if (Number.isInteger(source?.start_line) && source.start_line > 0) {
        return existing && matches(existing) ? existing : navigation.groups.find(matches) || null;
    }
    return existing || navigation.groups.find(owns) || null;
}

export function fileTree(files) {
    const root = { directories: new Map(), files: [] };
    for (const file of files) {
        const parts = file.path.split("/");
        let node = root, prefix = "";
        for (const part of parts.slice(0, -1)) {
            prefix = prefix ? `${prefix}/${part}` : part;
            if (!node.directories.has(part)) node.directories.set(part, { name: part, path: prefix, directories: new Map(), files: [] });
            node = node.directories.get(part);
        }
        node.files.push(file);
    }
    return root;
}

export function treeOrder(tree) {
    return [...[...tree.directories.values()].sort((a, b) => a.name.localeCompare(b.name)).flatMap(treeOrder), ...tree.files];
}

// The order a reviewer sees in the rail: groups top to bottom, each group's folder tree as rendered.
export function reviewSequence(navigation, mode = "groups") {
    if (mode === "files") return treeOrder(fileTree(navigation.files)).map((file) => ({ path: file.path, group: null, file }));
    return navigation.groups.flatMap((group) => treeOrder(fileTree(group.files)).map((file) => ({ path: file.path, group: group.id, file })));
}
