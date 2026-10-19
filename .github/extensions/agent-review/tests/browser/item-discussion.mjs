import assert from "node:assert/strict";
import { openReviewTool } from "./review-details-helper.mjs";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReviewState } from "../../review-state.mjs";
import { ExplanationValidationError } from "../../ai-response.mjs";
import { startReviewServer } from "../../server.mjs";

const results = process.env.AGENT_REVIEW_LARGE_RESULTS;
if (!results) throw new Error("Set AGENT_REVIEW_LARGE_RESULTS to saved real repository results.");
const model = JSON.parse(await readFile(join(results, "model.json"), "utf8"));
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const workspace = await mkdtemp(join(tmpdir(), "discussion-browser-"));
let browser, server, state;
try {
    let calls = 0;
    let failNextValidation = false;
    state = new ReviewState(model.metadata.repo_root, { workspacePath: workspace,
        generateAnnotation: async () => "## Summary\n\nSaved source.\n\n## Review order\n\nInspect the selected item.\n\n## Gaps\n\nExecution not established.",
        generateDiscussion: async (input, { signal }) => {
            calls++;
            if (calls === 1) return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
            if (input.question === "Force a validation failure." && failNextValidation) {
                failNextValidation = false;
                throw new ExplanationValidationError('Copilot did not return a valid explanation: Invalid saved range {"end_line":0,"path":""}');
            }
            const item = input.evidence[0];
            return { answer: "This deterministic fault-path check uses saved source evidence.",
                limitation: "No tests were executed.", citations: [{ evidence_id: item.id, line: item.lines[0].line }], requests: [] };
        } });
    state.model = model;
    state.reviewTarget = { mode: "commit", currentRef: model.metadata.head_sha, label: "Saved large review" };
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await openReviewTool(page, "concerns");
        const ask = page.locator("#attention button[aria-label^='Ask about']").first();
        await ask.waitFor();
        await ask.click();
        const pane = page.locator("#item-discussion");
        const input = pane.getByRole("textbox", { name: "Ask about this item" });
        await input.waitFor();
        assert.equal(await input.isEnabled(), true);
        const box = await input.boundingBox();
        assert.ok(box.y >= 0 && box.y < 844, "opening Discussion brings the composer into view on narrow screens");
        await input.fill(theme === "light" ? "Explain the change." : "Follow up on this snapshot.");
        await pane.getByRole("button", { name: "Send", exact: true }).click();
        if (theme === "light") {
            await pane.getByRole("button", { name: "Stop answer", exact: true }).waitFor();
            await input.fill("A follow-up draft while evidence is being read.");
            const thread = [...state.discussionThreads.values()][0];
            thread.messages.at(-1).activity.push({ status: "active", label: "Inspecting another saved range" });
            state.discussionUpdate = thread;
            state.broadcast("discussion");
            await page.waitForTimeout(30);
            assert.equal(await input.inputValue(), "A follow-up draft while evidence is being read.");
            await pane.getByRole("button", { name: "Stop answer", exact: true }).click();
            await pane.getByText(/Stopped:/).waitFor();
            await pane.getByRole("button", { name: "Send", exact: true }).click();
        }
        try { await pane.getByText("Answer complete. This thread remains pinned to its saved snapshot.").waitFor(); }
        catch (error) {
            console.error(JSON.stringify({ calls, threads: [...state.discussionThreads.values()],
                pane: await pane.textContent(), question: await input.inputValue() }));
            throw error;
        }
        assert.ok(await pane.locator(".source-reference").count());
        await page.getByRole("button", { name: "Evidence", exact: true }).click();
        assert.equal(await pane.isVisible(), false);
        await page.getByRole("button", { name: "Discussion", exact: true }).click();
        assert.ok(await pane.getByText("This deterministic fault-path check uses saved source evidence.").count());
        await page.reload();
        await openReviewTool(page, "concerns");
        await ask.click();
        await pane.getByText("Answer complete. This thread remains pinned to its saved snapshot.").waitFor();
        assert.ok(await pane.locator(".discussion-user").count());
        failNextValidation = true;
        await input.fill("Force a validation failure.");
        await pane.getByRole("button", { name: "Send", exact: true }).click();
        const retry = pane.getByRole("button", { name: "Retry question", exact: true });
        await retry.waitFor();
        await pane.getByText(/Could not complete: Copilot could not produce a source-grounded answer/).last().waitFor();
        assert.equal(await input.inputValue(), "Force a validation failure.", "the failed question is restored for retry");
        assert.equal(await pane.getByText(/Invalid saved range/).last().isVisible(), false, "schema detail stays collapsed");
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `discussion-retry-${theme}.png`) });
        }
        await retry.click();
        await pane.getByText("Answer complete. This thread remains pinned to its saved snapshot.").waitFor();
        assert.equal(await retry.isVisible(), false);
        assert.equal(await input.inputValue(), "");
        await page.route("**/api/discussion", async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Deliberate provider failure"}' });
        });
        await input.fill("Keep this question after a failed request.");
        await pane.getByRole("button", { name: "Send", exact: true }).click();
        await pane.getByText("Deliberate provider failure").waitFor();
        assert.equal(await input.inputValue(), "Keep this question after a failed request.");
        assert.equal(await pane.getByRole("button", { name: "Send", exact: true }).isEnabled(), true);
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme}: narrow item chat, pinned thread, stop, draft retention, live updates, citations, reload and provider-error retry`);
        await page.close();
    }
} finally {
    await browser?.close();
    await state?.dispose();
    await server?.close();
    await rm(workspace, { recursive: true, force: true });
}
