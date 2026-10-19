import assert from "node:assert/strict";
import test from "node:test";
import { answerDiscussion, buildDiscussionVerificationPrompt, discussionContext, discussionPrompt, validateDiscussionResponse } from "../item-discussion.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewState } from "../review-state.mjs";

const model = { nodes: [], edges: [], evidence: {}, source_files: { "a.js": { current: "export const value = 1;\n" } } };
const context = { item: { id: "file:a.js", path: "a.js", name: "a.js" } };
test("discussion context is bounded and source citations must be supplied", () => {
    const input = discussionContext(model, context, [], "Explain.");
    assert.equal(input.evidence[0].path, "a.js");
    assert.throws(() => validateDiscussionResponse({
        answer: "Claim", limitation: "", citations: [{ evidence_id: input.evidence[0].id, line: 500 }], requests: [],
    }, input), /not supplied/);
});
test("only final discussion answers receive a separate operator-scope and example check", () => {
    const input = discussionContext(model, context, [], "Explain.");
    assert.equal(buildDiscussionVerificationPrompt(input, { answer: "", limitation: "", citations: [], requests: [
        { path: "a.js", side: "current", start_line: 1, end_line: 1 },
    ] }), null);
    const prompt = buildDiscussionVerificationPrompt(input, { answer: "The saved value is one.", limitation: "",
        citations: [{ evidence_id: input.evidence[0].id, line: 1 }], requests: [] });
    assert.match(prompt, /flag gates only B, never A/);
    assert.match(prompt, /The saved value is one/);
});
test("package attention questions retain the exact dependency identity and declarations", () => {
    const state = new ReviewState("C:\\repo");
    state.model = { ...model, attention: [{ id: "finding", package_id: "package:npm:example", title: "Package dependency added" }],
        package_changes: [{ id: "package:npm:example", name: "example", resolved_current: "1.2.3",
            declared_current: [{ source: "package.json", line: 2, specifier: "^1.2.3" }] }] };
    const context = state.contextFor("finding");
    assert.equal(context.subject.name, "example");
    const input = discussionContext(state.model, context, [], "Why this dependency?");
    assert.equal(input.item.package, "example");
    assert.equal(input.item.current_version, "1.2.3");
});
test("sampled section context never describes unprovided excerpts as missing saved files", () => {
    const paths = Array.from({ length: 90 }, (_, index) => `modules/route-${index}/adapter.js`);
    const reviewed = { ...model, source_files: { ...model.source_files,
        ...Object.fromEntries(paths.map((path) => [path, { current: "same analyzed function" }])) } };
    const input = discussionContext(reviewed, { ...context, section: {
        title: "Update adapters", ranges: paths.map((path) => ({ path, line: 1, end_line: 1, side: "current" })),
    } }, [], "Does grouping prove identical policies?");
    assert.equal(input.snapshot_availability.saved_files, 91);
    assert.equal(input.snapshot_availability.section_files, 90);
    assert.equal(input.snapshot_availability.section_files_present, 90);
    assert.equal(input.snapshot_availability.section_filename_counts["adapter.js"], 90);
    assert.ok(new Set(input.evidence.map((item) => item.path)).size < 90);
    assert.equal(input.section.omitted_range_catalog_entries, 50);
    assert.match(discussionPrompt(input), /not absent from the repository or snapshot/);
});
test("discussion retrieves unchanged saved code without executing it", async () => {
    let calls = 0;
    const result = await answerDiscussion({ model: { ...model, source_files: { ...model.source_files, "b.js": { current: "unchanged helper" } } },
        context, history: [], question: "Explain the helper.", onActivity: () => {},
        generate: async (input) => {
            calls++;
            if (calls === 1) return { answer: "", limitation: "", citations: [], requests: [
                { path: "b.js", side: "current", start_line: 1, end_line: 1 },
            ] };
            const evidence = input.evidence.find((item) => item.path === "b.js");
            return { answer: "The helper is unchanged.", limitation: "Execution is not established.",
                citations: [{ evidence_id: evidence.id, line: 1 }], requests: [] };
        } });
    assert.equal(result.content, "The helper is unchanged.");
    assert.equal(calls, 2);
});
test("large source requests are bounded internally rather than failing the user's question", async () => {
    let calls = 0;
    const longModel = { ...model, source_files: { ...model.source_files,
        "long.js": { current: Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join("\n") } } };
    const result = await answerDiscussion({ model: longModel, context, history: [], question: "Inspect the full range.", onActivity: () => {},
        generate: async (input) => {
            if (++calls === 1) return { answer: "", limitation: "", citations: [],
                requests: [{ path: "./long.js", side: "current", start_line: 1, end_line: 500 }] };
            const last = input.evidence.find((item) => item.path === "long.js" && item.lines.some((line) => line.line === 500));
            assert.ok(last, "the tail of the requested range was supplied");
            return { answer: "The requested tail is present.", limitation: "",
                citations: [{ evidence_id: last.id, line: 500 }], requests: [] };
        } });
    assert.equal(result.content, "The requested tail is present.");
});
test("invalid model ranges receive a bounded correction attempt instead of becoming an immediate UX failure", async () => {
    let calls = 0;
    const result = await answerDiscussion({ model, context, history: [], question: "Explain.", onActivity: () => {},
        generate: async (input) => {
            if (++calls === 1) return { answer: "", limitation: "", citations: [],
                requests: [{ path: "a.js", side: "current", start_line: 0, end_line: 1 }] };
            assert.match(input.validation_error, /1-based/);
            return { answer: "The saved value is one.", limitation: "",
                citations: [{ evidence_id: input.evidence[0].id, line: 1 }], requests: [] };
        } });
    assert.equal(result.content, "The saved value is one.");
    assert.equal(calls, 2);
});
test("a final-round invalid absolute range is repaired without exhausting successful retrieval rounds", async () => {
    let calls = 0;
    const reviewed = { ...model, source_files: { ...model.source_files, "b.js": { current: "one\ntwo\nthree\n" } } };
    const answer = await answerDiscussion({ model: reviewed, context, history: [], question: "Explain.", onActivity: () => {},
        generate: async (input) => {
            calls++;
            if (calls <= 3) return { answer: "", limitation: "", citations: [], requests: [
                { path: "b.js", side: "current", start_line: calls, end_line: calls },
            ] };
            if (calls === 4) return { answer: "", limitation: "", citations: [], requests: [
                { path: "b.js", side: "current", start_line: 201, end_line: 200 },
            ] };
            assert.match(input.validation_error, /end >= start/);
            return { answer: "Source inspected, not executed.", limitation: "No runtime proof.",
                citations: [{ evidence_id: input.evidence[0].id, line: 1 }], requests: [] };
        } });
    assert.equal(calls, 5);
    assert.equal(answer.content, "Source inspected, not executed.");
});
test("initial deeper discussion receives saved before/helper evidence including blank source lines", () => {
    const input = discussionContext(model, { ...context, explanation_context: {
        path: "a.js", current: { ranges: [] }, base: { ranges: [{ excerpt: "10: old result\n11: \n" }] },
        usages: [{ path: "helper.js", side: "current", role: "dependency",
            ranges: [{ excerpt: "5: if (!text.includes('cited:')) return null;\n" }] }],
        declarations: [], tests: [],
    } }, [], "Validate the example.");
    assert.ok(input.evidence.some((item) => item.side === "base" && item.lines.some((line) => line.line === 11 && line.text === "")));
    assert.ok(input.evidence.some((item) => item.path === "helper.js" && item.lines[0].text.includes("cited:")));
    assert.match(discussionPrompt(input), /201,end_line=400 is valid/);
});
test("cancellation reaches the model provider", async () => {
    const controller = new AbortController();
    let stopped = false;
    const pending = answerDiscussion({ model, context, history: [], question: "Explain.", signal: controller.signal,
        onActivity: () => {}, generate: async (_input, { signal }) => {
            signal.addEventListener("abort", () => { stopped = true; });
            controller.abort(new Error("Stopped"));
            return new Promise(() => {});
        } });
    await assert.rejects(pending, /Stopped/);
    assert.equal(stopped, true);
});

