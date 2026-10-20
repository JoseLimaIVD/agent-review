import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReviewState } from "../../review-state.mjs";
import { startReviewServer } from "../../server.mjs";
const openChangeSummary = async (page) => {
    const details = page.locator("#review-background");
    if (await details.isVisible() && !await details.evaluate((element) => element.open)) await details.locator(":scope > summary").click();
};


const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const execute = promisify(execFile);
const repo = await mkdtemp(join(tmpdir(), "review-small-diff-gaps-"));
const git = (...args) => execute("git", ["-C", repo, ...args]);
let state, server, browser;
try {
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "core.autocrlf", "false");
    const lines = Array.from({ length: 74 }, (_, index) => `value_${index + 1} = ${index + 1}`);
    const large = Array.from({ length: 12_020 }, (_, index) => `# unchanged context ${index + 1}`);
    await writeFile(join(repo, "gaps.py"), `${lines.join("\n")}\n`);
    await writeFile(join(repo, "large-gap.py"), `${large.join("\n")}\n`);
    await git("add", ".");
    await git("commit", "-qm", "base");
    const changes = new Set([6, 16, 27, 39, 52, 66]);
    await writeFile(join(repo, "gaps.py"), `${lines.map((line, index) =>
        changes.has(index + 1) ? `${line} + 100` : line).join("\n")}\n`);
    await writeFile(join(repo, "large-gap.py"), `${large.map((line, index) =>
        index === 0 || index === large.length - 1 ? `${line} changed` : line).join("\n")}\n`);
    state = new ReviewState(repo, { baseRef: "HEAD", readWorktreeFingerprint: null });
    await state.refresh();
    server = await startReviewServer(state);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ].find(existsSync) });
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url}?scoutTheme=${theme}`);
        await openChangeSummary(page);
        await page.locator("#summary .metric").filter({ hasText: "Files" }).click();
        await page.locator(".collection-row").filter({ hasText: "gaps.py" }).click();
        await page.locator("#source .code-row").first().waitFor();
        assert.deepEqual(await page.locator("#source .diff-gap-toggle").allTextContents(),
            ["▾Show 5 unchanged lines (57–61)"], "only gaps of at least five lines have a toggle");
        for (const line of [1, 11, 21, 22, 32, 33, 34, 44, 45, 46, 47, 71, 72, 73, 74]) {
            const row = page.locator(`#source .code-row[data-new-line="${line}"]`);
            assert.equal(await row.count(), 1, `small-gap line ${line} is present exactly once`);
            assert.equal(await row.getAttribute("data-old-line"), String(line));
            assert.match(await row.textContent(), new RegExp(`value_${line} = ${line}`));
            assert.equal(await row.getAttribute("class"), "code-row diff-context");
        }
        assert.equal(await page.locator('#source .code-row[data-new-line="59"]').count(), 0);
        const toggle = page.locator('#source [data-gap="57-61"]');
        await toggle.focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator('#source .code-row[data-new-line="59"]').count(), 1);
        await page.keyboard.press(" ");
        assert.equal(await page.locator('#source .code-row[data-new-line="59"]').count(), 0);
        assert.equal(await page.locator('#source .code-row[data-new-line="44"]').count(), 1);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.locator('#source .code-row[data-new-line="44"]').count(), 1);
        assert.deepEqual(errors, []);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `small-diff-gaps-${theme}.png`), fullPage: true,
        });
        await page.locator("#source-close").click();
        await page.locator(".collection-row").filter({ hasText: "large-gap.py" }).click();
        const largeToggle = page.locator("#source .diff-gap-toggle");
        await largeToggle.waitFor();
        await largeToggle.click();
        await page.waitForFunction(() => document.querySelector("#source .diff-gap-toggle")?.getAttribute("aria-expanded") === "true");
        assert.ok(await page.locator("#source .code-row").count() > 12_000);
        assert.equal(await page.locator('#source .code-row[data-new-line="6000"]').getAttribute("data-old-line"), "6000");
        await largeToggle.click();
        await page.waitForFunction(() => document.querySelector("#source .diff-gap-toggle")?.getAttribute("aria-expanded") === "false");
        assert.ok(await page.locator("#source .code-row").count() < 30);
        assert.deepEqual(errors, []);
        await page.close();
    }
    console.log("PASS: small gaps stay visible, five-line gaps support keyboard toggles, and 12,010-line gaps expand/collapse in light/dark and narrow views.");
} finally {
    await browser?.close();
    await state?.dispose();
    await server?.close();
    await rm(repo, { recursive: true, force: true });
}
