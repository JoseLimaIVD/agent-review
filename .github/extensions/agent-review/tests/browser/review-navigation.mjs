import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseReviewLocation } from "../../web/review-location.mjs";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual repository review.");
const snapshot = await fetch(new URL("/api/state", url)).then((response) => response.json());
const path = snapshot.model.changes.find((change) => change.path === "src/retry/resolve-policy.js")?.path
    || snapshot.model.changes.find((change) => change.status !== "unchanged" && change.status !== "deleted"
        && /\.(?:py|cs|[cm]?[jt]sx?)$/.test(change.path))?.path;
assert.ok(path, "Need a changed source file.");
const source = await fetch(new URL(`/api/source?${new URLSearchParams({ path })}`, url)).then((response) => response.json());
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
        await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
            configurable: true, value: { writeText: async (text) => { window.copiedReviewLocation = text; } },
        }));
        await page.route("**/api/discussion", (route) => route.request().method() === "POST"
            ? route.fulfill({ status: 503, contentType: "application/json",
                body: JSON.stringify({ error: "Navigation regression stops before model generation." }) })
            : route.continue());
        await page.goto(`${url}?scoutTheme=${theme}`);
        // The priority queue lives under Explore; keyboard-opening its first row must move focus into source.
        await page.locator(".workspace-explore summary").click();
        await page.locator("#explore-priorities").click();
        const firstCard = page.locator("#graph .review-plan-row").first();
        await firstCard.waitFor();
        await firstCard.focus();
        await firstCard.press("Enter");
        await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
            && document.querySelector("#source-panel")?.contains(document.activeElement));
        await page.locator("#source-close").click();
        await page.locator("#workspace-find").click();
        const dialog = page.locator("#review-command-palette");
        await page.locator("#review-command-query").fill(path);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.waitForFunction((path) => document.querySelector("#source-title")?.textContent === path
            && document.querySelector("#source")?.getAttribute("aria-busy") !== "true", path);
        await page.locator("#source").focus();
        await page.keyboard.press("f");
        assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("review-source-focus")), true);
        assert.equal(await page.locator(".source-side").isVisible(), false);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#source-panel").isVisible(), true, "Escape exits focus before closing source");
        assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("review-source-focus")), false);
        await page.locator("#source-location").click();
        const link = await page.evaluate(() => window.copiedReviewLocation);
        const target = parseReviewLocation(new URL(link).hash);
        assert.equal(target.path, path);
        assert.equal(target.snapshot, snapshot.model.review_snapshot_key);
        await page.goto(link);
        await page.locator("#source .focus-start").waitFor();
        assert.equal(await page.locator("#source-title").textContent(), `${path}:${target.line}`);
        assert.equal(await page.locator("#source .focus-start").getAttribute(target.side === "base" ? "data-old-line" : "data-new-line"), String(target.line));
        // J twice then K: stepping back must return to the earlier concern (wrap-around may land on a path-less aggregate).
        for (const key of ["j", "j", "k"]) {
            await page.locator("#source").focus();
            const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/source");
            await page.keyboard.press(key);
            const selected = await (await response).json();
            await page.waitForFunction((title) => document.querySelector("#source-title")?.textContent === title
                && document.querySelector("#source")?.getAttribute("aria-busy") !== "true",
            `${selected.path}${selected.start_line ? `:${selected.start_line}` : ""}`);
            assert.equal(await page.evaluate(() => document.querySelector("#source-panel").contains(document.activeElement)),
                true, `${key.toUpperCase()} must keep visible keyboard focus inside source`);
        }
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#source-panel").isVisible(), false);
        assert.notEqual(await page.evaluate(() => document.activeElement.tagName), "BODY");
        await page.keyboard.press("Control+k");
        await dialog.waitFor();
        await page.locator("#review-command-query").fill("f");
        await page.keyboard.type("aij");
        assert.equal(await page.locator("#review-command-query").inputValue(), "faij", "review shortcuts must not steal typing");
        await page.keyboard.press("Escape");
        assert.equal(await dialog.isVisible(), false);
        for (const side of ["current", "base"]) {
            if (typeof source[side] !== "string") continue;
            const line = Math.min(8, source[side].split(/\r?\n/).length);
            const pinned = new URL(link);
            const values = new URLSearchParams(pinned.hash.slice(1));
            for (const [key, value] of Object.entries({ side, tab: side, line: String(line) })) values.set(key, value);
            pinned.hash = values.toString();
            await page.goto(pinned.href);
            await page.locator("#source .focus-start").waitFor();
            await page.locator("#source").focus();
            await page.keyboard.press("a");
            const input = page.locator("#item-question");
            await input.waitFor();
            await input.fill("Explain only the highlighted saved range.");
            await page.waitForFunction(() => document.querySelector("#item-discussion button[type='submit']")?.disabled === false);
            const request = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/discussion"
                && request.method() === "POST");
            await input.press("Control+Enter");
            assert.deepEqual((await request).postDataJSON().location, { path, line, side },
                "restored highlighted locations must reach question context, not the first visible context row");
            await page.locator("#item-discussion").getByText("Navigation regression stops before model generation.", { exact: true }).waitFor();
        }
        const wrong = new URL(link);
        const values = new URLSearchParams(wrong.hash.slice(1));
        values.set("snapshot", "another-snapshot");
        wrong.hash = values.toString();
        let sourceRequests = 0;
        page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/source") sourceRequests++; });
        await page.goto(wrong.href);
        await page.locator("#error").getByText(/another source snapshot/).waitFor();
        assert.equal(sourceRequests, 0, "mismatched source links must not load newer code");
        assert.equal(await page.locator("#source-panel").isVisible(), false);
        assert.equal(await page.locator("#error").evaluate((notice) => notice === document.activeElement), true,
            "a mismatch must expose and focus its warning instead of leaving it behind an existing source pane");
        await page.reload();
        await page.locator("#error").getByText(/another source snapshot/).waitFor();
        assert.equal(sourceRequests, 0, "fresh mismatched links must not load newer code either");
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) await page.screenshot({
            path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `review-navigation-${theme}.png`),
        });
        console.log(`PASS ${theme}: finder, visible J/K focus, exact question ranges, local links, foreground mismatch warnings and editable-field protection`);
        await page.close();
    }
} finally { await browser.close(); }
