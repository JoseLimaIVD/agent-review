import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assessPackageRisk } from "./package-risk.mjs";
import { assessNpmPackageRisk } from "./node-package-risk.mjs";
import { assessGoModuleRisk } from "./go-package-risk.mjs";
import { assessNugetPackageRisk } from "./nuget-package-risk.mjs";
import { assessCratePackageRisk } from "./crate-package-risk.mjs";
import { buildPackageUsageContext } from "./package-context.mjs";
import { CustomPromptStore } from "./custom-prompts.mjs";
import { customAnalysisContext, validateCustomAnalysis } from "./custom-analysis.mjs";
import { resolveReviewTarget } from "./review-target.mjs";
import { buildSessionContext, findSessionAttribution, mergeSessionContexts } from "./session-context.mjs";
import { spawnOwnedAnalyzer } from "./ownership-guard.mjs";
import { fingerprintWorktree } from "./worktree-changes.mjs";
import { callablesForSubject, decisionPromptContext } from "./web/decision-map.mjs";
import { exportSnapshot, mapExecutedPaths } from "./test-run.mjs";
import { repositoryRuleSources, RULES_PROMPT, RULE_EVIDENCE_OPTIONS, ruleCheckContext } from "./review-contracts.mjs";
import { buildCodePathRequests, mergeCodePathMaps, reviewAdapter, sourceAdapter, testAdapterForMap } from "./language-adapters.mjs";
import { isTestPath } from "./web/languages.mjs";
import { pythonCandidates } from "./python-runtime.mjs";
import { runReview } from "./review-pipeline.mjs";
import { reviewIdentity } from "./review-pipeline.mjs";
import { answerDiscussion } from "./item-discussion.mjs";
import { layerSummaryContext } from "./layer-summaries.mjs";
import { workspaceNavigation } from "./web/review-workspace.mjs";
import { ExplanationValidationError } from "./ai-response.mjs";
import { contextForSection, sectionsFor } from "./review-sections-context.mjs";
import { annotationCodeContext } from "./annotation-context.mjs";
import { ReviewProgressStore, validateReviewCursor, validateReviewEntries } from "./review-progress.mjs";
import { reviewSnapshotKey } from "./web/review-ledger.mjs";
import { createReviewHandoff, submitGitHubHandoff, validateHandoffImport } from "./review-handoff.mjs";

const execFileAsync = promisify(execFile);
const extensionRoot = dirname(fileURLToPath(import.meta.url));
const analyzerPath = join(extensionRoot, "analyzer", "analyze.py");
export { isTestPath };

function boundedAnalysisWarnings(warnings, path = null, { maxItems = 40, maxCharacters = 12_000 } = {}) {
    const values = (warnings || []).map(String);
    const normalizedPath = String(path || "").replaceAll("\\", "/").toLowerCase();
    const ranked = normalizedPath
        ? values.map((warning, index) => ({ warning, index, relevant: warning.replaceAll("\\", "/").toLowerCase().includes(normalizedPath) }))
            .sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.index - b.index)
            .map((item) => item.warning)
        : values;
    const selected = [];
    let remaining = maxCharacters;
    let truncated = false;
    for (const warning of ranked) {
        if (selected.length >= maxItems || remaining <= 0) break;
        const text = warning.length > 800 ? `${warning.slice(0, 799)}…` : warning;
        const clipped = text.slice(0, remaining);
        selected.push(clipped);
        remaining -= clipped.length;
        truncated ||= clipped.length < warning.length;
    }
    return {
        warnings: selected,
        omitted_warnings: Math.max(0, values.length - selected.length),
        warnings_truncated: truncated || selected.length < values.length,
    };
}

function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function abortable(value, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(value).then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
    });
}

function normalizeRepoPath(value) {
    return resolve(value || process.env.COPILOT_WORKSPACE_PATH || process.env.COPILOT_ROOT_PATH || process.cwd());
}

async function git(repoRoot, args, options = {}) {
    const result = await execFileAsync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        ...options,
    });
    return result.stdout.trimEnd();
}

export async function resolveRepoRoot(requestedPath) {
    const candidate = normalizeRepoPath(requestedPath);
    const root = await git(candidate, ["rev-parse", "--show-toplevel"]);
    return resolve(root);
}

export async function loadReviewConfig(repoRoot) {
    const path = join(repoRoot, ".agent-review.json");
    try {
        const config = JSON.parse(await readFile(path, "utf8"));
        if (config.base_ref !== undefined && typeof config.base_ref !== "string") {
            throw new Error("base_ref must be a string.");
        }
        return config;
    } catch (error) {
        if (error.code === "ENOENT") return {};
        throw new Error(`Unable to load ${path}: ${error.message}`);
    }
}

export function runAnalyzerProcess(executable, args, onProgress = () => {}, options = {}) {
    return new Promise((resolve, reject) => {
        options.signal?.throwIfAborted();
        const child = spawnOwnedAnalyzer(executable, args, options);
        const abort = () => child.stop();
        options.signal?.addEventListener("abort", abort, { once: true });
        const stdout = [];
        const diagnostics = [];
        let stderrBuffer = "";
        let outputBytes = 0;
        let failure;
        child.on("message", (message) => {
            if (message.type === "spawn-error") failure = Object.assign(new Error(message.message), { code: message.code });
            if (message.type === "analyzer-started") options.onSpawn?.(message.pid);
        });
        child.stdout.on("data", (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > 128 * 1024 * 1024) {
                failure = new Error("Analyzer output exceeded 128 MB.");
                child.stop();
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderrBuffer += chunk.toString("utf8");
            const lines = stderrBuffer.split(/\r?\n/);
            stderrBuffer = lines.pop() || "";
            for (const line of lines) {
                if (line.startsWith("AGENT_REVIEW_PROGRESS ")) {
                    try {
                        onProgress(JSON.parse(line.slice("AGENT_REVIEW_PROGRESS ".length)));
                    } catch (error) {
                        diagnostics.push(`Invalid progress event: ${error.message}`);
                    }
                } else if (line.trim()) {
                    diagnostics.push(line);
                }
            }
        });
        child.once("error", reject);
        child.once("close", (code) => {
            options.signal?.removeEventListener("abort", abort);
            if (options.signal?.aborted) { reject(options.signal.reason); return; }
            if (failure) { reject(failure); return; }
            if (stderrBuffer.trim() && !stderrBuffer.startsWith("AGENT_REVIEW_PROGRESS ")) diagnostics.push(stderrBuffer);
            if (code !== 0) {
                reject(new Error(diagnostics.join("\n") || `${executable} exited with code ${code}`));
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
            } catch (error) {
                reject(new Error(`Analyzer returned invalid JSON: ${error.message}`));
            }
        });
    });
}

export async function runAnalyzer(repoRoot, baseRef, onProgress, currentRef = null, options = {}) {
    const args = [analyzerPath, "--repo", repoRoot];
    if (baseRef) args.push("--base-ref", baseRef);
    if (currentRef) args.push("--current-ref", currentRef);
    const failures = [];
    for (const [executable, prefix] of pythonCandidates()) {
        try {
            return await runAnalyzerProcess(executable, [...prefix, ...args], onProgress, options);
        } catch (error) {
            options.signal?.throwIfAborted();
            if (error.code !== "ENOENT") throw error;
            failures.push(`${executable}: ${error.message}`);
        }
    }
    throw new Error(`Unable to run the Python 3.11+ analyzer:\n${failures.join("\n")}`);
}

// Compatibility entry point for callers that request the Python map directly.
export function buildDecisionRequest(model, repoRoot) {
    return reviewAdapter("python").buildCodePathRequest(model, repoRoot);
}

// Existing coverage reports show whether a path's lines ran in the suite, not which test ran them.
export function attachCoverage(map, model) {
    if (!model?.coverage?.available || !map?.callables) return map;
    const files = new Map((model.coverage.files || []).map((file) => [file.path,
        { covered: new Set(file.covered_lines || []), executable: new Set(file.executable_lines || []) }]));
    for (const item of map.callables) {
        const file = files.get(item.path);
        if (!file) continue;
        for (const entry of item.entries || []) {
            if (entry.status === "removed" || entry.decision.implicit) continue;
            const lines = [];
            for (let line = entry.decision.line; line <= (entry.decision.end_line || entry.decision.line); line++) lines.push(line);
            const coverage = lines.some((line) => file.covered.has(line)) ? "executed"
                : lines.some((line) => file.executable.has(line)) ? "not executed" : null;
            if (coverage) (entry.evidence ||= { level: "none", tests: [], omitted_tests: 0 }).coverage = coverage;
        }
    }
    return map;
}

