import { parseAdoUrl, adoRepositoryLabel } from "./ado-provider.mjs";

export async function reviewRemotes(repoRoot, run) {
    const { stdout } = await run("git", ["-C", repoRoot, "remote", "-v"], {
        encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    const remotes = [];
    for (const line of stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
        if (!match) continue;
        const [, name, url] = match;
        const ado = parseAdoUrl(url, { repository: true });
        if (ado) {
            remotes.push({ name, ...ado, label: `Azure DevOps · ${adoRepositoryLabel(ado)}` });
            continue;
        }
        const github = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);
        if (github) remotes.push({ name, provider: "github", repository: github[1], label: `GitHub · ${github[1]}` });
    }
    return remotes;
}

export function selectReviewRemote(remotes, name) {
    if (name) {
        const selected = remotes.find((remote) => remote.name === name);
        if (!selected) throw new Error("The selected PR remote is no longer available. Refresh the list.");
        return selected;
    }
    return remotes.find((remote) => remote.name === "origin") || (remotes.length === 1 ? remotes[0] : null);
}
