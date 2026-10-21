import assert from "node:assert/strict";
import test from "node:test";
import { runAnalyzerProcess } from "../review-state.mjs";

function jsonString(bytes) {
    return `
        const { once } = require("node:events");
        (async () => {
            process.stdout.write('"');
            const chunk = Buffer.alloc(64 * 1024, 97);
            let remaining = ${bytes};
            while (remaining > 0) {
                const count = Math.min(remaining, chunk.length);
                if (!process.stdout.write(chunk.subarray(0, count))) await once(process.stdout, "drain");
                remaining -= count;
            }
            process.stdout.write('"');
        })();
    `;
}

test("complete analyzer output above 128 MiB is accepted without truncation", async () => {
    const bytes = 128 * 1024 * 1024 + 1024;
    const value = await runAnalyzerProcess(process.execPath, ["-e", jsonString(bytes)]);
    assert.equal(value.length, bytes);
    assert.equal(value[0], "a");
    assert.equal(value.at(-1), "a");
});

test("analyzer output remains bounded at 256 MiB", async () => {
    const bytes = 256 * 1024 * 1024 + 1024;
    await assert.rejects(runAnalyzerProcess(process.execPath, ["-e", jsonString(bytes)]), /Analyzer output exceeded 256 MB/);
});
