import { execFile } from "node:child_process";
import { mkdir, lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { adoRepositoryLabel, adoRepositoryUrl, createAdoClient, getAdoPullRequest, parseAdoUrl } from "./ado-provider.mjs";
import { resolveReviewTarget } from "./review-target.mjs";

const execute = promisify(execFile);

export async function cloneAdoReview({ prUrl, destination }, {
    run = execute, adoClient = createAdoClient(), onProgress = () => {},
} = {}) {
    const input = parseAdoUrl(prUrl);
    if (!input) throw new Error("Enter an Azure DevOps Services PR URL.");
    if (typeof destination !== "string" || !isAbsolute(destination.trim())) throw new Error("Choose an absolute path for a new clone destination.");
    const repoPath = resolve(destination.trim());
    if (!(await lstat(dirname(repoPath))).isDirectory()) throw new Error("The clone destination's parent must be an existing directory.");
    try {
        await lstat(repoPath);
        throw new Error("The clone destination already exists. Choose a new directory; existing files are never overwritten.");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    onProgress({ phase: "metadata", message: "Loading Azure DevOps PR metadata..." });
    const { repo } = await getAdoPullRequest(input, adoClient);
    // Reserve the exact destination atomically; never delete it on a failed operation.
    try { await mkdir(repoPath); }
    catch (error) {
        if (error.code === "EEXIST") throw new Error("The clone destination now exists. Choose a new directory.");
        throw error;
    }
    let cloned = false;
    try {
        onProgress({ phase: "cloning", message: `Cloning ${adoRepositoryLabel(repo)} into ${repoPath}...` });
        await run("git", ["clone", "--no-tags", "--no-recurse-submodules", "--", adoRepositoryUrl(repo), repoPath], {
            encoding: "utf8", timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
        });
        cloned = true;
        onProgress({ phase: "fetching", message: `Loading the pinned PR snapshot in ${repoPath}...` });
        const target = await resolveReviewTarget(repoPath, { mode: "pr", ref: prUrl, remote: "origin" }, run, { adoClient });
        return { repoPath, target };
    } catch (error) {
        throw new Error(`${cloned ? `The repository was cloned, but its PR snapshot could not be loaded: ${error.message}`
            : "Cloning failed. Check your Git credentials and connection; Azure CLI sign-in does not configure Git."} ${
            cloned ? "The clone remains" : "An incomplete clone may remain"} at ${repoPath}. Nothing was deleted or overwritten. Open that folder locally to retry, or choose a new destination.`);
    }
}
