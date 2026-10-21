import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGitHub } from "./review-handoff.mjs";

// Line comments drafted in Agent Review and posted to GitHub as one review. Drafts are local until the reviewer submits.
export const REVIEW_EVENTS = { COMMENT: "COMMENTED", APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" };
const MAX_COMMENTS = 200;
const MAX_BODY = 4000;

export function parsePullRequestUrl(url) {
    const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(url || "");
    if (!match) throw new Error("A GitHub pull request URL is required.");
    return { owner: match[1], name: match[2], repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

// GitHub accepts review comments only on lines inside a diff hunk: RIGHT for added or context lines of the head, LEFT for
// removed or context lines of the base.
export function commentableLines(diff) {
    const right = new Set(), left = new Set();
    let oldLine = 0, newLine = 0, inHunk = false;
    for (const line of String(diff || "").split(/\r?\n/)) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
        if (!inHunk || /^(diff --git |index |--- |\+\+\+ |\\ )/.test(line)) continue;
        if (line.startsWith("+")) right.add(newLine++);
        else if (line.startsWith("-")) left.add(oldLine++);
        else if (line.startsWith(" ")) { left.add(oldLine++); right.add(newLine++); }
    }
    return { RIGHT: right, LEFT: left };
}

// `githubLines` (path -> {RIGHT, LEFT} sets from the PR's own patches) overrides the saved diff on a pull request:
// GitHub anchors comments only within its own three-line-context hunks, which can be narrower than the saved diff.
export function validateDraftComment(comment, model, githubLines = null) {
    const body = typeof comment?.body === "string" ? comment.body.trim() : "";
    const side = comment?.side === "LEFT" ? "LEFT" : comment?.side === "RIGHT" ? "RIGHT" : null;
    if (!body || body.length > MAX_BODY) throw new Error(`A comment needs 1-${MAX_BODY} characters.`);
    if (typeof comment.path !== "string" || !Number.isSafeInteger(comment.line) || comment.line < 1 || !side) {
        throw new Error("A comment needs a changed file, a line and a side.");
    }
    const change = (model?.changes || []).find((item) => item.path === comment.path && item.status !== "unchanged");
    if (!change) throw new Error(`${comment.path} is not a changed file in this review.`);
    const lines = githubLines ? githubLines[comment.path] || { RIGHT: new Set(), LEFT: new Set() } : commentableLines(model.source_files?.[comment.path]?.diff);
    if (!lines[side].has(comment.line)) {
        throw new Error(`${comment.path}:${comment.line}${side === "LEFT" ? " (base)" : ""} is outside ${githubLines ? "the pull request's diff on GitHub" : "the diff"}, so GitHub cannot anchor a comment there. Comment on a changed or nearby line.`);
    }
    return { path: comment.path, line: comment.line, side, body };
}

// The lines GitHub will accept review comments on, per file, from the pull request's own patches.
export async function pullRequestCommentableLines(url, cwd, run = runGitHub) {
    const { repo, number } = parsePullRequestUrl(url);
    const files = [];
    for (let page = 1; page <= 30; page++) {
        const batch = await run(["api", `repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`], null, cwd);
        if (!Array.isArray(batch)) throw new Error("GitHub returned unexpected pull request files.");
        files.push(...batch);
        if (batch.length < 100) break;
    }
    return Object.fromEntries(files.map((file) => [file.filename, commentableLines(file.patch || "")]));
}

export class ReviewDraftStore {
    constructor(workspacePath) {
        this.directory = workspacePath ? join(workspacePath, "files", "agent-review-pr-drafts") : null;
        this.records = new Map();
        this.writes = new Map();
    }

    file(snapshot) {
        return join(this.directory, `${createHash("sha256").update(snapshot).digest("hex")}.json`);
    }

    async read(snapshot) {
        let value = this.records.get(snapshot) || { version: 1, snapshot, revision: 0, comments: [] };
        if (this.directory) {
            try { value = JSON.parse(await readFile(this.file(snapshot), "utf8")); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        if (value.version !== 1 || value.snapshot !== snapshot || !Array.isArray(value.comments)) throw new Error("Saved review drafts do not match this snapshot.");
        return { ...value, durable: Boolean(this.directory) };
    }

    // Applies one change (add, edit, delete or clear) against the expected revision so two tabs cannot silently overwrite.
    async update(snapshot, revision, change) {
        const write = async () => {
            const current = await this.read(snapshot);
            if (current.revision !== revision) {
                const error = new Error("Review drafts changed in another tab. Reload them before retrying; your text is kept.");
                error.code = "review_draft_conflict";
                throw error;
            }
            let comments = [...current.comments];
            const now = new Date().toISOString();
            if (change.action === "add") {
                if (comments.length >= MAX_COMMENTS) throw new Error(`A review can hold at most ${MAX_COMMENTS} comments.`);
                comments.push({ id: randomUUID(), ...change.comment, created_at: now, updated_at: now });
            } else if (change.action === "edit") {
                const index = comments.findIndex((item) => item.id === change.id);
                if (index < 0) throw new Error("That draft comment no longer exists.");
                comments[index] = { ...comments[index], body: change.body, updated_at: now };
            } else if (change.action === "delete") {
                comments = comments.filter((item) => item.id !== change.id);
            } else if (change.action === "clear") comments = [];
            else throw new Error("Unknown draft change.");
            const value = { version: 1, snapshot, revision: revision + 1, comments, updated_at: now };
            if (this.directory) {
                await mkdir(this.directory, { recursive: true });
                const path = this.file(snapshot);
                const temporary = `${path}.${randomUUID()}.tmp`;
                try { await writeFile(temporary, JSON.stringify(value)); await rename(temporary, path); }
                finally { await rm(temporary, { force: true }); }
            } else this.records.set(snapshot, value);
            return { ...value, durable: Boolean(this.directory) };
        };
        const previous = this.writes.get(snapshot) || Promise.resolve();
        const pending = previous.then(write, write);
        this.writes.set(snapshot, pending);
        try { return await pending; }
        finally { if (this.writes.get(snapshot) === pending) this.writes.delete(snapshot); }
    }
}

// Existing review threads on the PR, anchored to their current head lines (outdated comments keep their original line).
export async function pullRequestThreads(url, cwd, run = runGitHub) {
    const { repo, number } = parsePullRequestUrl(url);
    const comments = [];
    for (let page = 1; page <= 5; page++) {
        const batch = await run(["api", `repos/${repo}/pulls/${number}/comments?per_page=100&page=${page}`], null, cwd);
        if (!Array.isArray(batch)) throw new Error("GitHub returned unexpected review comments.");
        comments.push(...batch);
        if (batch.length < 100) break;
    }
    return comments.map((comment) => ({
        id: comment.id, reply_to: comment.in_reply_to_id || null, path: comment.path,
        line: comment.line ?? null, original_line: comment.original_line ?? null, side: comment.side || "RIGHT",
        commit: comment.commit_id || null, original_commit: comment.original_commit_id || null,
        outdated: comment.line == null, body: String(comment.body || ""), author: comment.user?.login || "unknown",
        created_at: comment.created_at, url: comment.html_url,
    }));
}

const VIEWED_QUERY = "query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){id author{login} headRefOid state files(first:100){nodes{path viewerViewedState}}}}}";

export async function pullRequestState(url, cwd, run = runGitHub) {
    const { owner, name, number } = parsePullRequestUrl(url);
    const result = await run(["api", "graphql", "-f", `query=${VIEWED_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], null, cwd);
    const pr = result?.data?.repository?.pullRequest;
    if (!pr?.id) throw new Error("GitHub did not return this pull request.");
    return { id: pr.id, author: pr.author?.login || null, viewer: result.data.viewer?.login || null, head: pr.headRefOid, state: pr.state,
        viewed: Object.fromEntries((pr.files?.nodes || []).map((file) => [file.path, file.viewerViewedState === "VIEWED"])) };
}

export async function setFileViewed({ url, pullRequestId, path, viewed }, cwd, run = runGitHub) {
    parsePullRequestUrl(url);
    if (typeof pullRequestId !== "string" || !pullRequestId || typeof path !== "string" || !path) throw new Error("A pull request and file are required.");
    const mutation = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
    const result = await run(["api", "graphql", "-f", `query=mutation($id:ID!,$path:String!){${mutation}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`,
        "-f", `id=${pullRequestId}`, "-f", `path=${path}`], null, cwd);
    if (result?.errors?.length) throw new Error(result.errors[0].message || "GitHub rejected the Viewed change.");
    return { path, viewed };
}

// Posts the reviewer's verdict and line comments as one review under their own GitHub identity.
export async function submitPullRequestReview({ url, commit, event, body, comments = [] }, cwd, run = runGitHub) {
    const { repo, number } = parsePullRequestUrl(url);
    if (!REVIEW_EVENTS[event]) throw new Error("Choose Comment, Approve or Request changes.");
    if (!/^[a-f0-9]{40,64}$/i.test(commit || "")) throw new Error("An immutable head commit is required.");
    const text = typeof body === "string" ? body.trim() : "";
    if (text.length > 60_000) throw new Error("The review summary exceeds GitHub's size limit.");
    if (!text && event !== "APPROVE" && !comments.length) throw new Error("Write a summary or add line comments before submitting.");
    const state = await pullRequestState(url, cwd, run);
    if (state.head !== commit || state.state !== "OPEN") throw new Error("The PR head changed or is not open. Refresh the review and try again; nothing was submitted.");
    if (event !== "COMMENT" && state.author && state.author === state.viewer) {
        throw new Error(`GitHub does not allow ${event === "APPROVE" ? "approving" : "requesting changes on"} your own pull request. Submit as a comment instead; nothing was submitted.`);
    }
    const payload = { commit_id: commit, event, ...(text ? { body: text } : {}),
        comments: comments.map(({ path, line, side, body: comment }) => ({ path, line, side, body: comment })) };
    let result;
    try {
        result = await run(["api", "--method", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"], JSON.stringify(payload), cwd);
    } catch (error) {
        throw new Error(`Submission failed or its outcome is unknown. Check the PR before submitting again: ${error.message}`);
    }
    if (result?.state !== REVIEW_EVENTS[event] || result.commit_id !== commit || !Number.isInteger(result.id)) {
        throw new Error("GitHub returned an unexpected review receipt. Check the PR before submitting again.");
    }
    return { id: result.id, url: result.html_url, state: result.state, commit: result.commit_id, comments: comments.length };
}
