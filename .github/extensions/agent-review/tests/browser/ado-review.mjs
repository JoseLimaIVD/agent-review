import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";

const execute = promisify(execFile);
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const root = await mkdtemp(join(tmpdir(), "ado-browser-"));
const repo = join(root, "upstream");
const prUrl = "https://dev.azure.com/example/Project%20One/_git/sample/pullrequest/42";
const metadata = { id: "11111111-1111-1111-1111-111111111111", name: "sample",
    project: { id: "22222222-2222-2222-2222-222222222222", name: "Project One" } };
let browser;
const resources = [];
try {
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
    const pr = { pullRequestId: 42, repository: metadata, status: "active", supportsIterations: true,
        title: "Validate fallback boundary", description: "Change the saved return value.",
        sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", lastMergeTargetCommit: { commitId: base },
        createdBy: { displayName: "Author" }, creationDate: "2026-10-10T01:00:00Z" };
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
        let writes = 0, failWrite = false, moved = false;
        const client = async (_, suffix = "", options = {}) => {
            if (options.method === "POST") {
                writes++;
                if (failWrite) throw new Error("CONTRACT ONLY: connection lost");
                return { id: 7, comments: [{ id: 1, ...options.body.comments[0] }] };
            }
            if (!suffix) return metadata;
            if (suffix === "/pullRequests") return { value: [pr] };
            if (suffix.endsWith("/iterations")) return { value: [{ id: moved ? 4 : 3,
                sourceRefCommit: { commitId: head }, targetRefCommit: { commitId: base }, commonRefCommit: { commitId: base } }] };
            if (suffix === "/refs") return { value: [
                { name: pr.sourceRefName, objectId: head }, { name: pr.targetRefName, objectId: base },
            ] };
            return pr;
        };
        const run = (file, args, options) => {
            if (args.includes("remote")) return Promise.resolve({ stdout: "origin\thttps://dev.azure.com/example/Project%20One/_git/sample (fetch)\n"
                + "mirror\thttps://example.visualstudio.com/Project%20One/_git/sample (fetch)\n" });
            if (args[0] === "clone") return execute(file, [...args.slice(0, -2), repo, args.at(-1)], options);
            if (args.includes("fetch")) {
                const local = [...args];
                local[local.length - 2] = repo;
                return execute(file, local, options);
            }
            return execute(file, args, options);
        };
        const workspacePath = join(root, `progress-${theme}-${width}`);
        await mkdir(workspacePath);
        const state = new ReviewState(repo, { baseRef: base, adoClient: client, runTargetCommand: run, workspacePath });
        await state.refresh();
        const server = await startReviewServer(state);
        resources.push({ state, server });
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await page.locator("#overview-start").waitFor();
        await page.getByRole("button", { name: "Change repository", exact: true }).click();
        await page.locator("#repository-source").selectOption("ado");
        assert.equal(await page.locator("#repository-pr-url").evaluate((element) => element === document.activeElement), true);
        await page.locator("#repository-pr-url").fill(prUrl);
        await page.locator("#repository-destination").fill(repo);
        await page.locator("#repository-pr-url").focus();
        await page.keyboard.press("Tab");
        assert.equal(await page.locator("#repository-destination").evaluate((element) => element === document.activeElement), true);
        await page.keyboard.press("Tab");
        assert.equal(await page.locator("#repository-open").evaluate((element) => element === document.activeElement), true);
        await page.getByRole("button", { name: "Clone and review PR", exact: true }).click();
        await page.locator("#repository-picker-error").getByText(/already exists/).waitFor();
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
            await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `ado-clone-${theme}-${width}.png`) });
        }
        assert.equal(state.repoRoot, repo);
        const destination = join(root, `clone-${theme}-${width}`);
        await page.locator("#repository-destination").fill(destination);
        await page.getByRole("button", { name: "Clone and review PR", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector("#repository-picker").open
            && document.querySelector("#review-target-label").textContent.startsWith("ADO PR #42"), null, { timeout: 90_000 });
        assert.equal(state.repoRoot, destination);
        assert.equal(state.model.metadata.head_sha, head);
        assert.equal(state.model.metadata.base_sha, base);
        await page.locator("#review-list-refresh").click();
        await page.waitForFunction(() => document.querySelector("#review-options-status").textContent.includes("list refreshed"));
        assert.match(await page.locator("#review-ref option").last().textContent(), /created /);
        assert.equal(await page.locator("#review-remote").isVisible(), true);
        await page.locator("#review-remote").selectOption("mirror");
        await page.waitForFunction(() => !document.querySelector("#review-ref").disabled);
        assert.equal(await page.locator("#review-ref").inputValue(), "", "changing remote never silently selects a PR");
        await page.locator("#review-ref").selectOption(prUrl);
        await page.waitForFunction(() => !document.querySelector("#review-mode").disabled);
        assert.equal(state.reviewTarget.remote, "mirror");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        await page.locator("#workflow-review").click();
        await page.locator("#workflow-finish").click();
        await page.getByRole("button", { name: "Preview / export handoff", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector("#handoff-confirm").disabled);
        const markdown = await page.locator("#handoff-markdown").inputValue();
        assert.match(markdown, /Iteration: 3/);
        assert.match(await page.locator("#handoff-provider").textContent(), /Azure CLI sign-in.*not a commit-bound review/);
        assert.equal(await page.locator("#handoff-submit").isDisabled(), true);
        assert.equal(writes, 0);
        await page.locator("#handoff-confirm").check();
        await page.getByRole("button", { name: "Post PR summary comment", exact: true }).click();
        await page.locator("#handoff-provider-status").getByText(/Posted Azure DevOps summary comment 7/).waitFor();
        assert.equal(writes, 1);
        assert.equal(await page.locator("#handoff-submit").isDisabled(), true);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
            await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `ado-receipt-${theme}-${width}.png`) });
        }
        moved = true;
        await page.locator("#handoff-refresh").click();
        await page.waitForFunction(() => !document.querySelector("#handoff-confirm").disabled);
        await page.locator("#handoff-confirm").check();
        await page.locator("#handoff-submit").click();
        await page.locator("#handoff-provider-error").getByText(/changed or is not active/).waitFor();
        assert.equal(writes, 1, "stale iteration must not post");
        moved = false;
        failWrite = true;
        await page.locator("#handoff-refresh").click();
        await page.waitForFunction(() => !document.querySelector("#handoff-confirm").disabled);
        await page.locator("#handoff-confirm").check();
        await page.locator("#handoff-submit").click();
        await page.locator("#handoff-provider-error").getByText(/outcome is unknown/).waitFor();
        assert.equal(writes, 2, "one failed write, no automatic retries");
        assert.equal(await page.locator("#handoff-submit").isDisabled(), true);
        assert.ok(await page.locator("#review-handoff").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1));
        assert.deepEqual(errors, []);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#review-handoff").isVisible(), false);
        await page.close();
        console.log(`PASS ${theme}/${width}: ADO CONTRACT with real Git clone/source, destination safety, provider identity, exact handoff, stale iteration, unknown write outcome; no live ADO write`);
    }
} finally {
    await browser?.close();
    for (const { state, server } of resources) { await server.close(); await state.dispose(); }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