export async function runDecisionExtractor(request, options = {}) {
    const directory = await mkdtemp(join(tmpdir(), "agent-review-decisions-"));
    const input = join(directory, "request.json");
    try {
        await writeFile(input, JSON.stringify(request));
        const parser = reviewAdapter(request.adapter_id || "python").codePathProcess(extensionRoot, input);
        const failures = [];
        for (const candidate of parser.candidates) {
            const [executable, prefix] = Array.isArray(candidate) ? candidate : [candidate.command, candidate.args || []];
            try {
                const result = await runAnalyzerProcess(executable, [...prefix, ...parser.args], () => {}, options);
                return { ...result, adapter_id: request.adapter_id || "python" };
            } catch (error) {
                options.signal?.throwIfAborted();
                if (error.code !== "ENOENT") throw error;
                failures.push(`${executable}: ${error.message}`);
            }
        }
        throw new Error(`Unable to run the ${parser.runtime} code path extractor:\n${failures.join("\n")}`);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function safePath(repoRoot, path) {
    if (!path || isAbsolute(path)) throw new Error("A repository-relative path is required.");
    const fullPath = resolve(repoRoot, normalize(path));
    const rel = relative(repoRoot, fullPath);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path is outside the repository.");
    return fullPath;
}

export class ReviewState {
    constructor(repoRoot, options = {}) {
        this.repoRoot = repoRoot;
        this.baseRef = options.baseRef || null;
        this.worktreeBaseRef = this.baseRef;
        this.reviewTarget = options.reviewTarget || { mode: "worktree", label: "Worktree", currentRef: null };
        this.resolveBaseRef = options.resolveBaseRef || null;
        this.model = null;
        this.error = null;
        this.loading = false;
        this.cancelled = false;
        this.disposed = false;
        this.activeRun = null;
        this.cancelPromise = null;
        this.runAnalyzer = options.runAnalyzer || runAnalyzer;
        this.runDecisions = options.runDecisions || (this.runAnalyzer === runAnalyzer ? runDecisionExtractor : null);
        this.decisionMap = null;
        this.decisionPromise = null;
        this.decisionController = null;
        this.runTests = options.runTests || null;
        this.testRun = null;
        this.testRunController = null;
        this.ruleCheck = null;
        this.readWorktreeFingerprint = options.readWorktreeFingerprint
            || (this.runAnalyzer === runAnalyzer ? fingerprintWorktree : null);
        this.worktreeFingerprint = null;
        this.worktreeChanged = false;
        this.worktreeCheckError = null;
        this.worktreeMonitorOwners = 0;
        this.workspacePath = options.workspacePath;
        this.reviewProgressStore = new ReviewProgressStore(this.workspacePath);
        this.submitHandoffReview = options.submitHandoffReview || submitGitHubHandoff;
        this.handoffPreview = null;
        this.generatedObservations = [];
        this.selection = null;
        this.listeners = new Set();
        this.refreshPromise = null;
        this.reviewGeneration = 0;
        this.reviewInstanceId = randomUUID();
        this.reviewCache = new Map();
        this.sourceSnapshotCache = new WeakMap();
        this.lastAnalyzedAt = null;
        this.restoredFromCache = false;
        this.getSessionEvents = options.getSessionEvents || null;
        this.getHistoricalSessionContexts = options.getHistoricalSessionContexts || null;
        this.historicalSessionTimeoutMs = options.historicalSessionTimeoutMs || 40_000;
        this.currentSessionId = options.currentSessionId || null;
        this.generateAnnotation = options.generateAnnotation || null;
        this.generatePackageExplanation = options.generatePackageExplanation || null;
        this.generateCustomAnalysis = options.generateCustomAnalysis || null;
        this.generateReviewPass = options.generateReviewPass || null;
        this.createReviewRuntime = options.createReviewRuntime || null;
        this.reviewModelId = options.reviewModelId || (() => null);
        this.reviewDirectory = options.reviewDirectory || (this.workspacePath
            ? join(this.workspacePath, "files", "agent-review-reviews") : null);
        this.reviewLimits = options.reviewLimits || {};
        this.reviewControllers = new Set();
        this.generateDiscussion = options.generateDiscussion || null;
        this.generateLayerSummaries = options.generateLayerSummaries || null;
        this.discussionThreads = new Map();
        this.discussionLoads = new Map();
        this.discussionRuns = new Map();
        this.discussionSnapshots = new WeakMap();
        this.discussionUpdate = null;
        this.reviewEvidence = null;
        this.reviewEvidenceModel = null;
        this.reviewEvidenceRevision = 0;
        this.customAnalysisTimeoutMs = options.customAnalysisTimeoutMs || 120_000;
        this.customPromptOptions = options.customPromptOptions || {};
        this.customAnalyses = {};
        this.customAnalysisPromises = new WeakMap();
        this.customPromptError = null;
        this.sessionContext = null;
        this.annotations = {};
        this.annotationPromises = new Map();
        this.packageRisks = {};
        this.packageRiskPromises = new Map();
        this.packageAssessments = new Map();
        this.packageAssessmentPromises = new Map();
        this.progress = null;
        this.sessionHistories = new Map();
        this.historicalContextPromise = null;
    }

    async progressForReview() {
        if (!this.model || this.loading) throw new Error("Wait for the saved review before loading progress.");
        return this.reviewProgressStore.read(reviewSnapshotKey(this.model, this.reviewTarget));
    }

    async validateReviewProgress({ snapshot, entries, cursor = null }) {
        const model = this.model;
        if (!model || this.loading || snapshot !== reviewSnapshotKey(model, this.reviewTarget)) {
            throw new Error("Review progress belongs to another saved snapshot.");
        }
        const changed = new Set((model.changes || []).filter((file) => file.status !== "unchanged").map((file) => file.path));
        for (const [id, entry] of Object.entries(validateReviewEntries(entries))) {
            if (id.startsWith("review-file:") && (!changed.has(id.slice("review-file:".length)) || entry?.path !== id.slice("review-file:".length))) {
                throw new Error("Whole-file review decisions must identify a changed file in this snapshot.");
            }
        }
        const location = validateReviewCursor(cursor);
        if (location) {
            if (!Object.hasOwn(model.source_files || {}, location.path)) throw new Error("Saved cursor path is not available in this snapshot.");
            if (location.item_id && !model.package_dependencies?.some((item) => item.id === location.item_id)) this.contextFor(location.item_id);
            const source = await this.sourceForPath(location.path);
            const text = location.side === "base" ? source.base : source.current;
            if (typeof text !== "string" || location.line > text.split(/\r?\n/).length) {
                throw new Error("Saved cursor line is not available in this snapshot.");
            }
        }
        if (this.model !== model) throw new Error("The review changed before progress could be saved.");
        return location;
    }

    async saveReviewProgress(input) {
        const location = await this.validateReviewProgress(input);
        return this.reviewProgressStore.update(input.snapshot, input.revision, input.entries, location);
    }

    // The rail's layer order and AI layer lines, for summaries that should read in the same order as the review.
    handoffLayers(model) {
        try {
            const navigation = workspaceNavigation(model, sectionsFor(model, this.reviewEvidenceModel === model ? this.reviewEvidence : null));
            return navigation.layers.map((layer) => ({ number: layer.number, name: layer.name, supporting: Boolean(layer.supporting),
                intent: this.annotations.layers?.intents?.[layer.id] || null, summary: layer.summary,
                files: layer.groups.flatMap((group) => group.files.map((file) => file.path)) }));
        } catch { return null; }
    }

    async prepareHandoff() {
        const model = this.model;
        if (!model || this.loading) throw new Error("Wait for the saved review before preparing a handoff.");
        const target = this.reviewTarget;
        const progress = await this.progressForReview();
        if (this.model !== model || this.reviewTarget !== target) throw new Error("The review changed while preparing the handoff.");
        const result = createReviewHandoff(model, target, progress, { testRun: this.testRun, layers: this.handoffLayers(model) });
        const token = randomUUID();
        this.handoffPreview = { token, model, target, revision: progress.revision, snapshot: progress.snapshot,
            body: result.markdown, created: Date.now(), consumed: false };
        return { ...result, token, revision: progress.revision,
            provider: this.handoffSubmitting ? { available: false, pending: true, url: target.url, commit: model.metadata.head_sha,
                reason: "Awaiting the previous submission receipt. Local export is available; do not submit again." }
                : result.markdown.length > 60_000 ? { available: false, reason: "This summary exceeds the bounded PR review size. Export locally instead; nothing will be submitted." }
                : target.mode === "pr" && Boolean(target.url) ? { available: true, url: target.url, commit: model.metadata.head_sha }
                : { available: false, reason: "Provider submission requires a loaded GitHub PR target. Local and commit reviews can export without creating a PR." } };
    }

    async importHandoff({ artifact, revision, confirm = false }) {
        const model = this.model, target = this.reviewTarget;
        if (!model || this.loading) throw new Error("Open the matching saved review before importing decisions.");
        const incoming = validateHandoffImport(artifact, model, target);
        const current = await this.progressForReview();
        if (this.model !== model || this.reviewTarget !== target) throw new Error("The review changed during import.");
        if (revision !== current.revision) throw new Error("Saved progress changed. Preview the import again; nothing was overwritten.");
        const merged = new Map(Object.entries(current.entries));
        for (const [id, entry] of incoming) {
            const previous = merged.get(id);
            // An explicit "Not reviewed" with no note carries no decision; treat it like an absent record.
            const meaningful = previous && (previous.disposition !== "pending" || previous.note);
            if (meaningful && (previous.disposition !== entry.disposition || previous.note !== entry.note)) {
                throw new Error(`Import conflicts with an existing decision for ${previous.path || id.replace(/^review-file:/, "")}; nothing was overwritten.`);
            }
            merged.set(id, entry);
        }
        const input = { snapshot: current.snapshot, revision: current.revision,
            entries: Object.fromEntries(merged), cursor: current.cursor || artifact.cursor || null };
        await this.validateReviewProgress(input);
        if (confirm !== true) return { revision: current.revision, records: incoming.size,
            repository: artifact.repository, identity: artifact.identity, message: "Exact saved source matches. Existing differing decisions are never overwritten." };
        return this.saveReviewProgress(input);
    }

    async submitHandoff({ token, confirm }) {
        const preview = this.handoffPreview;
        if (confirm !== true || !preview || token !== preview.token || preview.consumed || this.handoffSubmitting || Date.now() - preview.created > 15 * 60_000) {
            throw new Error("A fresh preview and explicit confirmation are required; nothing was submitted.");
        }
        if (this.loading || this.model !== preview.model || this.reviewTarget !== preview.target || preview.target.mode !== "pr") {
            throw new Error("The review target changed or is not a PR; nothing was submitted.");
        }
        const progress = await this.progressForReview();
        if (preview.consumed || this.handoffSubmitting || this.loading || this.model !== preview.model || this.reviewTarget !== preview.target
            || progress.snapshot !== preview.snapshot || progress.revision !== preview.revision) {
            throw new Error("Review decisions changed. Prepare a new preview before submitting.");
        }
        preview.consumed = true;
        this.handoffSubmitting = true;
        try {
            return await this.submitHandoffReview({ url: preview.target.url, commit: preview.model.metadata.head_sha,
                body: preview.body, cwd: this.repoRoot });
        } finally { this.handoffSubmitting = false; }
    }

    snapshot() {
        return {
            repo_root: this.repoRoot,
            model: this.model,
            loading: this.loading,
            cancelled: this.cancelled,
            disposed: this.disposed,
            error: this.error,
            generated_observations: this.generatedObservations,
            selection: this.selection,
            session_context: this.sessionContext,
            annotations: this.annotations,
            progress: this.progress,
            package_risks: this.packageRisks,
            review_target: this.reviewTarget,
            review_generation: `${this.reviewInstanceId}:${this.reviewGeneration}`,
            analyzed_at: this.lastAnalyzedAt,
            restored_from_cache: this.restoredFromCache,
            worktree_changed: this.reviewTarget.mode === "worktree" && this.worktreeChanged,
            worktree_check_error: this.reviewTarget.mode === "worktree" ? this.worktreeCheckError : null,
            saved_review_targets: [...this.reviewCache.values()].map((entry) => entry.target),
            custom_analyses: this.customAnalyses,
            custom_prompt_error: this.customPromptError,
            decision_map: this.decisionMap,
            test_run: this.testRun ? { ...this.testRun, stale: this.testRun.status === "complete" && this.testRunStale() } : null,
            rule_check: this.ruleCheck,
            discussion_update: this.discussionUpdate,
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async setRepository(input) {
        if (this.disposed) throw new Error("This review has been closed.");
        if (!input || typeof input.repoPath !== "string" || !input.repoPath.trim()) {
            throw new Error("Enter the local path of the repository to review.");
        }
        if (input.baseRef !== undefined && input.baseRef !== null && typeof input.baseRef !== "string") {
            throw new Error("baseRef must be a string.");
        }
        if (this.loading || this.refreshPromise || this.switchingTarget || this.switchingRepository
            || this.packageRiskPromises.size || this.packageAssessmentPromises.size) {
            throw new Error("Wait for the active analysis or package assessment to finish before changing repositories.");
        }
        this.switchingRepository = true;
        const generation = this.reviewGeneration;
        try {
            const repoRoot = await resolveRepoRoot(input.repoPath.trim());
            const config = await loadReviewConfig(repoRoot);
            if (this.disposed) throw new Error("This review has been closed.");
            if (generation !== this.reviewGeneration || this.loading || this.refreshPromise || this.switchingTarget
                || this.packageRiskPromises.size || this.packageAssessmentPromises.size) {
                throw new Error("The review changed while validating the repository. Try again.");
            }
            this.reviewGeneration += 1;
            this.stopInternalReviews();
            this.worktreeCheckController?.abort();
            this.decisionController?.abort();
            this.stopTestRun();
            await Promise.all([this.decisionPromise, this.testRunPromise]);
            if (this.disposed) throw new Error("This review has been closed.");
            this.repoRoot = repoRoot;
            this.repositoryBaseOverride = input.baseRef || null;
            this.worktreeBaseRef = this.repositoryBaseOverride || config.base_ref || process.env.COPILOT_DEFAULT_BRANCH || null;
            this.baseRef = this.worktreeBaseRef;
            this.resolveBaseRef = async () => this.repositoryBaseOverride
                || (await loadReviewConfig(this.repoRoot)).base_ref || process.env.COPILOT_DEFAULT_BRANCH || null;
            this.reviewTarget = { mode: "none", label: "Choose review target", currentRef: null };
            this.model = null;
            this.reviewEvidence = null;
            this.reviewEvidenceModel = null;
            this.annotations = {};
            this.annotationPromises = new Map();
            this.generatedObservations = [];
            this.selection = null;
            this.reviewCache.clear();
            this.packageRisks = {};
            this.packageRiskPromises.clear();
            this.packageAssessments.clear();
            this.packageAssessmentPromises.clear();
            this.decisionMap = null;
            this.decisionPromise = null;
            this.decisionController = null;
            this.testRun = null;
            this.testRunPromise = null;
            this.ruleCheck = null;
            this.ruleCheckPromise = null;
            this.customAnalyses = {};
            this.customAnalysisPromises = new WeakMap();
            this.customPromptError = null;
            this.customPromptStore = null;
            this.sessionContext = null;
            this.sessionHistories.clear();
            this.historicalContextPromise = null;
            this.worktreeFingerprint = null;
            this.worktreeChanged = false;
            this.worktreeCheckError = null;
            this.lastAnalyzedAt = null;
            this.restoredFromCache = false;
            this.error = null;
            this.cancelled = false;
            this.loading = false;
            this.progress = null;
            this.broadcast("repository-changed");
            return this.snapshot();
        } finally {
            this.switchingRepository = false;
        }
    }

    broadcast(type = "state") {
        const event = { type, ...this.snapshot() };
        for (const listener of this.listeners) listener(event);
    }

    startWorktreeMonitoring(intervalMs = 5000) {
        this.worktreeMonitorOwners++;
        if (!this.worktreeMonitorTimer) {
            this.worktreeMonitorTimer = setInterval(() => this.checkWorktreeChanges(), intervalMs);
            this.worktreeMonitorTimer.unref();
            this.checkWorktreeChanges();
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--this.worktreeMonitorOwners === 0) {
                clearInterval(this.worktreeMonitorTimer);
                this.worktreeMonitorTimer = null;
                this.worktreeCheckController?.abort();
            }
        };
    }

    async checkWorktreeChanges() {
        if (this.disposed || this.loading || this.refreshPromise || this.switchingTarget
            || this.reviewTarget.mode !== "worktree" || !this.model || !this.readWorktreeFingerprint) return;
        if (this.worktreeCheckPromise) return this.worktreeCheckPromise;
        const generation = this.reviewGeneration;
        const controller = new AbortController();
        this.worktreeCheckController = controller;
        const timer = setTimeout(() => controller.abort(new Error("Worktree change check timed out.")), 5000);
        this.worktreeCheckPromise = Promise.resolve().then(async () => {
            let changed = this.worktreeChanged, message = null;
            try {
                if (!this.worktreeFingerprint) throw new Error("Reanalyze this saved review to enable worktree change detection.");
                const fingerprint = await this.readWorktreeFingerprint(this.repoRoot, { baseRef: this.baseRef, signal: controller.signal });
                changed = fingerprint !== this.worktreeFingerprint;
            } catch (error) {
                if (controller.signal.aborted && !this.worktreeMonitorOwners) return;
                message = `Unable to check worktree changes: ${error.message}`;
            }
            if (this.disposed || generation !== this.reviewGeneration || this.reviewTarget.mode !== "worktree") return;
            if (changed !== this.worktreeChanged || message !== this.worktreeCheckError) {
                this.worktreeChanged = changed;
                this.worktreeCheckError = message;
                if (message) console.error("[agent-review worktree changes]", message);
                this.broadcast("worktree-changed");
            }
        }).finally(() => {
            clearTimeout(timer);
            this.worktreeCheckPromise = null;
            if (this.worktreeCheckController === controller) this.worktreeCheckController = null;
        });
        return this.worktreeCheckPromise;
    }

    failInitialization(error) {
        if (this.disposed || this.cancelled) return;
        this.loading = false;
        this.error = error.message;
        this.progress = { phase: "failed", message: "Repository initialization failed", percent: 100 };
        this.broadcast("refresh-failed");
    }


    async refresh() {
        if (this.disposed) throw new Error("This review has been closed.");
        if (this.cancelPromise) await this.cancelPromise;
        if (this.refreshPromise) return this.refreshPromise;
        const run = { controller: new AbortController() };
        this.activeRun = run;
        const signal = run.controller.signal;
        const wait = (promise) => abortable(promise, signal);
        this.reviewGeneration += 1;
        this.stopInternalReviews();
        this.annotationPromises = new Map();
        // A running extraction is for the review being replaced; never let it compete with the new scan.
        if (this.decisionMap?.status === "loading") {
            this.decisionController?.abort();
            this.decisionController = null;
            this.decisionMap = null;
            this.decisionPromise = null;
        }
        this.stopTestRun();
        this.loading = true;
        this.cancelled = false;
        this.error = null;
        this.progress = {
            phase: "starting",
            message: "Starting deterministic repository analysis",
            percent: 0,
            started_at: new Date().toISOString(),
        };
        this.broadcast("refresh-started");
        const sessionContextPromise = wait(this.refreshSessionContext(false));
        sessionContextPromise.catch(() => {});
        this.refreshPromise = Promise.resolve()
            .then(() => {
                signal.throwIfAborted();
                return wait(this.reviewTarget.mode !== "worktree" ? this.reviewTarget.baseRef
                    : this.resolveBaseRef ? this.resolveBaseRef() : this.worktreeBaseRef);
            })
            .then(async (baseRef) => {
                signal.throwIfAborted();
                this.baseRef = baseRef ?? null;
                if (this.reviewTarget.mode === "worktree" && this.readWorktreeFingerprint) {
                    try {
                        run.worktreeFingerprint = await this.readWorktreeFingerprint(this.repoRoot, { baseRef: this.baseRef, signal });
                    } catch (error) {
                        signal.throwIfAborted();
                        run.worktreeCheckError = `Unable to check worktree changes: ${error.message}`;
                        console.error("[agent-review worktree changes]", run.worktreeCheckError);
                    }
                }
                signal.throwIfAborted();
                return this.runAnalyzer(this.repoRoot, this.baseRef, (progress) => {
                    if (signal.aborted || this.activeRun !== run) return;
                    const previousPercent = Number(this.progress?.percent);
                    const reportedPercent = Number(progress?.percent);
                    const percent = Number.isFinite(reportedPercent)
                        ? Math.max(Number.isFinite(previousPercent) ? previousPercent : 0, reportedPercent)
                        : Number.isFinite(previousPercent) ? previousPercent : 0;
                    this.progress = { ...this.progress, ...progress, percent, updated_at: new Date().toISOString() };
                    this.broadcast("progress");
                }, this.reviewTarget.currentRef, { signal, workspacePath: this.workspacePath });
            })
            .then(async (model) => {
                await sessionContextPromise;
                signal.throwIfAborted();
                if (this.activeRun !== run) throw new Error("The review changed during analysis.");
                this.model = model;
                this.generatedObservations = this.generatedObservations.filter((observation) =>
                    observation.evidence_ids.every((id) => model.evidence?.[id])
                );
                this.annotations = {};
                this.selection = null;
                this.packageRisks = {};
                this.packageAssessments = new Map();
                this.customAnalyses = {};
                this.customPromptError = null;
                this.loading = false;
                this.lastAnalyzedAt = new Date().toISOString();
                this.restoredFromCache = false;
                this.worktreeFingerprint = run.worktreeFingerprint || null;
                this.worktreeChanged = false;
                this.worktreeCheckError = run.worktreeCheckError || null;
                this.progress = { phase: "complete", message: "Analysis complete", percent: 100 };
                this.testRun = null;
                this.ruleCheck = null;
                this.startDecisionMap();
                this.saveCurrentReview();
                this.broadcast("refreshed");
                this.startCustomAnalyses();
                return model;
            })
            .catch((error) => {
                if (signal.aborted || this.activeRun !== run || this.disposed) throw error;
                this.loading = false;
                this.error = error.message;
                this.progress = { phase: "failed", message: "Analysis failed", percent: 100 };
                if (this.model && !this.decisionMap) this.startDecisionMap();
                this.broadcast("refresh-failed");
                throw error;
            })
            .finally(() => {
                if (this.activeRun === run) {
                    this.refreshPromise = null;
                    this.activeRun = null;
                    if (this.worktreeMonitorOwners) this.checkWorktreeChanges();
                }
            });
        return this.refreshPromise;
    }

    // Keep the run promise until its ownership guard has confirmed process-tree exit.
    async cancel() {
        this.stopInternalReviews();
        if (this.cancelPromise) return this.cancelPromise;
        this.cancelled = true;
        this.reviewGeneration += 1;
        const pending = this.refreshPromise;
        this.activeRun?.controller.abort(new DOMException("Analysis cancelled.", "AbortError"));
        const cancellation = (async () => {
            try { await pending; }
            catch (error) { if (error.name !== "AbortError") console.error("[agent-review cancellation]", error); }
            this.loading = false;
            this.error = null;
            this.progress = { phase: "cancelled", message: "Analysis cancelled. Choose Reanalyze to try again.", percent: 0 };
            if (this.model && !this.decisionMap && !this.disposed) this.startDecisionMap();
            this.broadcast("cancelled");
        })();
        this.cancelPromise = cancellation;
        try { await cancellation; }
        finally { if (this.cancelPromise === cancellation) this.cancelPromise = null; }
        return this.snapshot();
    }

    async dispose() {
        if (this.disposalPromise) return this.disposalPromise;
        this.disposed = true;
        clearInterval(this.worktreeMonitorTimer);
        this.worktreeMonitorTimer = null;
        this.worktreeCheckController?.abort();
        this.disposalPromise = this.clearDisposedReview();
        return this.disposalPromise;
    }

    async clearDisposedReview() {
        await this.cancel();
        await Promise.all([...this.discussionRuns.values()]);
        const decisions = this.decisionPromise;
        this.decisionController?.abort();
        await decisions;
        const tests = this.testRunPromise;
        this.stopTestRun();
        await tests?.catch(() => {});
        this.testRun = null;
        this.decisionMap = null;
        this.decisionPromise = null;
        this.model = null;
        this.generatedObservations = [];
        this.annotations = {};
        this.selection = null;
        this.sessionContext = null;
        this.customAnalyses = {};
        this.discussionThreads.clear();
        this.discussionLoads.clear();
        this.discussionUpdate = null;
        this.customPromptError = null;
        this.packageRisks = {};
        this.reviewCache.clear();
        this.annotationPromises.clear();
        this.packageRiskPromises.clear();
        this.packageAssessments.clear();
        this.packageAssessmentPromises.clear();
        this.customAnalysisPromises = new WeakMap();
        this.sessionHistories.clear();
        this.historicalContextPromise = null;
        this.restoredFromCache = false;
        this.lastAnalyzedAt = null;
        this.progress = null;
        this.listeners.clear();
    }

    async setReviewTarget(input) {
        if (this.refreshPromise || this.switchingTarget) throw new Error("Wait for the current analysis or review switch to finish.");
        if (this.packageRiskPromises.size || this.packageAssessmentPromises.size) {
            throw new Error("Wait for the current package assessment to finish before switching reviews.");
        }
        this.switchingTarget = true;
        try {
            const resolved = await resolveReviewTarget(this.repoRoot, input);
            this.stopInternalReviews();
            this.saveCurrentReview();
            this.reviewTarget = resolved;
            this.selection = null;
            const cached = this.reviewCache.get(this.reviewCacheKey(resolved));
            this.decisionController?.abort();
            this.stopTestRun();
            this.testRun = cached?.testRun || null;
            this.ruleCheck = cached?.ruleCheck || null;
            if (cached) {
                this.reviewGeneration += 1;
                this.annotationPromises = new Map();
                this.model = cached.model;
                this.reviewEvidence = cached.reviewEvidence || null;
                this.reviewEvidenceModel = cached.model;
                this.annotations = cached.annotations;
                this.decisionMap = cached.decisionMap;
                this.decisionPromise = cached.decisionMap ? Promise.resolve(cached.decisionMap) : null;
                this.packageRisks = cached.packageRisks;
                this.packageAssessments = cached.packageAssessments;
                this.generatedObservations = cached.generatedObservations;
                this.customAnalyses = cached.customAnalyses;
                this.customPromptError = null;
                this.lastAnalyzedAt = cached.analyzedAt;
                this.baseRef = cached.baseRef ?? this.worktreeBaseRef;
                this.restoredFromCache = true;
                this.worktreeFingerprint = cached.worktreeFingerprint || null;
                this.worktreeChanged = cached.worktreeChanged || false;
                this.worktreeCheckError = cached.worktreeCheckError || null;
                this.loading = false;
                this.error = null;
                this.progress = { phase: "complete", message: "Saved review restored", percent: 100 };
                if (!this.decisionMap) this.startDecisionMap();
                this.broadcast("refreshed");
                this.startCustomAnalyses();
                return this.model;
            }
            this.model = null;
            this.annotations = {};
            this.decisionMap = null;
            this.decisionPromise = null;
            this.generatedObservations = [];
            return await this.refresh();
        } finally {
            this.switchingTarget = false;
            if (this.worktreeMonitorOwners) this.checkWorktreeChanges();
        }
    }

    reviewCacheKey(target = this.reviewTarget) {
        return JSON.stringify([target.mode, target.currentRef || null,
            target.mode === "worktree" ? this.worktreeBaseRef : target.baseRef]);
    }

    saveCurrentReview() {
        if (!this.model || this.loading || this.error) return;
        this.reviewCache.set(this.reviewCacheKey(), {
            target: { ...this.reviewTarget },
            baseRef: this.baseRef,
            model: this.model,
            annotations: this.annotations,
            decisionMap: this.decisionMap?.status === "complete" ? this.decisionMap : null,
            testRun: this.testRun?.status === "complete" ? this.testRun : null,
            ruleCheck: ["complete", "partial", "cancelled", "none"].includes(this.ruleCheck?.status) ? this.ruleCheck : null,
            packageRisks: this.packageRisks,
            packageAssessments: this.packageAssessments,
            generatedObservations: this.generatedObservations,
            analyzedAt: this.lastAnalyzedAt,
            worktreeFingerprint: this.worktreeFingerprint,
            worktreeChanged: this.worktreeChanged,
            worktreeCheckError: this.worktreeCheckError,
            customAnalyses: this.customAnalyses,
            reviewEvidence: this.reviewEvidenceModel === this.model ? this.reviewEvidence : null,
        });
    }

    // Runs after analysis completes so it never lengthens the repository scan.
    startDecisionMap() {
        const model = this.model;
        this.decisionController?.abort();
        this.decisionController = null;
        if (!model || !this.runDecisions) {
            this.decisionMap = null;
            this.decisionPromise = null;
            return null;
        }
        const controller = new AbortController();
        this.decisionController = controller;
        this.decisionMap = { status: "loading" };
        const started = Date.now();
        const current = () => this.model === model && !controller.signal.aborted && !this.disposed;
        const promise = new Promise((resolve) => setImmediate(resolve))
            .then(async () => {
                controller.signal.throwIfAborted();
                const maps = [];
                for (const request of buildCodePathRequests(model, this.repoRoot)) {
                    controller.signal.throwIfAborted();
                    const map = await this.runDecisions(request, { signal: controller.signal, workspacePath: this.workspacePath });
                    maps.push({ ...map, adapter_id: request.adapter_id });
                }
                return mergeCodePathMaps(maps);
            })
            .then((result) => attachCoverage({ ...result, status: "complete", total_ms: Date.now() - started }, model),
                (error) => ({ status: "error", error: `Decision extraction failed: ${error.message}` }))
            .then((map) => {
                if (this.decisionController === controller) this.decisionController = null;
                if (!current()) return null;
                if (map.status === "error") console.error("[agent-review decisions]", map.error);
                this.decisionMap = map;
                this.saveCurrentReview();
                this.broadcast("decisions");
                return map;
            });
        this.decisionPromise = promise;
        return promise;
    }

    async decisionMapFor(timeoutMs = 20_000) {
        const pending = this.decisionPromise;
        if (pending && this.decisionMap?.status === "loading") {
            try { await withTimeout(pending, timeoutMs, "Decision extraction timed out."); }
            catch { /* Explanations proceed without decisions rather than wait indefinitely. */ }
        }
        return this.decisionMap;
    }

    async testRunPlan() {
        const adapter = testAdapterForMap(this.decisionMap);
        const plan = adapter.tests.plan(this.decisionMap, this.repoRoot);
        const python = adapter.tests.resolveRuntime(this.repoRoot, await loadReviewConfig(this.repoRoot));
        const worktree = this.reviewTarget.mode === "worktree";
        let reason = plan.reason;
        if (this.loading) reason = "Wait for the analysis to finish.";
        else if (worktree && this.worktreeChanged) reason = "The worktree changed since this review. Reanalyze before running linked tests.";
        else if (!worktree && !this.reviewTarget.currentRef) reason = "This snapshot has no commit to export for testing.";
        return { ...plan, adapter_id: adapter.id, python: python.executable, python_source: python.source,
            command: adapter.tests.formatCommand ? adapter.tests.formatCommand(python, plan)
                : adapter.tests.command(python, plan).join(" "),
            location: worktree ? "the worktree" : `a temporary export of ${this.reviewTarget.label || this.reviewTarget.currentRef.slice(0, 7)}`,
            available: !reason, reason };
    }

    stopTestRun() {
        this.testRunController?.abort(new DOMException("Test run cancelled.", "AbortError"));
        this.testRunController = null;
        if (this.testRun?.status === "running") {
            this.testRun = { ...this.testRun, status: "cancelled", finished_at: new Date().toISOString() };
        }
    }

    // Only a worktree run can go stale: commit and PR snapshots are immutable.
    testRunStale() {
        return this.reviewTarget.mode === "worktree" && this.worktreeChanged;
    }

    promptTestRun() {
        return this.testRun ? { ...this.testRun, stale: this.testRunStale() } : null;
    }

    cancelTestRun() {
        this.stopTestRun();
        this.broadcast("test-run");
        return this.testRun;
    }

    // Explicit user action: executes the repository's tests, so it never starts automatically.
    async runLinkedTests() {
        if (this.disposed) throw new Error("This review has been closed.");
        if (this.testRun?.status === "running" || this.testRunStarting) throw new Error("Linked tests are already running.");
        // Marked before any await so concurrent requests cannot both start a run.
        this.testRunStarting = true;
        const map = this.decisionMap;
        const generation = this.reviewGeneration;
        let plan;
        let python;
        let adapter;
        try {
            plan = await this.testRunPlan();
            if (!plan.available) throw new Error(plan.reason);
            adapter = testAdapterForMap(map);
            python = adapter.tests.resolveRuntime(this.repoRoot, await loadReviewConfig(this.repoRoot));
            if (this.disposed || this.loading || this.refreshPromise || generation !== this.reviewGeneration
                || this.decisionMap !== map || this.testRunStale()) {
                throw new Error("The review changed before the linked tests could start. Try again.");
            }
        } finally {
            this.testRunStarting = false;
        }
        const controller = new AbortController();
        this.testRunController = controller;
        const snapshotRef = this.reviewTarget.mode === "worktree" ? null : this.reviewTarget.currentRef;
        const run = { status: "running", started_at: new Date().toISOString(), command: plan.command, location: plan.location,
            python: plan.python, python_source: plan.python_source, planned: plan.tests.length, omitted: plan.omitted };
        this.testRun = run;
        this.broadcast("test-run");
        this.testRunPromise = (async () => {
            const root = snapshotRef ? await exportSnapshot(this.repoRoot, snapshotRef, { signal: controller.signal }) : this.repoRoot;
            try {
                const executeTests = this.runTests || adapter.tests.run;
                const result = await executeTests({ repoRoot: root, python, plan: { ...plan, files: adapter.tests.plan(map, root).files },
                    signal: controller.signal, workspacePath: this.workspacePath });
                return { result, root };
            } finally {
                if (snapshotRef) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            }
        })()
            .then(({ result, root }) => {
                const results = Object.entries(result.trace.tests || {}).map(([id, record]) => ({
                    id, outcome: record.outcome, duration_ms: record.duration_ms }));
                const { executed, ran } = result.trace.per_test_path_evidence === false
                    ? { executed: {}, ran: {} } : mapExecutedPaths(map, result.trace, root);
                return { ...run, status: "complete", finished_at: new Date().toISOString(), exit_code: result.exit_code,
                    output: result.output, tests: results, executed, ran,
                    ...(result.path_evidence_limitation ? { path_evidence_limitation: result.path_evidence_limitation } : {}),
                    counts: Object.fromEntries(["passed", "failed", "error", "skipped"].map((outcome) =>
                        [outcome, results.filter((test) => test.outcome === outcome).length])) };
            }, (error) => controller.signal.aborted
                ? { ...run, status: "cancelled", finished_at: new Date().toISOString() }
                : { ...run, status: "error", finished_at: new Date().toISOString(), error: error.message })
            .then((outcome) => {
                if (this.testRunController === controller) this.testRunController = null;
                if (this.disposed || generation !== this.reviewGeneration || this.testRun !== run) return outcome;
                this.testRun = outcome;
                this.saveCurrentReview();
                this.broadcast("test-run");
                return outcome;
            });
        return run;
    }

    promptStore() {
        if (!this.customPromptStore || this.customPromptStore.repoRoot !== resolve(this.repoRoot)) {
            this.customPromptStore = new CustomPromptStore(this.repoRoot, this.customPromptOptions);
        }
        return this.customPromptStore;
    }

    startCustomAnalyses() {
        const model = this.model;
        if (model
            && !(model.changes || []).some((change) => change.status !== "unchanged")) return;
        this.runRuleCheck().catch((error) => console.error("[agent-review rule check]", error));
        this.runCustomAnalyses().catch((error) => {
            if (this.model !== model) return;
            this.customPromptError = error.message;
            this.broadcast("custom-analysis-error");
        });
    }

    // Built-in check: does the change satisfy the repository's own instruction files?
    stopInternalReviews(scope = null) {
        for (const controller of this.reviewControllers) {
            if (scope && controller.reviewScope !== scope) continue;
            controller.abort(new Error("Review cancelled or snapshot changed."));
            this.reviewControllers.delete(controller);
        }
    }

    discussionKey(id) {
        if (!this.model || this.loading) throw new Error("Wait for the saved review to finish.");
        this.contextFor(id);
        if (!this.discussionSnapshots.has(this.model)) {
            this.discussionSnapshots.set(this.model, reviewIdentity(this.model, "item-discussion-v1", null));
        }
        const snapshot = this.discussionSnapshots.get(this.model);
        return { snapshot, key: createHash("sha256").update(`${snapshot}:${id}`).digest("hex") };
    }

    reviewSectionsFor() {
        if (!this.model || this.loading) throw new Error("Wait for the saved review to finish.");
        return sectionsFor(this.model, this.reviewEvidenceModel === this.model ? this.reviewEvidence : null);
    }

    async discussionFor(id) {
        if (typeof id !== "string" || !id) throw new Error("Select an item to discuss.");
        const { snapshot, key } = this.discussionKey(id);
        if (this.discussionThreads.has(key)) return this.discussionThreads.get(key);
        if (this.discussionLoads.has(key)) return this.discussionLoads.get(key);
        const pending = (async () => {
            let thread = { id: key, snapshot, item_id: id, commit: this.model.metadata?.head_sha || null,
                label: this.reviewTarget.label, revision: 0, messages: [] };
            if (this.workspacePath) {
                try {
                    const saved = JSON.parse(await readFile(join(this.workspacePath, "files", "agent-review-discussions", `${key}.json`), "utf8"));
                    if (saved.id !== key || saved.snapshot !== snapshot || saved.item_id !== id || !Array.isArray(saved.messages)) {
                        throw new Error("Saved discussion does not match this review item and snapshot.");
                    }
                    if (saved.revision !== undefined && (!Number.isSafeInteger(saved.revision) || saved.revision < 0)) {
                        throw new Error("Saved discussion has an invalid revision.");
                    }
                    if (saved.messages.some((message) => !["user", "assistant"].includes(message.role)
                        || typeof message.id !== "string" || typeof message.content !== "string"
                        || !["complete", "generating", "stopped", "error"].includes(message.status)
                        || (message.citations && (!Array.isArray(message.citations) || message.citations.length > 20))
                        || (message.activity && !Array.isArray(message.activity)))) {
                        throw new Error("Saved discussion contains an invalid message.");
                    }
                    thread = saved;
                    for (const message of thread.messages) if (message.status === "generating") {
                        message.status = "error";
                        message.error = "This answer was interrupted when its provider stopped. Ask again to continue.";
                    }
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }
            }
            this.discussionThreads.set(key, thread);
            return thread;
        })().finally(() => this.discussionLoads.delete(key));
        this.discussionLoads.set(key, pending);
        return pending;
    }

    async saveDiscussion(thread) {
        if (!this.workspacePath) return;
        const directory = join(this.workspacePath, "files", "agent-review-discussions");
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${thread.id}.json`);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(thread));
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    async askDiscussion({ id, question, location = null }) {
        if (!this.model || this.loading) throw new Error("Wait for the saved review to finish.");
        if (typeof id !== "string" || !id) throw new Error("Select an item to discuss.");
        if (typeof question !== "string" || !question.trim() || question.length > 4000) {
            throw new Error("Enter a question of 1–4000 characters.");
        }
        if (!this.generateDiscussion) throw new Error("Copilot discussion is unavailable in this provider.");
        const model = this.model;
        const context = this.contextFor(id);
        if (location) {
            if (typeof location.path !== "string" || !Object.hasOwn(model.source_files || {}, location.path)
                || !Number.isSafeInteger(location.line) || location.line < 1 || !["base", "current"].includes(location.side)) {
                throw new Error("The discussion location must identify a saved source range.");
            }
            const source = await this.sourceForPath(location.path);
            const text = location.side === "base" ? source.base : source.current;
            if (typeof text !== "string" || location.line > text.split(/\r\n|\r|\n/).length) {
                throw new Error("The viewed discussion location is not available in this snapshot.");
            }
            context.discussion_location = { path: location.path, line: location.line, side: location.side };
        }
        context.test_evidence = decisionPromptContext(this.decisionMap,
            callablesForSubject(this.decisionMap, model, context.subject),
            { maxCallables: 8, maxEntries: 12, maxCharacters: 5000, run: this.promptTestRun() });
        const thread = await this.discussionFor(id);
        if (this.model !== model) throw new Error("The review changed before the discussion could start.");
        if (this.discussionRuns.has(thread.id)) throw new Error("Wait for this answer or stop it before asking another question.");
        if (thread.messages.length >= 200) throw new Error("This discussion has reached its 100-question limit.");
        const reservation = Promise.resolve();
        this.discussionRuns.set(thread.id, reservation);
        const history = [...thread.messages];
        const message = { id: randomUUID(), role: "assistant", content: "", status: "generating", activity: [], citations: [] };
        thread.messages.push({ id: randomUUID(), role: "user", content: question.trim(), status: "complete",
            ...(context.discussion_location ? { location: context.discussion_location } : {}) }, message);
        try { await this.saveDiscussion(thread); }
        catch (error) {
            thread.messages.splice(history.length);
            this.discussionRuns.delete(thread.id);
            throw error;
        }
        const controller = new AbortController();
        controller.reviewScope = `discussion:${thread.id}`;
        this.reviewControllers.add(controller);
        const publish = () => {
            thread.revision = (thread.revision || 0) + 1;
            this.discussionUpdate = thread;
            this.broadcast("discussion");
        };
        const run = Promise.resolve().then(async () => {
            context.explanation_context = await this.codeContextFor(context);
            controller.signal.throwIfAborted();
            if (this.model !== model) throw new Error("The saved snapshot changed while preparing discussion evidence.");
            return answerDiscussion({
            model, context, question: question.trim(), history, signal: controller.signal,
            generate: this.generateDiscussion,
            readSource: async (path, side) => {
                if (this.model !== model) throw new Error("The saved snapshot changed during discussion.");
                if (!Object.hasOwn(model.source_files || {}, path)) return null;
                const source = await this.sourceForPath(path);
                return side === "base" ? source.base : source.current;
            },
            onActivity: (activity) => {
                message.activity.push(activity);
                publish();
            },
            });
        }).then((answer) => {
            Object.assign(message, answer, { status: "complete" });
        }, (error) => {
            message.status = controller.signal.aborted ? "stopped" : "error";
            if (message.status === "error" && error instanceof ExplanationValidationError) {
                message.error = "Copilot could not produce a source-grounded answer. Retry, or rephrase the question.";
                message.error_detail = error.message.slice(0, 600);
            } else message.error = error.message;
        }).then(async () => {
            try { await this.saveDiscussion(thread); }
            catch (error) {
                message.status = "error";
                message.error = `Unable to save discussion: ${error.message}`;
                console.error("[agent-review discussion]", error);
            }
            publish();
        }).finally(() => {
            this.discussionRuns.delete(thread.id);
            this.reviewControllers.delete(controller);
        });
        this.discussionRuns.set(thread.id, run);
        publish();
        return thread;
    }

    async internalReview(instruction, { sources = [], onProgress, force = false, scope = "rules" } = {}) {
        const controller = new AbortController();
        controller.reviewScope = scope;
        this.reviewControllers.add(controller);
        const model = this.model;
        const repoRoot = this.repoRoot;
        let runtime;
        try {
            let modelId = await this.reviewModelId();
            controller.signal.throwIfAborted();
            runtime = await this.createReviewRuntime?.(modelId);
            modelId = runtime?.modelId || modelId;
            controller.signal.throwIfAborted();
            const result = await runReview({ model, instruction, sources,
                generate: (context, options) => this.generateReviewPass(context, { ...options, runtimeClient: runtime?.client, modelId }),
                modelId, directory: this.reviewDirectory, limits: this.reviewLimits,
                signal: controller.signal, onProgress, force,
                intent: this.reviewTarget.intent || null,
                readSource: async (path, side) => {
                    if (side !== "base" || !model.metadata?.base_sha) return null;
                    const sha = model.metadata.base_sha;
                    if (!await git(repoRoot, ["ls-tree", "--name-only", sha, "--", path])) return null;
                    return git(repoRoot, ["show", `${sha}:${path}`]);
                } });
            if (scope === "rules" && this.model === model && !this.disposed) {
                this.reviewEvidence = result;
                this.reviewEvidenceModel = model;
                this.reviewEvidenceRevision++;
                delete this.annotations.overview;
                this.annotationPromises.delete("overview");
            }
            return result;
        } finally {
            this.reviewControllers.delete(controller);
            await runtime?.dispose();
        }
    }

    async runRuleCheck({ force = false } = {}) {
        if (!this.model || this.loading || this.disposed) return this.ruleCheck;
        if (this.ruleCheck?.status === "running") return this.ruleCheckPromise;
        if (!force && ["complete", "none"].includes(this.ruleCheck?.status)) return this.ruleCheck;
        this.ruleCheckPromise = this.performRuleCheck(force);
        return this.ruleCheckPromise;
    }

    async performRuleCheck(force = false) {
        const model = this.model;
        const sources = repositoryRuleSources(model, { bounded: !this.generateReviewPass });
        const summary = sources.map(({ path, kind, applies_to: applies, truncated, changed_in_review: changed }) => ({
            path, kind, applies_to: applies.slice(0, 50), applicable_count: applies.length, truncated, changed_in_review: changed }));
        if (!sources.length) {
            this.ruleCheck = { status: "none", sources: [] };
            return this.ruleCheck;
        }
        if (!this.generateCustomAnalysis && !this.generateReviewPass) {
            this.ruleCheck = { status: "unavailable", sources: summary };
            this.broadcast("rule-check");
            return this.ruleCheck;
        }
        const check = { status: "running", sources: summary, started_at: new Date().toISOString() };
        this.ruleCheck = check;
        this.broadcast("rule-check");
        let outcome;
        try {
            if (this.generateReviewPass) {
                const result = await this.internalReview(RULES_PROMPT, { sources, force, onProgress: (progress) => {
                    if (this.ruleCheck !== check || this.model !== model) return;
                    check.coverage = progress;
                    this.broadcast("rule-check-progress");
                } });
                outcome = { ...check, ...result, observations: undefined, sources: summary, completed_at: new Date().toISOString() };
            } else {
                const context = ruleCheckContext(customAnalysisContext(model, RULE_EVIDENCE_OPTIONS), sources, model.source_files);
                const prompt = { id: "repository-rules", scope: "builtin", title: "Repository rules", prompt: RULES_PROMPT };
                const content = validateCustomAnalysis(await withTimeout(this.generateCustomAnalysis({ prompt, context }),
                    this.customAnalysisTimeoutMs, "The repository rules check timed out. Run it again."), context);
                outcome = { ...check, status: "complete", content, completed_at: new Date().toISOString() };
            }
        } catch (error) {
            outcome = { ...check, status: "error", error: error.message };
        }
        if (this.disposed || this.model !== model || this.ruleCheck !== check) return outcome;
        this.ruleCheck = outcome;
        this.saveCurrentReview();
        this.broadcast("rule-check");
        return outcome;
    }

    async runCustomAnalyses(input = {}) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Custom analysis options must be an object.");
        if (input.force !== undefined && typeof input.force !== "boolean") throw new Error("force must be a boolean.");
        if (input.id !== undefined && (typeof input.id !== "string" || !input.id || !["global", "repository"].includes(input.scope))) {
            throw new Error("A prompt id and valid scope are required.");
        }
        if (!this.model || this.loading) throw new Error("Wait for the review analysis to finish.");
        const model = this.model;
        const results = this.customAnalyses;
        const prompts = (await this.promptStore().list()).filter((prompt) => prompt.enabled && prompt.trusted);
        const selected = input.id ? prompts.filter((prompt) => prompt.id === input.id && prompt.scope === input.scope) : prompts;
        if (input.id && !selected.length) throw new Error("The requested prompt is missing, disabled, or requires approval.");
        if (selected.length && !this.generateCustomAnalysis && !this.generateReviewPass) throw new Error("Custom AI analysis is unavailable in this provider.");
        if (this.model !== model || this.customAnalyses !== results) throw new Error("The review changed before custom analysis could start.");
        let pending = this.customAnalysisPromises.get(results);
        if (!pending) {
            pending = new Map();
            this.customAnalysisPromises.set(results, pending);
        }
        const context = customAnalysisContext(model);
        let chain = Promise.resolve();
        const tasks = [];
        for (const prompt of selected) {
            const key = `${prompt.scope}:${prompt.id}:${prompt.revision}`;
            if (pending.has(key)) {
                tasks.push(pending.get(key));
                continue;
            }
            if (results[key] && !input.force && !["partial", "cancelled"].includes(results[key].status)) continue;
            const result = { id: prompt.id, scope: prompt.scope, revision: prompt.revision, title: prompt.title, status: "queued" };
            results[key] = result;
            const task = chain.then(async () => {
                if (this.disposed || this.customAnalyses !== results || this.model !== model) return;
                result.status = "running";
                if (this.customAnalyses === results) this.broadcast("custom-analysis");
                try {
                    if (this.generateReviewPass) {
                        const review = await this.internalReview(prompt.prompt, { force: input.force, scope: `custom:${key}`, onProgress: (progress) => {
                            if (this.customAnalyses !== results || this.model !== model) return;
                            result.coverage = progress;
                            this.broadcast("custom-analysis-progress");
                        } });
                        Object.assign(result, review, { observations: undefined });
                    } else {
                        result.content = validateCustomAnalysis(await withTimeout(this.generateCustomAnalysis({ prompt, context }),
                            this.customAnalysisTimeoutMs, "Custom analysis timed out. Retry this check."), context);
                        result.status = "complete";
                    }
                    result.completed_at = new Date().toISOString();
                } catch (error) {
                    result.status = "error";
                    result.error = error.message;
                } finally {
                    pending.delete(key);
                    if (this.customAnalyses === results) this.broadcast("custom-analysis");
                }
                return result;
            });
            pending.set(key, task);
            chain = task;
            tasks.push(task);
        }
        this.customPromptError = null;
        if (this.customAnalyses === results) this.broadcast("custom-analysis");
        await Promise.all(tasks);
        return Object.values(results);
    }

    async refreshSessionContext(broadcast = true) {
        if (!this.getSessionEvents || this.disposed) return null;
        const generation = this.reviewGeneration;
        try {
            const current = buildSessionContext(await this.getSessionEvents(), this.repoRoot);
            if (this.disposed || generation !== this.reviewGeneration) return null;
            current.session_id = this.currentSessionId;
            current.session_summary = "Current Agent Review session";
            for (const turn of current.turns) {
                turn.session_id = this.currentSessionId;
                turn.session_summary = current.session_summary;
            }
            this.sessionHistories.set(this.currentSessionId, current);
            this.sessionContext = mergeSessionContexts([...this.sessionHistories.values()]);
            if (this.sessionHistories.size > 1) {
                this.sessionContext.historical_search_complete = true;
                this.sessionContext.historical_session_count = this.sessionHistories.size - 1;
            }
            this.refreshHistoricalSessionContexts();
        } catch (error) {
            if (this.disposed || generation !== this.reviewGeneration) return null;
            this.sessionContext = {
                provenance: "copilot_session_history",
                factual_status: "context_only",
                intent: [],
                recent_activity: [],
                referenced_files: [],
                event_count: 0,
                generated_at: new Date().toISOString(),
                error: `Unable to read Copilot session history: ${error.message}`,
            };
        }
        if (broadcast) this.broadcast("session-context");
        return this.sessionContext;
    }

    refreshHistoricalSessionContexts() {
        if (!this.getHistoricalSessionContexts || this.disposed) return null;
        if (this.historicalContextPromise) return this.historicalContextPromise;
        if (this.sessionContext?.historical_search_complete) return null;
        if (!this.sessionContext) this.sessionContext = mergeSessionContexts([...this.sessionHistories.values()]);
        const generation = this.reviewGeneration;
        const pending = withTimeout(
            Promise.resolve().then(() => this.getHistoricalSessionContexts()),
            this.historicalSessionTimeoutMs,
            `Historical Copilot session search exceeded ${this.historicalSessionTimeoutMs >= 1000 ? `${Math.round(this.historicalSessionTimeoutMs / 1000)} seconds` : `${this.historicalSessionTimeoutMs} milliseconds`}.`,
        )
            .then(({ contexts, failures }) => {
                if (this.disposed || generation !== this.reviewGeneration) return;
                for (const context of contexts) {
                    this.sessionHistories.set(context.session_id, context);
                }
                this.sessionContext = mergeSessionContexts([...this.sessionHistories.values()]);
                this.sessionContext.history_failures = failures;
                this.sessionContext.historical_search_complete = true;
                this.sessionContext.historical_session_count = contexts.length;
                this.broadcast("session-history");
            })
            .catch((error) => {
                if (this.disposed || generation !== this.reviewGeneration) return;
                this.sessionContext.history_error = `Unable to read historical sessions: ${error.message}`;
                this.sessionContext.historical_search_complete = true;
                this.broadcast("session-history-failed");
            })
            .finally(() => {
                if (this.historicalContextPromise === pending) this.historicalContextPromise = null;
            });
        this.historicalContextPromise = pending;
        return this.historicalContextPromise;
    }

    sessionHistoryFor(sessionId) {
        const context = this.sessionHistories.get(sessionId);
        if (!context) throw new Error(`Session history is not loaded: ${sessionId}`);
        return {
            session_id: context.session_id,
            summary: context.session_summary,
            working_directory: context.working_directory || null,
            timeline: context.timeline || [],
            turns: context.turns || [],
        };
    }

    select(selection) {
        if (selection !== null && (!selection || typeof selection.id !== "string")) {
            throw new Error("Selection must contain an id.");
        }
        this.selection = selection;
        this.broadcast("selection");
        return this.contextFor(selection?.id);
    }

    contextFor(id = this.selection?.id) {
        if (!this.model) return null;
        if (!id) return { metadata: this.model.metadata, summary: this.model.summary, session_context: this.sessionContext };
        if (id.startsWith("section:")) return contextForSection(this.model, id,
            this.reviewEvidenceModel === this.model ? this.reviewEvidence : null, (subject) => this.contextFor(subject));
        const node = this.model.nodes?.find((item) => item.id === id);
        const edge = this.model.edges?.find((item) => item.id === id);
        const packageChange = this.model.package_changes?.find((item) => item.id === id
            || ((!item.ecosystem || item.ecosystem === "pypi") && `package:${item.name}` === id));
        const attention = this.model.attention?.find((item) => item.id === id);
        const observation = this.generatedObservations.find((item) => item.id === id);
        const evidence = this.model.evidence?.[id];
        const filePath = id?.startsWith("file:") ? id.slice("file:".length) : null;
        const fileChange = filePath ? this.model.changes?.find((candidate) => candidate.path === filePath) : null;
        const file = fileChange ? {
            id,
            kind: "file",
            type: "file",
            name: filePath,
            path: filePath,
            change: fileChange.status,
            start_line: null,
            end_line: null,
            metrics: {
                lines_added: fileChange.lines_added,
                lines_removed: fileChange.lines_removed,
                lines_changed: fileChange.lines_added + fileChange.lines_removed,
            },
            evidence_ids: [],
        } : null;
        const item = node || edge || packageChange || attention || observation || evidence || file;
        if (!item) throw new Error(`Unknown review item: ${id}`);
        const subject = node
            || (attention?.node_id ? this.model.nodes.find((candidate) => candidate.id === attention.node_id) : null)
            || (attention?.edge_id ? this.model.edges.find((candidate) => candidate.id === attention.edge_id) : null)
            || (attention?.package_id ? this.model.package_changes?.find((candidate) => candidate.id === attention.package_id)
                || this.model.package_dependencies?.find((candidate) => candidate.id === attention.package_id) : null)
            || packageChange
            || file;
        const evidenceIds = new Set(item.evidence_ids || []);
        if (this.model.evidence?.[id]) evidenceIds.add(id);
        const nodeById = new Map(this.model.nodes.map((candidate) => [candidate.id, candidate]));
        const relatedEdges = subject?.id
            ? this.model.edges.filter((candidate) => candidate.source === subject.id || candidate.target === subject.id)
            : [];
        return {
            item,
            subject,
            analysis_quality: {
                coverage_available: Boolean(this.model.coverage?.available),
                ...boundedAnalysisWarnings(this.model.warnings, subject?.path),
            },
            evidence: Object.fromEntries([...evidenceIds].filter((key) => this.model.evidence?.[key]).map((key) => [key, this.model.evidence[key]])),
            related_edges: relatedEdges.map((candidate) => ({
                ...candidate,
                source_summary: nodeById.has(candidate.source)
                    ? {
                        name: nodeById.get(candidate.source).name,
                        kind: nodeById.get(candidate.source).kind,
                        path: nodeById.get(candidate.source).path,
                    }
                    : null,
                target_summary: nodeById.has(candidate.target)
                    ? {
                        name: nodeById.get(candidate.target).name,
                        kind: nodeById.get(candidate.target).kind,
                        path: nodeById.get(candidate.target).path,
                    }
                    : null,
            })),
            related_symbols: subject?.kind === "module" || subject?.kind === "file"
                ? this.model.nodes
                    .filter((candidate) =>
                        ["class", "function", "method"].includes(candidate.kind)
                        && (subject.kind === "module" ? candidate.module_id === subject.id : candidate.path === subject.path)
                    )
                    .map((candidate) => ({
                        id: candidate.id,
                        kind: candidate.kind,
                        name: candidate.name,
                        change: candidate.change,
                        signatures: candidate.signatures,
                        metrics: candidate.metrics,
                    }))
                    .slice(0, 60)
                : [],
        };
    }

    addObservation(input) {
        const title = String(input.title || "").trim();
        const body = String(input.body || input.detail || "").trim();
        const evidenceIds = [...new Set((input.evidence_ids || []).map(String))];
        if (!title || !body) throw new Error("Observation title and body are required.");
        if (!evidenceIds.length) throw new Error("Every observation must cite at least one evidence id.");
        const unknown = evidenceIds.filter((id) => !this.model?.evidence?.[id]);
        if (unknown.length) throw new Error(`Unknown evidence ids: ${unknown.join(", ")}`);
        const observation = {
            id: `observation:${Date.now()}:${this.generatedObservations.length}`,
            title,
            body,
            severity: ["info", "low", "medium", "high"].includes(input.severity) ? input.severity : "info",
            evidence_ids: evidenceIds,
        };
        this.generatedObservations.push(observation);
        this.broadcast("observation");
        return observation;
    }

    async annotationFor(id, supplementalEvidenceIds = []) {
        if (this.annotations[id]) return this.annotations[id];
        if (!this.generateAnnotation) throw new Error("Copilot annotation is unavailable.");
        if (this.annotationPromises.has(id)) return this.annotationPromises.get(id);
        const context = this.contextFor(id);
        const generation = this.reviewGeneration;
        for (const evidenceId of supplementalEvidenceIds) {
            const evidence = this.model?.evidence?.[evidenceId];
            if (!evidence) throw new Error(`Unknown evidence id: ${evidenceId}`);
            context.evidence[evidenceId] = evidence;
        }
        const attributionPath = context.subject?.path
            || Object.values(context.evidence || {}).find((entry) => entry.path)?.path;
        const promise = (async () => {
            const history = this.refreshHistoricalSessionContexts();
            if (history) await history;
            if (generation !== this.reviewGeneration) throw new Error("The review changed while loading annotation context.");
            context.session_attribution = this.attributionForPath(attributionPath);
            context.session_intent = this.intentForReview(context.session_attribution).slice(-6);
            context.commit_intent = this.reviewTarget.intent || null;
            context.code_context = await this.codeContextFor(context);
            if (context.related_edges.length > 40) {
                context.analysis_quality.omitted_relationships = context.related_edges.length - 40;
                context.related_edges = context.related_edges.slice(0, 40);
            }
            if (this.decisionMap?.status === "loading") await this.decisionMapFor();
            if (generation !== this.reviewGeneration) throw new Error("The review changed while loading annotation context.");
            const subjectCallables = callablesForSubject(this.decisionMap, this.model, context.subject);
            context.decision_changes = subjectCallables.length
                ? decisionPromptContext(this.decisionMap, subjectCallables, { maxCallables: 12, maxEntries: 20, maxCharacters: 6000, run: this.promptTestRun() })
                : null;
            return this.generateAnnotation(context);
        })()
            .then((body) => {
                if (generation !== this.reviewGeneration) throw new Error("The review changed while generating this annotation.");
                const annotation = {
                    id: `annotation:${id}`,
                    item_id: id,
                    body: String(body || "").trim(),
                    source_scope: context.code_context ? {
                        current_complete: context.code_context.current?.complete ?? null,
                        base_complete: context.code_context.base?.complete ?? null,
                        limits: context.code_context.evidence_limits,
                    } : null,
                    evidence_ids: Object.keys(context.evidence || {}),
                    generated_at: new Date().toISOString(),
                };
                if (!annotation.body) throw new Error("Copilot returned an empty annotation.");
                this.annotations[id] = annotation;
                this.broadcast("annotation");
                return annotation;
            })
            .finally(() => {
                if (this.annotationPromises.get(id) === promise) this.annotationPromises.delete(id);
            });
        this.annotationPromises.set(id, promise);
        return promise;
    }

    async layerSummariesFor() {
        if (this.loading || !this.model) throw new Error("Wait for analysis to complete before summarizing layers.");
        if (this.annotations.layers) return this.annotations.layers;
        if (!this.generateLayerSummaries) throw new Error("Copilot layer summaries are unavailable in this provider.");
        if (this.annotationPromises.has("layers")) return this.annotationPromises.get("layers");
        const generation = this.reviewGeneration;
        const model = this.model;
        const promise = (async () => {
            const navigation = workspaceNavigation(model, this.reviewSectionsFor());
            const context = layerSummaryContext(model, navigation, this.annotations.overview?.body || null);
            const intents = context.layers.length ? await this.generateLayerSummaries(context) : {};
            if (generation !== this.reviewGeneration || this.model !== model) throw new Error("The review changed while summarizing layers.");
            const annotation = { id: "annotation:layers", item_id: "layers", intents, generated_at: new Date().toISOString() };
            this.annotations.layers = annotation;
            this.saveCurrentReview();
            this.broadcast("annotation");
            return annotation;
        })().finally(() => {
            if (this.annotationPromises.get("layers") === promise) this.annotationPromises.delete("layers");
        });
        this.annotationPromises.set("layers", promise);
        return promise;
    }

    async overviewFor() {
        if (this.loading) throw new Error("Wait for analysis to complete before generating the summary.");
        if (this.model
            && !(this.model.changes || []).some((change) => change.status !== "unchanged")) {
            throw new Error("This review has no changes to summarize.");
        }
        if (this.annotations.overview) return this.annotations.overview;
        if (!this.generateAnnotation) throw new Error("Copilot annotation is unavailable.");
        if (!this.model) throw new Error("Analysis is not complete.");
        if (this.annotationPromises.has("overview")) return this.annotationPromises.get("overview");
        const generation = this.reviewGeneration;
        let evidenceRevision = null;
        const promise = (async () => {
            const history = this.refreshHistoricalSessionContexts();
            if (history) await history;
            if (this.decisionMap?.status === "loading") await this.decisionMapFor();
            if (generation !== this.reviewGeneration) throw new Error("The review changed while loading summary context.");
            const context = this.overviewContext();
            if (this.generateReviewPass) {
                if (this.ruleCheck?.status === "running") await this.ruleCheckPromise;
                let review = this.reviewEvidenceModel === this.model ? this.reviewEvidence : null;
                if (!review) review = await this.internalReview(
                    "Explain observable before/after behavior across this change. Collect concrete correctness risks and test evidence. Investigate cross-file contracts, defaults and units.",
                    { scope: "overview" });
                if (generation !== this.reviewGeneration) throw new Error("The review changed while collecting summary evidence.");
                let remaining = 28_000;
                const evidence = [];
                // Rank confirmed concerns before behavior observations; keep underlying records intact.
                for (const item of [...review.findings, ...review.observations]) {
                    const characters = JSON.stringify(item).length;
                    if (characters > remaining) continue;
                    evidence.push(item);
                    remaining -= characters;
                }
                context.code_context = [];
                context.review_evidence = evidence;
                context.evidence_limits = { ...review.coverage, status: review.status,
                    omitted_records: review.findings.length + review.observations.length - evidence.length,
                    gaps: review.gaps.slice(0, 10), omitted_gaps: Math.max(0, review.gaps.length - 10) };
                evidenceRevision = this.reviewEvidenceRevision;
            }
            return this.generateAnnotation(context);
        })()
            .then((body) => {
                if (generation !== this.reviewGeneration) throw new Error("The review changed while generating this summary.");
                if (evidenceRevision !== null && evidenceRevision !== this.reviewEvidenceRevision) {
                    throw new Error("Review evidence changed while generating this summary. Generate it again.");
                }
                const annotation = {
                    id: "annotation:overview",
                    item_id: "overview",
                    body: String(body || "").trim(),
                    evidence_ids: [],
                    generated_at: new Date().toISOString(),
                };
                if (!annotation.body) throw new Error("Copilot returned an empty change summary.");
                this.annotations.overview = annotation;
                this.broadcast("annotation");
                return annotation;
            })
            .finally(() => {
                if (this.annotationPromises.get("overview") === promise) this.annotationPromises.delete("overview");
            });
        this.annotationPromises.set("overview", promise);
        return promise;
    }

    overviewContext() {
        const model = this.model;
        const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
        const files = model.changes
            .filter((change) => change.status !== "unchanged")
            .map((change) => ({
                path: change.path,
                status: change.status,
                added: change.lines_added,
                removed: change.lines_removed,
                is_test: isTestPath(change.path),
            }))
            .sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
        const totals = { source: { added: 0, removed: 0 }, tests: { added: 0, removed: 0 } };
        for (const file of files) {
            const bucket = file.is_test ? totals.tests : totals.source;
            bucket.added += file.added;
            bucket.removed += file.removed;
        }
        const seen = new Set();
        const findings = [];
        for (const finding of [...(model.attention || [])].sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0))) {
            const key = finding.node_id || finding.edge_id || finding.id;
            if (seen.has(key)) continue;
            seen.add(key);
            const node = nodeById.get(finding.node_id);
            findings.push({
                title: finding.title,
                subject: node ? { name: node.name, kind: node.kind, path: node.path } : null,
                impact_score: finding.impact_score,
                reason: finding.reason,
                factors: finding.impact_factors,
            });
            if (findings.length >= 12) break;
        }
        const attribution = files
            .filter((file) => !file.is_test)
            .slice(0, 3)
            .map((file) => ({ file, match: this.attributionForPath(file.path)[0] }))
            .filter((entry) => entry.match)
            .map(({ file, match }) => ({
                path: file.path,
                prompt: String(match.original_prompt || match.prompt || "").slice(0, 500),
                latest_file_request: match.original_prompt !== match.prompt ? String(match.prompt || "").slice(0, 500) : null,
                confidence: match.confidence,
            }));
        const savedCode = customAnalysisContext(model);
        return {
            kind: "overview",
            summary: model.summary,
            totals,
            files: files.slice(0, 30),
            omitted_files: Math.max(0, files.length - 30),
            findings,
            packages: (model.package_changes || []).map((item) => ({
                name: item.name,
                change: item.change,
                version: item.resolved_current || null,
            })),
            session_intent: this.intentForReview(attribution).slice(-4).map((item) => String(item.summary || "").slice(0, 500)),
            session_attribution: attribution,
            commit_intent: this.reviewTarget.intent || null,
            code_context: savedCode.files,
            evidence_limits: savedCode.evidence_limits,
            decision_map: decisionPromptContext(this.decisionMap, undefined, { run: this.promptTestRun() }),
            analysis_quality: {
                coverage_available: Boolean(model.coverage?.available),
                ...boundedAnalysisWarnings(model.warnings, null, { maxItems: 60, maxCharacters: 18_000 }),
                session_history_error: this.sessionContext?.history_error || this.sessionContext?.error || null,
            },
        };
    }

    async codeContextFor(context) {
        return annotationCodeContext(this.model, context, (path) => this.sourceForPath(path));
    }

    attributionForPath(path) {
        return findSessionAttribution(this.sessionContext, path, { before: this.reviewHistoryCutoff() });
    }

    reviewHistoryCutoff() {
        return this.reviewTarget.mode === "worktree" ? this.lastAnalyzedAt : this.model?.metadata?.generated_at || null;
    }

    intentForReview(attribution = []) {
        if (attribution.length) {
            return [...new Set(attribution.map((item) => item.original_prompt || item.prompt).filter(Boolean))]
                .map((summary) => ({ summary }));
        }
        if (["commit", "pr"].includes(this.reviewTarget.mode)) return [];
        const before = this.reviewHistoryCutoff();
        const cutoff = before === null ? null : Date.parse(before);
        if (cutoff !== null && !Number.isFinite(cutoff)) throw new Error("Review history cutoff must be a valid timestamp.");
        return (this.sessionContext?.intent || []).filter((item) => cutoff === null || Date.parse(item.timestamp) <= cutoff);
    }

    attributionStatusForPath(path) {
        const attribution = this.attributionForPath(path);
        if (attribution.length) return { status: "matched", attribution };
        if (this.sessionContext?.history_error) {
            return { status: "error", attribution, message: this.sessionContext.history_error };
        }
        if (!this.sessionContext?.historical_search_complete) {
            return { status: "loading", attribution, message: "Searching Copilot sessions for this repository…" };
        }
        return {
            status: "no_match",
            attribution,
            message: this.reviewTarget.mode === "worktree"
                ? "No originating prompt was found in Copilot sessions for this repository."
                : "No originating prompt was found in repository sessions at or before this commit.",
        };
    }

    async packageRiskFor(name, requestedVersion = null, { explain = true, ecosystem = null } = {}) {
        if (this.disposed) throw new Error("This review has been closed.");
        const generation = this.reviewGeneration;
        const candidates = (this.model?.package_dependencies || []).filter((item) => item.name === name
            && (!ecosystem || (item.ecosystem || "pypi") === ecosystem));
        if (candidates.length > 1) throw new Error(`Package ${name} is ambiguous across multiple ecosystems; specify its ecosystem.`);
        const dependency = candidates[0];
        if (!dependency) throw new Error(`Unknown package dependency: ${name}`);
        if (dependency.ecosystem === "npm" && dependency.declared_current?.some((item) =>
            item.workspace_link || item.local || item.private || /^(?:workspace:|file:|link:|portal:|git(?:\+|:)|https?:|github:|npm:)/.test(item.specifier || ""))) {
            throw new Error(`${name} is a local, workspace, alias, or non-registry dependency. Public npm assessment is not applicable.`);
        }
        if (dependency.ecosystem === "gomod" && dependency.declared_current?.some((item) => item.local)) {
            throw new Error(`${name} is replaced by local source. Public Go module assessment is not applicable.`);
        }
        if (dependency.ecosystem === "cargo" && dependency.declared_current?.some((item) =>
            item.local || item.non_registry || item.path_dependency || item.git || item.public_registry === false)) {
            throw new Error(`${name} is a path, Git, or non-registry crate. Public crates.io assessment is not applicable.`);
        }
        const declared = dependency.declared_current?.map((item) => item.specifier).filter(Boolean) || [];
        const resolutionError = dependency.declared_current?.find((item) => item.resolution_error)?.resolution_error;
        if (resolutionError) throw new Error(resolutionError);
        const exactPins = [...new Set(declared
            .map((value) => /^(?:===|==)\s*([^*,;<>=\s]+)$/.exec(value)?.[1])
            .filter(Boolean))];
        if (exactPins.length > 1) throw new Error(`Conflicting project version pins for ${name}: ${exactPins.join(", ")}.`);
        const version = exactPins[0] || dependency.resolved_current || null;
        if ((version && /[*,;<>=~^\s]/.test(version)) || (!version && requestedVersion)) {
            throw new Error(`An exact project version is required to assess ${name}; declared ${declared.join(", ") || "without a version"}. Pin or resolve the dependency, then reanalyze.`);
        }
        if (requestedVersion && requestedVersion !== version) throw new Error(`Requested version ${requestedVersion} does not match the reviewed project version ${name}@${version}.`);
        const packageEcosystem = dependency.ecosystem || "pypi";
        if (!["npm", "nuget", "pypi", "gomod", "cargo"].includes(packageEcosystem)) {
            throw new Error(`Package assessment for ${packageEcosystem} is not implemented.`);
        }
        const cacheKey = `${packageEcosystem === "pypi" ? "" : `${packageEcosystem}:`}${name}@${version ?? "<unresolved>"}`;
        const assessment = await this.packageAssessmentFor(cacheKey, name, version, packageEcosystem);
        if (this.disposed || generation !== this.reviewGeneration) throw new Error("The review changed while assessing this package.");
        if (!explain) return { assessment, explanation: this.packageRisks[cacheKey]?.explanation ?? null };
        if (this.packageRisks[cacheKey]) return this.packageRisks[cacheKey];
        if (this.packageRiskPromises.has(cacheKey)) return this.packageRiskPromises.get(cacheKey);
        const usageContext = buildPackageUsageContext(this.model, dependency, isTestPath);
        const promise = Promise.resolve()
            .then(() => this.generatePackageExplanation
                ? this.generatePackageExplanation({ dependency, assessment, usageContext })
                : null)
            .then((explanation) => {
                if (generation !== this.reviewGeneration) throw new Error("The review changed while explaining this package.");
                const result = { assessment, explanation };
                this.packageRisks[cacheKey] = result;
                this.broadcast("package-risk");
                return result;
            })
            .finally(() => this.packageRiskPromises.delete(cacheKey));
        this.packageRiskPromises.set(cacheKey, promise);
        return promise;
    }

    // Public-registry indicators are fast and independent of the slower Copilot explanation.
    packageAssessmentFor(cacheKey, name, version, ecosystem = "pypi") {
        if (this.disposed) return Promise.reject(new Error("This review has been closed."));
        if (this.packageAssessments.has(cacheKey)) return Promise.resolve(this.packageAssessments.get(cacheKey));
        if (!this.packageAssessmentPromises.has(cacheKey)) {
            const generation = this.reviewGeneration;
            const assessor = ecosystem === "npm" ? assessNpmPackageRisk
                : ecosystem === "nuget" ? assessNugetPackageRisk
                    : ecosystem === "gomod" ? assessGoModuleRisk
                        : ecosystem === "cargo" ? assessCratePackageRisk : assessPackageRisk;
            const promise = assessor(name, version, { includePopularity: true, metadataOnly: version === null, ecosystem })
                .then((assessment) => {
                    if (this.disposed || generation !== this.reviewGeneration) throw new Error("The review changed while assessing this package.");
                    this.packageAssessments.set(cacheKey, assessment);
                    return assessment;
                })
                .finally(() => this.packageAssessmentPromises.delete(cacheKey));
            this.packageAssessmentPromises.set(cacheKey, promise);
        }
        return this.packageAssessmentPromises.get(cacheKey);
    }
    async sourceFor(id) {
        const context = this.contextFor(id);
        const item = context?.item;
        const evidence = item?.path ? item : Object.values(context?.evidence || {}).find((entry) => entry.path);
        if (!evidence?.path) throw new Error("The selected item has no source location.");
        const preciseEvidence = evidence.kind !== "line_delta" && item?.type !== "size";
        const startLine = item?.path
            ? item.start_line || null
            : preciseEvidence ? evidence.line || null : null;
        const endLine = item?.path
            ? item.end_line || startLine
            : startLine;
        const source = await this.sourceForPath(
            evidence.path,
            startLine,
            endLine,
        );
        return { ...source, focus_side: item?.change === "removed" || context.subject?.change === "removed"
            || source.current === null ? "base" : "current" };
    }

    async sourceForPackageDeclaration(path, name, ecosystem = null) {
        const matches = (item) => item.name === name && (!ecosystem || (item.ecosystem || "pypi") === ecosystem)
            && [...item.declared_current || [], ...item.declared_base || [], ...item.declared_baseline || []]
                .some((declaration) => declaration.source === path);
        const dependency = this.model?.package_changes?.find(matches)
            || this.model?.package_dependencies?.find(matches);
        if (!dependency) throw new Error(`Unknown package dependency: ${name}`);
        const current = dependency.declared_current?.find((item) => item.source === path);
        const declaration = current || dependency.declared_base?.find((item) => item.source === path);
        if (!declaration || !Number.isInteger(declaration.line)) {
            throw new Error(`No saved declaration location for ${name} in ${path}. Reanalyze this review.`);
        }
        const source = await this.sourceForPath(path, declaration.line, declaration.end_line || declaration.line);
        return { ...source, declaration_highlight: {
            line: declaration.line, end_line: declaration.end_line || declaration.line,
            start_column: declaration.start_column, end_column: declaration.end_column,
            side: current ? "current" : "base",
        } };
    }

    async sourceForPath(path, startLine = null, endLine = startLine) {
        const model = this.model;
        if (!model) return { ...await this.readSourceSnapshot(path), start_line: startLine, end_line: endLine };
        let sources = this.sourceSnapshotCache.get(model);
        if (!sources) {
            sources = new Map();
            this.sourceSnapshotCache.set(model, sources);
        }
        if (!sources.has(path)) {
            const pending = this.readSourceSnapshot(path).catch((error) => {
                sources.delete(path);
                throw error;
            });
            sources.set(path, pending);
        }
        const snapshot = await sources.get(path);
        if (this.model !== model) throw new Error("The review changed while loading saved source.");
        return { ...snapshot, start_line: startLine, end_line: endLine };
    }

    async readSourceSnapshot(path) {
        const model = this.model;
        const root = this.repoRoot;
        const currentRef = this.reviewTarget.currentRef;
        const current = await this.readCurrentSource(path);
        if (this.model !== model) throw new Error("The review changed while loading saved source.");
        const saved = model?.source_files?.[path.replaceAll("\\", "/")];
        let base = null;
        let baseError = null;
        const baseSha = model?.metadata?.base_sha;
        if (saved && Object.hasOwn(saved, "baseline")) {
            base = saved.baseline;
        } else if (baseSha) {
            try {
                base = await git(root, ["show", `${baseSha}:${path.replaceAll("\\", "/")}`]);
            } catch (error) {
                baseError = `File is not present in the base snapshot: ${error.message}`;
            }
        }
        let diff = "";
        let diffError = null;
        if (baseSha) {
            try {
                diff = saved ? saved.diff || "" : await git(root, ["diff", "--no-ext-diff", "--unified=4", baseSha,
                    ...(currentRef ? [currentRef] : []), "--", path]);
            } catch (error) {
                diffError = `Unable to load the source diff: ${error.message}`;
            }

        }
        if (!diff && base === null && current !== null) {
            const lines = current.split(/\r?\n/);
            if (lines.at(-1) === "") lines.pop();
            diff = `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`;
        }
        return {
            path,
            current,
            base,
            base_error: baseError,
            diff,
            diff_error: diffError,
        };
    }

    async readCurrentSource(path) {
        const fullPath = safePath(this.repoRoot, path);
        const saved = this.model?.source_files?.[path.replaceAll("\\", "/")];
        if (saved) {
            if (saved.binary) throw new Error(`Cannot display ${path}: the analyzed file is not UTF-8 text.`);
            return saved.current;
        }
        if (this.model?.source_files) return null;
        if (this.reviewTarget.currentRef) {
            const name = path.replaceAll("\\", "/");
            const exists = await git(this.repoRoot, ["ls-tree", "--name-only", this.reviewTarget.currentRef, "--", name]);
            return exists ? git(this.repoRoot, ["show", `${this.reviewTarget.currentRef}:${name}`]) : null;
        }
        try {
            return await readFile(fullPath, "utf8");
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }
}
