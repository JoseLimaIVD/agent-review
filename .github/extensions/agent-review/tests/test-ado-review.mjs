import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { azureAccessToken, createAdoClient, parseAdoUrl, readAdoSnapshot, submitAdoHandoff } from "../ado-provider.mjs";
import { cloneAdoReview } from "../ado-clone.mjs";
import { listReviewTargets, resolveReviewTarget } from "../review-target.mjs";
import { ReviewState } from "../review-state.mjs";
import { startReviewServer } from "../server.mjs";

const execute = promisify(execFile);
const repoId = "11111111-1111-1111-1111-111111111111";
const projectId = "22222222-2222-2222-2222-222222222222";
const url = "https://dev.azure.com/example/Project%20One/_git/sample/pullrequest/42";
const input = parseAdoUrl(url);
const repository = { id: repoId, name: "sample", project: { id: projectId, name: "Project One" } };
const source = "a".repeat(40), target = "b".repeat(40), common = "c".repeat(40);

function fakeAdo({ head = source, base = target, ancestor = common, status = "active", change = () => {} } = {}) {
    const calls = [];
    const pr = { pullRequestId: 42, repository, status, supportsIterations: true,
        title: "Strict fallback", description: "Full PR description", createdBy: { displayName: "Author" },
        sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", lastMergeTargetCommit: { commitId: base } };
    const iteration = { id: 3, sourceRefCommit: { commitId: head }, targetRefCommit: { commitId: base }, commonRefCommit: { commitId: ancestor } };
    const client = async (repo, suffix = "", options = {}) => {
        calls.push({ repo, suffix, options });
        let result;
        if (options.method === "POST") result = { id: 7, comments: [{ id: 1, ...options.body.comments[0] }] };
        else if (suffix === "") result = repository;
        else if (suffix.endsWith("/iterations")) result = { value: [iteration] };
        else if (suffix === "/refs") result = { value: [
            { name: pr.sourceRefName, objectId: head }, { name: pr.targetRefName, objectId: base },
        ] };
        else if (suffix === "/pullRequests") result = { value: Array.from({ length: 31 }, (_, index) => ({
            ...pr, pullRequestId: 42 + index, creationDate: "2026-10-10T01:00:00Z", isDraft: true,
        })) };
        else result = pr;
        return change(result, suffix, options, repo) || result;
    };
    return { client, calls, pr, iteration };
}

test("ADO identities normalize modern/legacy HTTPS and SSH; reject untrusted or malformed addresses", () => {
    assert.deepEqual(parseAdoUrl("https://example.visualstudio.com/DefaultCollection/Project%20One/_git/sample/pullrequest/42"), input);
    assert.equal(parseAdoUrl("git@ssh.dev.azure.com:v3/example/Project%20One/sample", { repository: true }).project, "Project One");
    assert.equal(parseAdoUrl("example@vs-ssh.visualstudio.com:v3/example/Project%20One/sample", { repository: true }).ssh, true);
    assert.equal(parseAdoUrl("https://example@dev.azure.com/example/Project%20One/_git/sample", { repository: true }).repository, "sample");
    assert.equal(parseAdoUrl("https://github.com/example/sample/pull/42"), null);
    for (const bad of [
        url.replace("https:", "http:"), url.replace("dev.azure.com", "user:secret@dev.azure.com"),
        url.replace("Project%20One", "%2e%2e%2fsecret"), `${url}?token=secret`,
        url.replace("/42", "/0"), url.replace("dev.azure.com", "dev.azure.com:4433"),
        url.replace("/42", "/9007199254740993"),
        url.replace("/Project%20One/", "/Project%20One/../Project%20One/"),
        url.replace("/Project%20One/", "/Project%20One/%2e%2e/Project%20One/"),
    ]) assert.throws(() => parseAdoUrl(bad), /Azure DevOps/);
});

test("ADO client confines bearer credentials to validated endpoints and exposes safe failures", async () => {
    let tokens = 0;
    const calls = [];
    const client = createAdoClient({ getToken: async () => { tokens++; return "test-token"; },
        fetch: async (endpoint, options) => { calls.push({ endpoint, options }); return new Response('{"value":[]}'); } });
    await client(input, "/pullRequests", { query: { $top: "31", "searchCriteria.status": "all" } });
    await client(input, "/refs");
    assert.equal(tokens, 1);
    assert.equal(calls[0].endpoint.origin, "https://dev.azure.com");
    assert.match(calls[0].endpoint.pathname, /Project%20One/);
    assert.equal(calls[0].endpoint.searchParams.get("$top"), "31");
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
    assert.equal(calls[0].options.redirect, "error");
    for (const status of [401, 403, 404, 429, 500]) {
        const failed = createAdoClient({ getToken: async () => "private-token",
            fetch: async () => new Response("private server data", { status }) });
        await assert.rejects(failed(input), (error) => {
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.doesNotMatch(error.message, /private/);
            return true;
        });
    }
    await assert.rejects(azureAccessToken(async (_, args) => {
        assert.ok(args.join(" ").includes("499b84ac-1321-427f-aa17-267ca6975798"));
        throw new Error("private diagnostic");
    }), /Install Azure CLI and run az login/);
});

test("ADO PR list selects origin, paginates and does not fake last-updated timestamps", async () => {
    const { client, calls } = fakeAdo();
    const run = async (command) => {
        assert.equal(command, "git");
        return { stdout: "origin\thttps://dev.azure.com/example/Project%20One/_git/sample (fetch)\n" };
    };
    const result = await listReviewTargets("C:\\repo", { mode: "pr", page: 2 }, run, { adoClient: client });
    assert.equal(result.items.length, 30);
    assert.equal(result.has_more, true);
    assert.equal(result.provider, "ado");
    assert.equal(result.selected_remote, "origin");
    assert.equal(result.items[0].ref, url);
    assert.equal(result.items[0].date_kind, "created");
    assert.equal(result.items[0].draft, true);
    assert.equal(calls[1].options.query.$skip, "60");
    const ambiguous = await listReviewTargets("C:\\repo", { mode: "pr" }, async () => ({
        stdout: "a\thttps://dev.azure.com/example/Project%20One/_git/sample (fetch)\nb\thttps://github.com/example/sample.git (fetch)\n",
    }));
    assert.equal(ambiguous.requires_remote, true);
    assert.equal(ambiguous.remotes.length, 2);
});

test("ADO resolves source/target Git objects rather than synthetic merge refs; validates identities", async () => {
    const { client } = fakeAdo();
    const calls = [];
    const resolved = await resolveReviewTarget("C:\\repo", { mode: "pr", ref: url }, async (command, args) => {
        calls.push({ command, args });
        return { stdout: args.includes("merge-base") ? common : args.includes("log") ? `${source}\0Feature\0Intent\x1e` : "" };
    }, { adoClient: client });
    assert.equal(resolved.currentRef, source);
    assert.equal(resolved.baseRef, common);
    assert.equal(resolved.targetRef, target);
    assert.equal(resolved.provider, "ado");
    assert.equal(resolved.iteration, 3);
    assert.equal(resolved.intent.body, "Full PR description");
    assert.ok(calls.filter((call) => call.args.includes("fetch")).every((call) => [source, target].includes(call.args.at(-1))));
    assert.ok(calls.every((call) => !call.args.includes("checkout")));
    const wrong = fakeAdo({ change: (result, suffix) => suffix === "/pullRequests/42"
        ? { ...result, repository: { ...repository, name: "other" } } : result });
    await assert.rejects(readAdoSnapshot(input, wrong.client), /different repository/);
    const moved = fakeAdo({ change: (result, suffix) => suffix === "/refs" ? { value: [] } : result });
    await assert.rejects(readAdoSnapshot(input, moved.client), /branches changed/);
    const ambiguous = fakeAdo({ change: (result, suffix) => suffix === "/pullRequests/42" ? { ...result, hasMultipleMergeBases: true } : result });
    await assert.rejects(readAdoSnapshot(input, ambiguous.client), /ambiguous merge bases/);
});

test("ADO fork metadata resolves a distinct source repository before fetching", async () => {
    const forkId = "33333333-3333-3333-3333-333333333333";
    const forkProjectId = "44444444-4444-4444-4444-444444444444";
    const { client } = fakeAdo({ change: (result, suffix, _, repo) => {
        if (suffix === "/pullRequests/42") return { ...result, forkSource: { repository: { id: forkId } } };
        if (suffix === "" && repo.repository === forkId) return {
            id: forkId, name: "fork", project: { id: forkProjectId, name: "Fork Project" },
        };
        return result;
    } });
    const calls = [];
    const resolved = await resolveReviewTarget("C:\\repo", { mode: "pr", ref: url }, async (_, args) => {
        calls.push(args);
        return { stdout: args.includes("merge-base") ? common : "" };
    }, { adoClient: client });
    assert.equal(resolved.sourceRepository.repositoryId, forkId);
    assert.ok(calls.some((args) => args.includes("https://dev.azure.com/example/Fork%20Project/_git/fork")));
});

test("ADO posts only the exact confirmed summary and validates freshness and receipts", async () => {
    const fake = fakeAdo();
    const snapshot = await readAdoSnapshot(input, fake.client);
    const reviewTarget = { provider: "ado", currentRef: source, fingerprint: snapshot.fingerprint };
    const body = "Exact preview with base and head";
    const request = { url, commit: source, body, target: reviewTarget };
    const receipt = await submitAdoHandoff(request, fake.client);
    assert.equal(receipt.commit, source);
    assert.equal(receipt.url, `${url}?discussionId=7`);
    const writes = fake.calls.filter((call) => call.options.method === "POST");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].options.body, { comments: [{ parentCommentId: 0, content: body, commentType: 1 }] });
    const stale = fakeAdo({ head: common });
    await assert.rejects(submitAdoHandoff(request, stale.client), /changed or is not active/);
    assert.ok(stale.calls.every((call) => call.options.method !== "POST"));
    for (const status of ["completed", "abandoned"]) {
        const closed = fakeAdo({ status });
        await assert.rejects(submitAdoHandoff(request, closed.client), /not active/);
        assert.ok(closed.calls.every((call) => call.options.method !== "POST"));
    }
    const badReceipt = fakeAdo({ change: (result, _, options) => options.method === "POST" ? { id: 7, comments: [] } : result });
    await assert.rejects(submitAdoHandoff(request, badReceipt.client), /outcome is unknown/);
    const retargeted = fakeAdo({ change: (result, suffix) => suffix === "/pullRequests/42" ? { ...result, targetRefName: "refs/heads/release" }
        : suffix === "/refs" ? { value: [{ name: "refs/heads/feature", objectId: source }, { name: "refs/heads/release", objectId: target }] } : result });
    await assert.rejects(submitAdoHandoff(request, retargeted.client), /changed or is not active/);
    assert.ok(retargeted.calls.every((call) => call.options.method !== "POST"));
});

