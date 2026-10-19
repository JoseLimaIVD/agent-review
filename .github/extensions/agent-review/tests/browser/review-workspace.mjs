import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { reviewSequence, workspaceNavigation } from "../../web/review-workspace.mjs";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review.");
const snapshot = await fetch(new URL("/api/state", url)).then((response) => response.json());
const changed = snapshot.model.changes.filter((file) => file.status !== "unchanged").map((file) => file.path).sort();
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
try {
    for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.locator("#overview-start").click();
        await page.locator("#source-panel").waitFor();
        await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
            && document.querySelector("#source")?.querySelector(".code-row"));
        try {
            await page.waitForFunction(() => /\d+ layers?/.test(document.querySelector("#workspace-count")?.textContent || ""));
        } catch (error) {
            console.error(JSON.stringify({ theme, errors, grouping: await page.locator("#workspace-count").textContent(),
                notice: await page.locator("#error").textContent(), source: await page.locator("#source-title").textContent() }));
            throw error;
        }
        assert.equal(await page.locator("#review-navigation").isVisible(), true);
        assert.ok((await page.locator("#review-navigation").boundingBox()).x < (await page.locator("#source-panel").boundingBox()).x);
        const title = await page.locator("#source-title").textContent();
        await page.locator(".tab[data-tab='current']").click();
        await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true");
        const position = await page.locator("#source").evaluate((source) => {
            source.scrollTop = Math.min(280, source.scrollHeight - source.clientHeight);
            window.workspaceSavedRow = source.querySelector(".code-row");
            return source.scrollTop;
        });
        await page.locator("#source-impact").click();
        await page.locator(".impact-graph .node").first().waitFor();
        const toolbar = await page.locator(".graph-controls button").evaluateAll((buttons) => buttons
            .filter((button) => button.getClientRects().length).map((button) => {
                const rect = button.getBoundingClientRect();
                return { text: button.textContent, left: rect.left, right: rect.right, viewport: innerWidth };
            }));
        assert.ok(toolbar.every((button) => button.left >= 0 && button.right <= button.viewport),
            `Impact tools must stay reachable inside the viewport: ${JSON.stringify(toolbar)}`);
        await page.locator("#workspace-return-source").click();
        await page.waitForFunction((title) => document.querySelector("#source-title")?.textContent === title
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true", title);
        assert.equal(await page.locator(".tab[data-tab='current']").evaluate((tab) => tab.classList.contains("active")), true);
        assert.ok(Math.abs((await page.locator("#source").evaluate((source) => source.scrollTop)) - position) <= 1);
        assert.equal(await page.locator("#source").evaluate((source) => source.querySelector(".code-row") === window.workspaceSavedRow), true,
            "Impact roundtrip reuses the source DOM");
        await page.locator("#workflow-overview").click();
        await page.locator("#review-overview").waitFor();
        await page.locator("#workflow-review").click();
        await page.locator("#source-panel").waitFor();
        assert.equal(await page.locator("#source-title").textContent(), title);
        const sections = await fetch(new URL("/api/review-sections", url)).then((response) => response.json());
        const navigation = workspaceNavigation(snapshot.model, sections);
        const sequence = reviewSequence(navigation).map(({ path, group }) => ({ path, group }));
        const selected = await page.locator(".workspace-file[aria-current='location']").first().evaluate((button) =>
            ({ path: button.dataset.path, group: button.dataset.group }));
        let cursor = sequence.findIndex((entry) => entry.path === selected.path && entry.group === selected.group);
        await page.route("**/api/annotation", (route) => route.fulfill({ status: 503, contentType: "application/json",
            body: '{"error":"Keyboard routing regression does not generate extra explanations."}' }));
        await page.locator("#source-title").click();
        for (const key of ["j", "j", "j", "k"]) {
            cursor = (cursor + (key === "j" ? 1 : sequence.length - 1) + sequence.length) % sequence.length;
            await page.keyboard.press(key);
        }
        const expected = sequence[cursor];
        await page.waitForFunction((expected) => document.querySelector("#source-title")?.textContent.startsWith(expected.path)
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
            && [...document.querySelectorAll(".workspace-file[aria-current='location']")]
                .some((button) => button.dataset.group === expected.group && button.dataset.path === expected.path), expected);
        assert.equal(await page.locator("#source-panel").evaluate((panel) => panel.contains(document.activeElement)), true);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
            await mkdir(process.env.AGENT_REVIEW_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `workspace-${theme}-1280.png`) });
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator("#workspace-context").click();
        assert.equal(await page.locator(".source-side").isVisible(), true);
        assert.equal(await page.locator(".code-frame").isVisible(), false);
        await page.locator("#workspace-code").click();
        assert.equal(await page.locator(".code-frame").isVisible(), true);
        await page.locator("#workspace-nav-toggle").click();
        await page.locator("#review-navigation").waitFor();
        await page.locator("#workspace-files").click();
        assert.deepEqual(await page.locator("#workspace-nav-list .workspace-file").evaluateAll((buttons) =>
            buttons.map((button) => button.dataset.path).sort()), changed);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#review-navigation").isVisible(), false);
        assert.equal(await page.locator("#source-panel").isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `workspace-${theme}-390.png`),
        });
        await page.close();
        console.log(`PASS ${theme}: persistent Groups/Files, exact code/Impact return, cached rows, resume, focused narrow panes and all ${changed.length} files`);
    }
} finally { await browser.close(); }
