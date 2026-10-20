import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review with supplied line coverage.");
const snapshot = await fetch(new URL("/api/state", url)).then((response) => response.json());
const coverage = snapshot.model.coverage;
const missingLines = (item) => item.missing_lines
    || (item.executable_lines || []).filter((line) => !(item.covered_lines || []).includes(line));
const file = coverage?.files?.find((item) => coverage.changed_lines?.[item.path]?.total && missingLines(item).length);
if (!file) throw new Error("This review has no changed file with measured uncovered lines.");
file.missing_lines = missingLines(file);
const progress = new URL("/api/review-progress", url);
const original = await fetch(progress).then((response) => response.json());
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const marks = (page) => page.locator("#source .code-row[data-new-line]").evaluateAll((rows) => Object.fromEntries(rows
    .map((row) => [row.dataset.newLine, row.classList.contains("coverage-covered") ? "covered"
        : row.classList.contains("coverage-uncovered") ? "uncovered" : "none"])));
const ready = (page) => page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
    && document.querySelector("#source .code-row"));

try {
    for (const [theme, width] of [["light", 1280], ["dark", 390]]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.locator("#overview-start").click();
        await ready(page);
        if (width < 700) await page.locator("#workspace-nav-toggle").click();
        await page.locator("#workspace-files").click();
        await page.locator(".workspace-folder").evaluateAll((folders) => folders.forEach((folder) => { folder.open = true; }));
        await page.locator(`.workspace-file[data-path="${file.path}"]`).first().click();
        await page.waitForFunction((path) => document.querySelector("#source-title")?.textContent.startsWith(path.split("/").at(-1))
            || document.querySelector("#source-title")?.textContent.includes(path), file.path);
        await ready(page);
        for (const tab of ["diff", "current"]) {
            await page.locator(`.tab[data-tab='${tab}']`).click();
            await ready(page);
            const shown = await marks(page);
            for (const line of file.covered_lines) if (shown[line]) assert.equal(shown[line], "covered", `${tab} line ${line}`);
            for (const line of file.missing_lines) if (shown[line]) assert.equal(shown[line], "uncovered", `${tab} line ${line}`);
            const uncoveredChanged = coverage.changed_lines[file.path].uncovered_lines || [];
            assert.ok(uncoveredChanged.some((line) => shown[line] === "uncovered"), `${tab} marks a changed uncovered line`);
            const strip = page.locator("#source-strip-toggle");
            assert.match(await strip.textContent(), /of \d+ changed lines? executed|line coverage supplied/, "the strip summarizes coverage");
            if (await strip.getAttribute("aria-expanded") !== "true") await strip.click();
            const legend = page.locator("#source-coverage");
            assert.equal(await legend.isVisible(), true);
            assert.match(await legend.textContent(), /not executed/);
            assert.match(await legend.textContent(), /not proof of named tests/);
        }
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
            await page.locator("#source").evaluate((source, line) => source.querySelector(`.code-row[data-new-line="${line}"]`)
                ?.scrollIntoView({ block: "center" }), file.missing_lines[0]);
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `coverage-${theme}-${width}.png`) });
        }
        await page.locator(".tab[data-tab='base']").click();
        await ready(page);
        assert.equal(await page.locator("#source-coverage").isVisible(), false, "base side has no current-side coverage legend");
        assert.equal(await page.locator("#source .coverage-covered, #source .coverage-uncovered").count(), 0);
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme} ${width}px: ${file.path} coverage marks match the supplied run on Diff/Current, absent on Base`);
        await page.close();
    }
} finally {
    await browser.close();
    const current = await fetch(progress).then((response) => response.json());
    await fetch(progress, { method: "POST", body: JSON.stringify({ snapshot: current.snapshot, revision: current.revision,
        entries: original.entries, cursor: original.cursor }) });
}