async function gitRepository(t) {
    const root = await mkdtemp(join(tmpdir(), "ado-review-"));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const repo = join(root, "upstream");
    await mkdir(repo);
    const git = (...args) => execute("git", ["-C", repo, ...args]);
    await git("init", "-qb", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(repo, "main.py"), "def run():\n    return 1\n");
    await git("add", ".");
    await git("commit", "-qm", "Base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("switch", "-qc", "feature");
    await writeFile(join(repo, "main.py"), "def run():\n    return 2\n");
    await git("commit", "-qam", "Feature");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    return { root, repo, git, base, head };
}

test("ADO real-Git review preserves dirty files, index and branch; clone ownership is explicit", async (t) => {
    const { root, repo, git, base, head } = await gitRepository(t);
    const { client } = fakeAdo({ head, base, ancestor: base });
    await writeFile(join(repo, "main.py"), "def dirty_only():\n    return 999\n");
    const before = (await git("status", "--porcelain=v1")).stdout;
    const command = async (file, args, options) => {
        if (args.includes("remote")) return { stdout: "origin\thttps://dev.azure.com/example/Project%20One/_git/sample (fetch)\n" };
        if (args.includes("fetch")) {
            const updated = [...args];
            updated[updated.length - 2] = repo;
            return execute(file, updated, options);
        }
        if (args[0] === "clone") {
            assert.equal(args.at(-2), "https://dev.azure.com/example/Project%20One/_git/sample");
            return execute(file, [...args.slice(0, -2), repo, args.at(-1)], options);
        }
        return execute(file, args, options);
    };
    const state = new ReviewState(repo, { adoClient: client, runTargetCommand: command });
    t.after(() => state.dispose());
    await state.setReviewTarget({ mode: "pr", ref: url });
    assert.match((await state.sourceForPath("main.py")).current, /return 2/);
    assert.equal((await git("status", "--porcelain=v1")).stdout, before);
    assert.equal((await git("branch", "--show-current")).stdout.trim(), "feature");
    assert.match(await readFile(join(repo, "main.py"), "utf8"), /dirty_only/);
    const preview = await state.prepareHandoff();
    assert.equal(preview.provider.authorization, "Azure CLI sign-in");
    const receipt = await state.submitHandoff({ token: preview.token, confirm: true });
    assert.equal(receipt.provider, "ado");
    await assert.rejects(state.submitHandoff({ token: preview.token, confirm: true }), /fresh preview/);
    const phases = [];
    const destination = join(root, "clone");
    const cloned = await cloneAdoReview({ prUrl: url, destination }, {
        run: command, adoClient: client, onProgress: (progress) => phases.push(progress.phase),
    });

    assert.equal(cloned.target.currentRef, head);
    assert.deepEqual(phases, ["metadata", "cloning", "fetching"]);
    await assert.rejects(cloneAdoReview({ prUrl: url, destination }, { adoClient: client }), /already exists/);
    const failed = join(root, "failed");
    await assert.rejects(cloneAdoReview({ prUrl: url, destination: failed }, {
        adoClient: client, run: async () => { throw new Error("credential secret"); },
    }), (error) => {
        assert.match(error.message, /Check your Git credentials/);
        assert.doesNotMatch(error.message, /credential secret/);
        return true;
    });
    assert.equal((await lstat(failed)).isDirectory(), true, "failed destinations are never recursively deleted");
});

test("repository opening cannot race a handoff's asynchronous decision check", async (t) => {
    let releaseProgress, rejectClone;
    const model = { metadata: { repo_root: "C:\\sample", head_sha: source, base_sha: common },
        changes: [], source_files: {}, nodes: [], attention: [], warnings: [] };
    let posts = 0;
    const state = new ReviewState("C:\\sample", {
        runAnalyzer: async () => model,
        cloneAdoReview: () => new Promise((_, reject) => { rejectClone = reject; }),
        submitHandoffReview: async () => { posts++; },
    });
    t.after(() => state.dispose());
    state.model = model;
    state.reviewTarget = { mode: "pr", provider: "ado", url, currentRef: source, baseRef: common };
    const preview = await state.prepareHandoff();
    const progress = await state.progressForReview();
    state.progressForReview = () => new Promise((resolve) => { releaseProgress = resolve; });
    const posting = state.submitHandoff({ token: preview.token, confirm: true });
    const opening = state.setRepository({ prUrl: url, destination: "C:\\new" });
    releaseProgress(progress);
    await assert.rejects(posting, /decisions changed/);
    rejectClone(new Error("Test clone stopped"));
    await assert.rejects(opening, /Test clone stopped/);
    assert.equal(posts, 0);
});

test("ADO clone preparation failures preserve the current review and use the repository endpoint", async (t) => {
    const { repo } = await gitRepository(t);
    const state = new ReviewState(repo, { cloneAdoReview: async () => { throw new Error("Clone blocked"); } });
    const server = await startReviewServer(state);
    t.after(async () => { await server.close(); await state.dispose(); });
    await state.refresh();
    const model = state.model;
    const response = await fetch(`${server.url}api/repository`, { method: "POST",
        body: JSON.stringify({ prUrl: url, destination: join(repo, "unused") }) });
    assert.equal(response.status, 400);
    assert.equal(state.model, model);
    assert.equal(state.repoRoot, repo);
    assert.equal(state.repositoryOpen, null);
    assert.match((await response.json()).error, /Clone blocked/);
    const other = { mode: "pr", provider: "ado", url, currentRef: source, baseRef: common };
    assert.notEqual(state.reviewCacheKey(other), state.reviewCacheKey({ ...other, url: url.replace("/42", "/43") }));
});
