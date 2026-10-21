export function aiPlaceholder(label, lines = 3) {
    const wrapper = document.createElement("div");
    wrapper.className = "ai-pending";
    wrapper.setAttribute("role", "status");
    wrapper.setAttribute("aria-live", "polite");
    const heading = document.createElement("p");
    heading.className = "ai-pending-label";
    const dot = document.createElement("span");
    dot.className = "ai-pending-dot";
    dot.setAttribute("aria-hidden", "true");
    heading.append(dot, document.createTextNode(label));
    wrapper.append(heading);
    const widths = [94, 81, 88, 67, 90, 74];
    for (let index = 0; index < lines; index++) {
        const bar = document.createElement("span");
        bar.className = "ai-pending-line";
        bar.setAttribute("aria-hidden", "true");
        bar.style.width = `${widths[index % widths.length]}%`;
        wrapper.append(bar);
    }
    return wrapper;
}
