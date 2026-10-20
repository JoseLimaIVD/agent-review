import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { reviewSequence, workspaceNavigation } from "../../web/review-workspace.mjs";

const url = process.env.AGENT_REVIEW_UX_URL;
if (!url) throw new Error("Set AGENT_REVIEW_UX_URL to an actual review with several review groups.");
const endpoint = new URL("/api/review-progress", url);
const original = await fetch(endpoint).then((response) => response.json());
const snapshot = await fetch(new URL("/api/state", url)).then((response) => response.json());
const sections = await fetch(new URL("/api/review-sections", url)).then((response) => response.json());
const sequence = reviewSequence(workspaceNavigation(snapshot.model, sections));
const { chromium } = createRequire(process.env.AGENT_REVIEW_BROWSER_PACKAGE || import.meta.url)("playwright-core");
const browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_REVIEW_BROWSER_EXECUTABLE || [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(existsSync) });
const restore = async (entries = original.entries, cursor = original.cursor) => {
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = await fetch(endpoint).then((response) => response.json());
        const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({
            snapshot: current.snapshot, revision: current.revision, entries, cursor }) });
        if (response.status === 409) continue;
        assert.equal(response.status, 200, "restore only this test's review metadata");
        return;
    }
    throw new Error("Unable to restore test review metadata.");
};
const location = (page) => page.locator(".workspace-file[aria-current='location']").first()
    .evaluate((button) => ({ path: button.dataset.path, group: button.dataset.group }));

try {
    for (const theme of ["light", "dark"]) {
        await restore({}, null);
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?scoutTheme=${theme}`);
        await page.locator("#overview-start").click();
        await page.locator("#file-review-next").waitFor();
        let current = await location(page);
        assert.deepEqual(current, { path: sequence[0].path, group: sequence[0].group }, "Start opens the first file in the rail");
        const reviewed = new Set();
        for (let step = 0; step < Math.min(5, sequence.length - 1); step++) {
            reviewed.add(current.path);
            const index = sequence.findIndex((entry) => entry.path === current.path && entry.group === current.group);
            const expected = [...sequence.slice(index + 1), ...sequence.slice(0, index + 1)].find((entry) => !reviewed.has(entry.path));
            await page.waitForFunction(() => !document.querySelector("#file-review-next").disabled);
            assert.match(await page.locator("#file-review-next").textContent(), new RegExp(`& next: ${expected.path.split("/").at(-1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
                `step ${step + 1}: Mark names the file it opens`);
            assert.match(await page.locator("#source-position").textContent(), /^\+\d[\d,]* −\d[\d,]*( · file \d+ of \d+ in .+)?$/);
            // Alternate the button and the M shortcut; both mark this file and open the named one.
            if (step % 2) {
                await page.locator("#source").focus();
                await page.keyboard.press("m");
            } else await page.locator("#file-review-next").click();
            await page.waitForFunction(({ path, group }) => {
                const button = document.querySelector(".workspace-file[aria-current='location']");
                return button?.dataset.path === path && button.dataset.group === group
                    && document.querySelector("#source")?.getAttribute("aria-busy") !== "true";
            }, { path: expected.path, group: expected.group }, { timeout: 15_000 }).catch(async (error) => {
                throw new Error(`step ${step + 1}: expected ${expected.group}:${expected.path}, got ${JSON.stringify(await location(page))}: ${error.message}`);
            });
            current = await location(page);
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${theme}: Mark file reviewed & next follows the visible rail for ${Math.min(5, sequence.length - 1)} steps`);
        await page.close();
    }
} finally {
    await browser.close();
    await restore();
}
