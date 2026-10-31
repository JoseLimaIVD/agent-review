import assert from "node:assert/strict";
import test from "node:test";
import { ReviewState } from "../review-state.mjs";
import { browserSnapshot, startReviewServer } from "../server.mjs";

const model = (value = "current") => ({
    metadata: { base_sha: "immutable-base" }, nodes: [], edges: [], attention: [], warnings: [],
    coverage: {}, changes: [], source_files: {
        "value.js": { current: `${value}\n`, baseline: "base\n", diff: `@@ -1 +1 @@\n-base\n+${value}\n` },
    },
});

test("browser snapshots omit internal precomputed code paths and saved source bodies", () => {
    const saved = model();
    saved.code_paths = { csharp: { callables: [{ id: "internal" }] } };
    const snapshot = browserSnapshot({ model: saved, review_target: { mode: "worktree" } });
    assert.equal(snapshot.model.code_paths, undefined);
    assert.deepEqual(snapshot.model.source_files["value.js"], { binary: false });
    assert.ok(saved.code_paths.csharp, "the provider retains the compiler result");
});

test("concurrent source selections reuse one immutable snapshot while preserving their own focus ranges", async () => {
    const state = new ReviewState("C:\\missing-source-cache-test");
    state.model = model();
    const read = state.readCurrentSource.bind(state);
    let reads = 0;
    state.readCurrentSource = async (path) => { reads++; return read(path); };
    const sources = await Promise.all(Array.from({ length: 20 }, (_, i) => state.sourceForPath("value.js", i + 1)));
    assert.equal(reads, 1);
    assert.deepEqual(sources.map((source) => source.start_line), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.ok(sources.every((source) => source.base === "base\n" && source.base_error === null));
    state.model = model("new snapshot");
    const changed = await state.sourceForPath("value.js", 3, 4);
    assert.equal(reads, 2);
    assert.equal(changed.current, "new snapshot\n");
    assert.equal(changed.start_line, 3);
    assert.equal(changed.end_line, 4);
});

test("a source lookup from a replaced review cannot populate the new snapshot cache", async () => {
    const state = new ReviewState("C:\\missing-source-cache-test");
    state.model = model();
    const read = state.readCurrentSource.bind(state);
    let release;
    state.readCurrentSource = async (path) => {
        const source = await read(path);
        await new Promise((resolve) => { release = resolve; });
        return source;
    };
    const pending = state.sourceForPath("value.js");
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.model = model("new");
    release();
    await assert.rejects(pending, /review changed/);
    state.readCurrentSource = read;
    assert.equal((await state.sourceForPath("value.js")).current, "new\n");
});

test("failed source requests are evicted so a retry is not permanently poisoned", async () => {
    const state = new ReviewState("C:\\missing-source-cache-test");
    state.model = model();
    const read = state.readCurrentSource.bind(state);
    state.readCurrentSource = async () => { throw new Error("Read failed"); };
    await assert.rejects(state.sourceForPath("value.js"), /Read failed/);
    state.readCurrentSource = read;
    assert.equal((await state.sourceForPath("value.js")).current, "current\n");
});

test("selection and annotation events do not resend source or the full model", async () => {
    const state = new ReviewState("C:\\missing-source-cache-test");
    state.model = model();
    state.model.source_files["value.js"].current = "large snapshot\n".repeat(10000);
    const server = await startReviewServer(state);
    const controller = new AbortController();
    try {
        const response = await fetch(new URL("/events", server.url), { signal: controller.signal });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        const next = async () => {
            for (;;) {
                while (!buffered.includes("\n\n")) {
                    const part = await reader.read();
                    assert.equal(part.done, false);
                    buffered += decoder.decode(part.value, { stream: true });
                }
                const end = buffered.indexOf("\n\n");
                const event = buffered.slice(0, end);
                buffered = buffered.slice(end + 2);
                const data = event.split("\n").find((line) => line.startsWith("data: "));
                if (data) return JSON.parse(data.slice(6));
            }
        };
        await next();
        state.selection = { id: "file:value.js", kind: "file" };
        state.broadcast("selection");
        const selection = await next();
        assert.equal(selection.partial, true);
        assert.equal(selection.selection.id, "file:value.js");
        assert.equal(selection.model, undefined);
        assert.ok(JSON.stringify(selection).length < 500);
        state.annotations["file:value.js"] = { body: "Saved analysis." };
        state.broadcast("annotation");
        const annotation = await next();
        assert.equal(annotation.partial, true);
        assert.equal(annotation.model, undefined);
        assert.equal(annotation.annotations["file:value.js"].body, "Saved analysis.");
        assert.ok(JSON.stringify(annotation).length < 500);
        await reader.cancel();
    } finally {
        controller.abort();
        await server.close();
    }
});
