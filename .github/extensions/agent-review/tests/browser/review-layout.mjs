import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review.");
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });

const insideViewport = (page, selector) => page.locator(selector).evaluateAll((items) => items
    .filter((item) => item.getClientRects().length)
    .map((item) => ({ text: item.textContent.trim().slice(0, 40), right: item.getBoundingClientRect().right, limit: document.documentElement.clientWidth }))
    .filter((item) => item.right > item.limit + 1));
const impactVisibility = (page) => page.evaluate(() => {
    const host = document.querySelector(".impact-graph").getBoundingClientRect();
    const nodes = [...document.querySelectorAll(".impact-graph .node")].map((node) => ({
        rect: node.getBoundingClientRect(), focus: /Changed focus|Selected focus/.test(node.textContent) }));
    const inside = ({ rect }) => rect.top >= host.top - 1 && rect.bottom <= host.bottom + 1 && rect.left >= host.left - 1 && rect.right <= host.right + 1;
    return { total: nodes.length, visible: nodes.filter(inside).length, focusVisible: nodes.some((node) => node.focus && inside(node)),
        hostHeight: host.height, svgHeight: document.querySelector(".impact-graph svg").getBoundingClientRect().height };
});
// No relationship may disappear under an unrelated tile (it reads as a chain); tiles never overlap or share a label.
const impactLegibility = (page) => page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".impact-graph .node")].map((node) => ({ id: node.dataset.nodeId,
        rect: node.querySelector("rect").getBoundingClientRect(),
        label: [...node.querySelectorAll(".node-name")].map((text) => text.textContent).join("") }));
    let overlaps = 0, hidden = 0, stubs = 0;
    for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i].rect, b = tiles[j].rect;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++;
    }
    for (const path of document.querySelectorAll(".impact-graph .edge")) {
        // Layout units, independent of zoom: a spoke shorter than this reads as an arrowhead stub, not a relationship.
        if (path.getTotalLength() < 40) stubs++;
    }
    for (const path of document.querySelectorAll(".impact-graph .edge:not(.edge-over)")) {
        const length = path.getTotalLength(), matrix = path.getScreenCTM();
        for (let step = 3; step <= 37; step++) {
            const local = path.getPointAtLength(length * step / 40);
            const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
            if (tiles.some(({ rect }) => point.x > rect.left + 2 && point.x < rect.right - 2 && point.y > rect.top + 2 && point.y < rect.bottom - 2)) { hidden++; break; }
        }
    }
    return { overlaps, hidden, stubs, duplicateLabels: tiles.length - new Set(tiles.map((tile) => tile.label)).size };
});

try {
    for (const [theme, width] of [["light", 1440], ["dark", 1280]]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.locator("#overview-start").click();
        await page.locator("#source-panel").waitFor();
        await page.waitForFunction(() => document.querySelector("#source")?.querySelector(".code-row"));

        const workspace = await page.locator("section.workspace").evaluate((element) => ({
            right: element.getBoundingClientRect().right, limit: document.documentElement.clientWidth }));
        assert.ok(workspace.right <= workspace.limit + 1, `workspace must end at the viewport edge: ${JSON.stringify(workspace)}`);

        const explore = page.locator(".workspace-explore");
        await explore.locator("summary").click();
        await page.locator("#explore-priorities").click();
        await page.locator("#graph .review-plan-row").first().waitFor();
        assert.deepEqual(await insideViewport(page, "#graph .review-plan-open, #graph .impact-score, #graph .review-next, .graph-controls input, .graph-controls button"), [],
            "priority queue actions stay inside the viewport");
        await page.locator("#graph .review-plan-row").first().click();
        await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true"
            && document.querySelector("#source")?.querySelector(".code-row"));

        await page.locator("#source-impact").click();
        await page.locator(".impact-graph .node").first().waitFor();
        let impact = await impactVisibility(page);
        assert.ok(impact.svgHeight <= impact.hostHeight + 1, `impact canvas is a bounded viewport: ${JSON.stringify(impact)}`);
        assert.equal(impact.focusVisible, true, "the changed focus opens in view");
        assert.deepEqual(await impactLegibility(page), { overlaps: 0, hidden: 0, stubs: 0, duplicateLabels: 0 }, "impact relationships stay legible");
        const expand = page.getByRole("button", { name: /Expand one step/ });
        if (await expand.isEnabled()) {
            await expand.click();
            await page.waitForFunction((count) => document.querySelectorAll(".impact-graph .node").length !== count, impact.total)
                .catch(() => {});
            impact = await impactVisibility(page);
            assert.equal(impact.focusVisible, true, `the focus stays in view after Expand: ${JSON.stringify(impact)}`);
        }
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        impact = await impactVisibility(page);
        assert.equal(impact.visible, impact.total, `Fit shows every impact node: ${JSON.stringify(impact)}`);
        assert.deepEqual(await impactLegibility(page), { overlaps: 0, hidden: 0, stubs: 0, duplicateLabels: 0 }, "expanded impact stays legible");

        await page.locator(".impact-graph .node").first().click();
        await page.locator(".impact-evidence").waitFor();
        assert.deepEqual(await insideViewport(page, ".detail button, .detail h2, .detail h3, .graph-panel button, .impact-toolbar select"), [],
            "Impact details and toolbar stay inside the viewport");
        if (process.env.AGENT_REVIEW_SCREENSHOT_DIR) {
            await page.screenshot({ path: join(process.env.AGENT_REVIEW_SCREENSHOT_DIR, `layout-impact-${theme}-${width}.png`) });
        }

        await explore.locator("summary").click();
        assert.equal(await explore.evaluate((element) => element.open), true);
        await page.keyboard.press("Escape");
        assert.equal(await explore.evaluate((element) => element.open), false, "Escape closes Explore");
        await explore.locator("summary").click();
        await page.locator("#graph").click({ position: { x: 20, y: 20 } });
        assert.equal(await explore.evaluate((element) => element.open), false, "an outside click closes Explore");
        await explore.locator("summary").click();
        await page.locator("#workflow-review").click();
        assert.equal(await explore.evaluate((element) => element.open), false, "navigating closes Explore");
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme} ${width}px: bounded workspace, impact viewport/fit, details reachable, Explore dismissal`);
        await page.close();
    }
} finally {
    await browser.close();
}
