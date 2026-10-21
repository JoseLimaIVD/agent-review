import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// The file navigation and the evidence pane can be resized by dragging their borders or with the keyboard; widths
// persist, are clamped to keep the code readable, and reset with a double-click.
const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review.");
const progressEndpoint = new URL("/api/review-progress", url);
const original = await fetch(progressEndpoint).then((response) => response.json());
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });

async function openReview(page) {
    await page.waitForFunction(() => !document.querySelector("#overview-start").disabled);
    await page.locator("#overview-start").click();
    await page.waitForFunction(() => document.querySelector("#source")?.getAttribute("aria-busy") !== "true" && document.querySelector("#source .code-row"));
    await page.waitForFunction(() => !document.querySelector("#source-side-resize").classList.contains("hidden"), null, { timeout: 15_000 });
}
const width = (page, selector) => page.locator(selector).evaluate((node) => Math.round(node.getBoundingClientRect().width));
const handleCenter = async (page, selector) => {
    const box = await page.locator(selector).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 300) };
};
async function drag(page, selector, dx) {
    const from = await handleCenter(page, selector);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx / 2, from.y, { steps: 4 });
    await page.mouse.move(from.x + dx, from.y, { steps: 4 });
    await page.mouse.up();
}

try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?scoutTheme=light`);
    await page.evaluate(() => { localStorage.removeItem("agent-review.navigation-width"); localStorage.removeItem("agent-review.evidence-width"); });
    await page.reload();
    await openReview(page);

    // Navigation: dragging its border right widens it and the code moves with it.
    const nav0 = await width(page, "#review-navigation");
    const sideDefault = await width(page, ".source-side");
    await drag(page, "#workspace-nav-resize", 80);
    const nav1 = await width(page, "#review-navigation");
    assert.ok(Math.abs(nav1 - (nav0 + 80)) <= 3, `navigation widened by the drag (${nav0} → ${nav1})`);
    const panelLeft = await page.locator("#source-panel").evaluate((node) => Math.round(node.getBoundingClientRect().left));
    assert.ok(Math.abs(panelLeft - nav1) <= 2, "the code panel starts where the navigation ends");

    // Evidence pane: dragging its border left widens it; the handle stays on the pane's border.
    const side0 = await width(page, ".source-side");
    await drag(page, "#source-side-resize", -120);
    const side1 = await width(page, ".source-side");
    assert.ok(Math.abs(side1 - (side0 + 120)) <= 3, `evidence pane widened by the drag (${side0} → ${side1})`);
    const aligned = await page.evaluate(() => {
        const handle = document.querySelector("#source-side-resize").getBoundingClientRect();
        return Math.abs((handle.left + handle.width / 2) - document.querySelector(".source-side").getBoundingClientRect().left) <= 2;
    });
    assert.ok(aligned, "the evidence handle sits on the pane border");

    // Keyboard: arrows resize in 24 px steps; Home resets.
    await page.locator("#source-side-resize").focus();
    await page.keyboard.press("ArrowLeft");
    assert.ok(Math.abs(await width(page, ".source-side") - (side1 + 24)) <= 2, "ArrowLeft widens the evidence pane");
    await page.locator("#workspace-nav-resize").focus();
    await page.keyboard.press("ArrowLeft");
    assert.ok(Math.abs(await width(page, "#review-navigation") - (nav1 - 24)) <= 2, "ArrowLeft narrows the navigation");
    assert.equal(await page.locator("#workspace-nav-resize").getAttribute("role"), "separator");

    // Clamped: the code keeps at least 360 px however far the evidence pane is dragged.
    await drag(page, "#source-side-resize", -2000);
    const code = await width(page, ".code-frame");
    assert.ok(code >= 355, `the code keeps a usable width (${code}px)`);

    // Widths persist across a reload.
    const kept = { nav: await width(page, "#review-navigation"), side: await width(page, ".source-side") };
    await page.reload();
    await openReview(page);
    assert.ok(Math.abs(await width(page, "#review-navigation") - kept.nav) <= 2, "navigation width persists");
    assert.ok(Math.abs(await width(page, ".source-side") - kept.side) <= 2, "evidence width persists");

    // Double-click resets to the default layout.
    await page.locator("#workspace-nav-resize").dblclick();
    await page.locator("#source-side-resize").dblclick();
    assert.ok(Math.abs(await width(page, "#review-navigation") - nav0) <= 2, "double-click resets the navigation");
    assert.ok(Math.abs(await width(page, ".source-side") - sideDefault) <= 2, "double-click resets the evidence pane");

    // Narrow layouts stack the panes, so the handles are not shown.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#workspace-nav-resize").isVisible(), false);
    assert.equal(await page.locator("#source-side-resize").isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
    console.log(`PASS resizable panes: navigation ${nav0}→${nav1}px, evidence ${side0}→${side1}px, keyboard, clamp, persistence, reset, 390px`);
} finally {
    await browser.close();
    const current = await fetch(progressEndpoint).then((response) => response.json());
    await fetch(progressEndpoint, { method: "POST", body: JSON.stringify({ snapshot: current.snapshot, revision: current.revision,
        entries: original.entries, cursor: original.cursor }) });
}
