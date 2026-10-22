import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { runAnalyzerProcess } from "../review-state.mjs";

test("compressed analyzer results preserve saved source and progress events", async () => {
    const model = { source_files: { "source.txt": { current: "saved source \u00e9\n", baseline_same: true } } };
    const bytes = gzipSync(JSON.stringify(model));
    const events = [];
    const actual = await runAnalyzerProcess(process.execPath, ["-e", `
        process.stderr.write('AGENT_REVIEW_PROGRESS {"phase":"serialization","percent":98}\\n');
        process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"));
    `], (event) => events.push(event), { gzip: true });
    assert.equal(actual.source_files["source.txt"].current, "saved source \u00e9\n");
    assert.equal(actual.source_files["source.txt"].baseline, actual.source_files["source.txt"].current);
    assert.deepEqual(events, [{ phase: "serialization", percent: 98 }]);
});

test("a complete saved-source result larger than 128 MiB crosses the bounded compressed transport", async () => {
    const megabytes = 129;
    const result = await runAnalyzerProcess(process.execPath, ["-e", `
        const { createGzip } = require("node:zlib");
        const { once } = require("node:events");
        (async () => {
            const compressed = createGzip({ level: 1 });
            compressed.pipe(process.stdout);
            compressed.write('{"source_files":{"large.txt":{"current":"');
            const chunk = "x".repeat(1024 * 1024);
            for (let index = 0; index < ${megabytes}; index++) {
                if (!compressed.write(chunk)) await once(compressed, "drain");
            }
            compressed.end('","baseline_same":true}}}');
        })().catch((error) => { console.error(error); process.exitCode = 1; });
    `], () => {}, { gzip: true });
    const source = result.source_files["large.txt"];
    assert.equal(source.current.length, megabytes * 1024 * 1024);
    assert.equal(source.current.at(-1), "x", "the tail is retained, not silently truncated");
    assert.equal(source.baseline, source.current);
    assert.equal(Object.hasOwn(source, "baseline_same"), false);
});

test("invalid or truncated compressed results fail explicitly rather than returning partial evidence", async () => {
    const valid = gzipSync('{"source_files":{}}');
    for (const bytes of [Buffer.from("not gzip"), valid.subarray(0, valid.length - 4), gzipSync("{")]) {
        await assert.rejects(runAnalyzerProcess(process.execPath, ["-e",
            `process.stdout.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64"));`],
        () => {}, { gzip: true }), /Analyzer returned invalid JSON/);
    }
});