test("item conversations persist and never silently follow another snapshot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-discussion-"));
    const reviewed = () => ({ ...model, metadata: { head_sha: "one" }, changes: [
        { path: "a.js", status: "modified", lines_added: 1, lines_removed: 1 },
    ], attention: [], warnings: [], coverage: {} });
    try {
        const state = new ReviewState("C:\\repo", { workspacePath: workspace,
            generateDiscussion: async (input) => ({ answer: "The saved value is one.", limitation: "No tests were run.",
                citations: [{ evidence_id: input.evidence[0].id, line: 1 }], requests: [] }) });
        state.model = reviewed();
        const thread = await state.askDiscussion({ id: "file:a.js", question: "What changed?" });
        await state.discussionRuns.get(thread.id);
        assert.equal(thread.messages[1].status, "complete");
        const restored = new ReviewState("C:\\repo", { workspacePath: workspace });
        restored.model = reviewed();
        assert.equal((await restored.discussionFor("file:a.js")).messages[1].content, "The saved value is one.");
        restored.model = { ...reviewed(), metadata: { head_sha: "two" } };
        const newer = await restored.discussionFor("file:a.js");
        assert.notEqual(newer.id, thread.id);
        assert.deepEqual(newer.messages, []);
        assert.equal(thread.commit, "one");
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
test("questions carry validated viewed ranges without changing their pinned item", async () => {
    const state = new ReviewState("C:\\repo", { generateDiscussion: async (input) => {
        assert.deepEqual(input.viewed_location, { path: "a.js", line: 1, side: "base" });
        const evidence = input.evidence.find((item) => item.side === "base");
        return { answer: "This is the saved base.", limitation: "",
            citations: [{ evidence_id: evidence.id, line: 1 }], requests: [] };
    } });
    state.model = { ...model, source_files: { "a.js": { current: "new", baseline: "old" } },
        metadata: {}, changes: [{ path: "a.js", status: "modified" }] };
    const thread = await state.askDiscussion({ id: "file:a.js", question: "What is this line?",
        location: { path: "a.js", line: 1, side: "base" } });
    await state.discussionRuns.get(thread.id);
    assert.equal(thread.messages.at(-1).status, "complete");
    assert.equal(thread.item_id, "file:a.js");
    assert.equal(thread.messages[0].location.side, "base");
    await assert.rejects(state.askDiscussion({ id: "file:a.js", question: "Nope",
        location: { path: "../outside.js", line: 1, side: "current" } }), /saved source range/);
});
test("blank schema placeholder requests never fail a grounded answer", () => {
    const input = discussionContext(model, context, [], "Explain.");
    const result = validateDiscussionResponse({ answer: "The saved value is one.", limitation: "",
        citations: [{ evidence_id: input.evidence[0].id, line: 1 }],
        requests: [{ path: "", side: "current", start_line: 0, end_line: 0 }] }, input);
    assert.deepEqual(result.requests, []);
    assert.equal(result.limitation, "");
    assert.ok(buildDiscussionVerificationPrompt(input, { answer: "The saved value is one.", limitation: "",
        citations: [{ evidence_id: input.evidence[0].id, line: 1 }],
        requests: [{ path: "", side: "base", start_line: 0, end_line: 0 }] }), "final answers still receive verification");
});
test("a usable answer keeps its content when a stray follow-up range is malformed", () => {
    const input = discussionContext(model, context, [], "Explain.");
    const result = validateDiscussionResponse({ answer: "The saved value is one.", limitation: "",
        citations: [{ evidence_id: input.evidence[0].id, line: 1 }],
        requests: [{ path: "/etc/passwd", side: "current", start_line: 5, end_line: 1 }] }, input);
    assert.equal(result.content, "The saved value is one.");
    assert.deepEqual(result.requests, []);
    assert.match(result.limitation, /1 malformed source request was ignored/);
    assert.throws(() => validateDiscussionResponse({ answer: "", limitation: "", citations: [],
        requests: [{ path: "", side: "current", start_line: 3, end_line: 1 }] }, input), /Invalid saved range/);
});
test("failed generation shows plain-language guidance and keeps the technical detail separate", async () => {
    const { ExplanationValidationError } = await import("../ai-response.mjs");
    const state = new ReviewState("C:\\repo", { generateDiscussion: async () => {
        throw new ExplanationValidationError('Invalid saved range {"end_line":0,"path":""}');
    } });
    state.model = { ...model, metadata: {}, changes: [{ path: "a.js", status: "modified" }] };
    const thread = await state.askDiscussion({ id: "file:a.js", question: "Explain." });
    await state.discussionRuns.get(thread.id);
    const failed = thread.messages.at(-1);
    assert.equal(failed.status, "error");
    assert.doesNotMatch(failed.error, /saved range|end_line|\{/);
    assert.match(failed.error, /Retry/);
    assert.match(failed.error_detail, /Invalid saved range/);
    assert.equal(thread.messages.at(-2).content, "Explain.");
});

test("an item accepts only one active generation, and stop preserves an explicit stopped answer", async () => {
    const state = new ReviewState("C:\\repo", { generateDiscussion: async () => new Promise(() => {}) });
    state.model = { ...model, metadata: {}, changes: [{ path: "a.js", status: "modified" }] };
    const [first, second] = await Promise.allSettled([
        state.askDiscussion({ id: "file:a.js", question: "Explain." }),
        state.askDiscussion({ id: "file:a.js", question: "Explain again." }),
    ]);
    assert.equal([first, second].filter((item) => item.status === "fulfilled").length, 1);
    const thread = (first.status === "fulfilled" ? first : second).value;
    state.stopInternalReviews(`discussion:${thread.id}`);
    await state.discussionRuns.get(thread.id);
    assert.equal(thread.messages[1].status, "stopped");
    assert.ok(thread.messages[1].error);
});
