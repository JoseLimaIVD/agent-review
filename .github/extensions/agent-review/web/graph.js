const SVG_NS = "http://www.w3.org/2000/svg";
const savedPositions = new Map();
const graphResizers = new WeakMap();

function svg(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}

function displayName(node) {
    return node.display_name || node.name || node.qualified_name || node.id;
}

// Impact tiles show the last two qualified segments; namespaces made .NET tests truncate to identical text.
// File and module nodes keep their whole file name ("contracts.test.js", not "test.js").
function tileName(node) {
    const name = displayName(node);
    if (!node.impact_role) return name;
    if (["module", "file"].includes(node.kind) || /[\\/]/.test(name) || /\.(?:[cm]?[jt]sx?|py|cs|go|rs|java|rb|php|kt|swift)$/i.test(name)) {
        return name.split(/[\\/]/).at(-1);
    }
    const paren = name.indexOf("(");
    const head = paren >= 0 ? name.slice(0, paren) : name;
    const parts = head.split(".");
    return parts.length > 2 ? `${parts.slice(-2).join(".")}${paren >= 0 ? name.slice(paren) : ""}` : name;
}

const isImpactFocus = (node) => ["Changed focus", "Selected focus"].includes(node.impact_role);
// Normalised ring spacing keeps 192×104 tiles apart at every angle on an ellipse 1.8× wider than tall.
const RING_SPACING = 165;
const RING_ASPECT = 1.8;

// Blast-radius layout: focus at the centre, each hop on an outer ring, dependencies left and consumers/tests right,
// so every direct relationship is an unobstructed spoke instead of passing under intermediate tiles.
function radialImpactPositions(nodes, edges) {
    const ids = new Set(nodes.map((node) => node.id));
    const adjacent = new Map(nodes.map((node) => [node.id, new Set()]));
    for (const edge of edges) {
        if (edge.source === edge.target || !ids.has(edge.source) || !ids.has(edge.target)) continue;
        adjacent.get(edge.source).add(edge.target);
        adjacent.get(edge.target).add(edge.source);
    }
    const hop = new Map();
    const queue = nodes.filter(isImpactFocus).map((node) => node.id);
    if (!queue.length && nodes.length) queue.push(nodes[0].id);
    queue.forEach((id) => hop.set(id, 0));
    for (let index = 0; index < queue.length; index++) {
        for (const next of adjacent.get(queue[index])) {
            if (!hop.has(next)) { hop.set(next, hop.get(queue[index]) + 1); queue.push(next); }
        }
    }
    const outer = Math.max(0, ...hop.values()) + 1;
    for (const node of nodes) if (!hop.has(node.id)) hop.set(node.id, outer);
    const rings = [];
    for (const node of nodes) (rings[hop.get(node.id)] ||= []).push(node);
    const angle = new Map();
    const positions = new Map();
    const place = (node, radius, theta) => {
        angle.set(node.id, theta);
        positions.set(node.id, { x: Math.cos(theta) * radius * RING_ASPECT, y: Math.sin(theta) * radius });
    };
    const centre = rings[0] || [];
    const centreRadius = centre.length > 1 ? Math.max(90, RING_SPACING * centre.length / (2 * Math.PI)) : 0;
    centre.forEach((node, index) => place(node, centreRadius, -Math.PI / 2 + 2 * Math.PI * index / Math.max(1, centre.length)));
    let radius = centreRadius;
    for (let ring = 1; ring < rings.length; ring++) {
        const members = rings[ring] || [];
        if (!members.length) continue;
        // Ring gaps leave visible spokes even for diagonal neighbours (tile edges at least ~80px apart).
        radius = Math.max(radius + (ring === 1 && !centreRadius ? 250 : 230), RING_SPACING * members.length / (2 * Math.PI));
        const parentAngle = (node) => {
            const parents = [...adjacent.get(node.id)].filter((id) => hop.get(id) < ring && angle.has(id)).map((id) => angle.get(id));
            return parents.length ? Math.atan2(parents.reduce((sum, value) => sum + Math.sin(value), 0),
                parents.reduce((sum, value) => sum + Math.cos(value), 0)) : 0;
        };
        const left = members.filter((node) => node.impact_role === "Dependency");
        const right = members.filter((node) => node.impact_role !== "Dependency");
        const order = (group) => group.map((node) => ({ node, parent: parentAngle(node) }))
            .sort((a, b) => a.parent - b.parent || (a.node.impact_role || "").localeCompare(b.node.impact_role || ""));
        const spread = (group, centreAngle, arc) => order(group).forEach(({ node }, index) =>
            place(node, radius, centreAngle - arc / 2 + arc * (index + .5) / group.length));
        if (ring === 1 && left.length && right.length) {
            const leftArc = 2 * Math.PI * left.length / members.length;
            spread(left, Math.PI, leftArc);
            spread(right, 0, 2 * Math.PI - leftArc);
        } else if (ring === 1) spread(members, !right.length ? Math.PI : 0, 2 * Math.PI);
        else {
            // Outer hops sit beside their parents, pushed apart only as far as tiles need.
            const ordered = order(members);
            const gap = Math.min(2 * Math.PI / members.length, RING_SPACING / radius);
            const thetas = ordered.map(({ parent }) => parent);
            for (let index = 1; index < thetas.length; index++) thetas[index] = Math.max(thetas[index], thetas[index - 1] + gap);
            const shift = thetas.reduce((sum, theta, index) => sum + theta - ordered[index].parent, 0) / thetas.length;
            if (thetas.at(-1) - thetas[0] > 2 * Math.PI - gap) spread(members, 0, 2 * Math.PI);
            else ordered.forEach(({ node }, index) => place(node, radius, thetas[index] - shift));
        }
    }
    return positions;
}

function impactRadialFrame(nodes, edges, width) {
    const relative = radialImpactPositions(nodes, edges);
    const ys = [...relative.values()].map((point) => point.y);
    const height = Math.max(440, Math.max(...ys) - Math.min(...ys) + 200);
    const offsetY = height / 2 - (Math.max(...ys) + Math.min(...ys)) / 2;
    return { height, positions: new Map([...relative].map(([id, point]) => [id, savedPositions.get(`impact:${id}`)
        || { x: width / 2 + point.x, y: point.y + offsetY }])) };
}

function wrapLabel(value, max = 24) {
    if (value.length <= max) return [value];
    // Split at the last natural boundary (after "." "_" "," or a space, before "(") rather than mid-word.
    let splitAt = -1;
    for (let index = Math.min(max, value.length - 1); index > max / 3; index--) {
        if (/[._, ]/.test(value[index - 1]) || value[index] === "(") { splitAt = index; break; }
    }
    const index = splitAt > 0 ? splitAt : max;
    const first = value.slice(0, index).trimEnd();
    const remainder = value.slice(index).trimStart();
    return remainder.length <= max ? [first, remainder] : [first, `${remainder.slice(0, max - 1)}…`];
}

const NODE_CELL_WIDTH = 216;
const NODE_CELL_HEIGHT = 184;
function graphHeight(nodeCount, width, nodes = [], edges = []) {
    if (nodes.some((node) => node.impact_role)) {
        if (width < 650) return Math.max(440, nodeCount * NODE_CELL_HEIGHT);
        return impactRadialFrame(nodes, edges, width).height;
    }
    const columns = Math.max(1, Math.floor(width / NODE_CELL_WIDTH));
    return Math.max(440, Math.ceil(nodeCount / columns) * NODE_CELL_HEIGHT);
}

function layout(nodes, width, height, edges = []) {
    if (nodes.some((node) => node.impact_role)) {
        if (width >= 650) return impactRadialFrame(nodes, edges, width).positions;
        const groups = [nodes.filter((node) => node.impact_role === "Dependency"), nodes.filter(isImpactFocus),
            nodes.filter((node) => node.impact_role !== "Dependency" && !isImpactFocus(node))];
        let offset = 0;
        return new Map(groups.flatMap((group) => {
            const points = group.map((node, index) => [node.id, savedPositions.get(`impact:${node.id}`) || {
                x: width / 2, y: (offset + index) * NODE_CELL_HEIGHT + NODE_CELL_HEIGHT / 2,
            }]);
            offset += group.length;
            return points;
        }));
    }
    const columns = Math.min(nodes.length, Math.max(1, Math.floor(width / NODE_CELL_WIDTH)));
    const rows = Math.ceil(nodes.length / columns);
    const cellWidth = width / columns;
    const cellHeight = Math.max(NODE_CELL_HEIGHT, height / Math.max(rows, 1));
    return new Map(nodes.map((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        return [node.id, savedPositions.get(node.id) || {
            x: Math.min(width - 104, column * cellWidth + cellWidth / 2),
            y: row * cellHeight + cellHeight / 2,
        }];
    }));
}

function metricParts(node) {
    if (node.impact_role) return [{ text: node.impact_role }, { text: ` · ${node.change || "unchanged"}` }];
    const metrics = node.metrics || {};
    const change = node.change || "unchanged";
    const changeClass = { added: "delta-add", modified: "delta-modified", removed: "delta-remove", deleted: "delta-remove" }[change];
    return [
        { text: `+${metrics.lines_added || 0}`, className: "delta-add" },
        { text: " / " },
        { text: `−${metrics.lines_removed || 0}`, className: "delta-remove" },
        { text: " · " },
        node.kind === "function" || node.kind === "method"
            ? { text: `complexity ${metrics.complexity_current ?? "—"}` }
            : { text: change, className: changeClass },
    ];
}

function metricText(node) {
    return metricParts(node).map((part) => part.text).join("");
}

function control(label, title, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", handler);
    return button;
}

export function resizeGraph(container) {
    graphResizers.get(container.querySelector("svg.graph-canvas"))?.();
}

export function renderGraph(container, nodes, edges, onSelect, { viewport: fixedViewport = false, focusId = null, emptyText = "No items at this level." } = {}) {
    container.replaceChildren();
    if (!nodes.length) {
        const empty = document.createElement("div");
        empty.className = "graph-empty";
        empty.textContent = emptyText;
        container.append(empty);
        return;
    }
    let width = Math.max(container.clientWidth || 320, 320);
    let height = graphHeight(nodes.length, width, nodes, edges);
    const radial = () => width >= 650 && nodes.some((node) => node.impact_role);
    // A fixed viewport keeps large impact slices pannable/zoomable instead of growing a page-tall canvas.
    const canvasHeightFor = () => fixedViewport ? Math.max(container.clientHeight || 0, 360) : height;
    let canvasHeight = canvasHeightFor();
    const root = svg("svg", { viewBox: `0 0 ${width} ${canvasHeight}`, role: "img", class: "graph-canvas" });
    if (fixedViewport) root.style.height = `${canvasHeight}px`;
    const defs = svg("defs");
    const marker = svg("marker", {
        id: "arrow", viewBox: "0 0 10 10", refX: 8, refY: 5,
        markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse",
    });
    marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z" }));
    defs.append(marker);
    root.append(defs);
    const viewport = svg("g", { class: "graph-viewport" });
    root.append(viewport);
    const edgeLayer = svg("g", { class: "edge-layer" });
    const nodeLayer = svg("g", { class: "node-layer" });
    // Edges that would pass under another tile are drawn above the tiles so they never look like a connection.
    const overLayer = svg("g", { class: "edge-over-layer" });
    viewport.append(edgeLayer, nodeLayer, overLayer);
    const positions = layout(nodes, width, height, edges);
    const nodeGroups = new Map();
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edgeRecords = [];
    let selectedId = null;
    const highlightEdges = (nodeId) => {
        const active = nodeId ?? selectedId;
        root.classList.toggle("focus-edges", active !== null);
        for (const record of edgeRecords) {
            record.path.classList.toggle(
                "edge-active",
                active !== null && (record.edge.source === active || record.edge.target === active),
            );
        }
    };
    const select = (node) => {
        selectedId = node.id;
        for (const [id, group] of nodeGroups) group.classList.toggle("node-selected", id === node.id);
        highlightEdges(null);
        onSelect(node);
    };
    if (nodes.length > 24) root.classList.add("graph-dense");
    const transform = { x: 0, y: 0, scale: 1 };
    let activeDrag = null;
    let autoFit = true;

    const updateTransform = () => {
        viewport.setAttribute("transform", `translate(${transform.x} ${transform.y}) scale(${transform.scale})`);
    };
    const updateEdge = (record) => {
        const source = positions.get(record.edge.source);
        const target = positions.get(record.edge.target);
        const dx = target.x - source.x, dy = target.y - source.y;
        const scale = Math.min(dx ? 100 / Math.abs(dx) : Infinity, dy ? 56 / Math.abs(dy) : Infinity);
        const start = { x: source.x + dx * scale, y: source.y + dy * scale };
        const end = { x: target.x - dx * scale, y: target.y - dy * scale };
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        record.path.setAttribute(
            "d",
            !dx && !dy ? `M ${source.x + 96} ${source.y - 20} C ${source.x + 170} ${source.y - 100}, ${source.x + 170} ${source.y + 100}, ${source.x + 96} ${source.y + 20}`
                : radial() ? `M ${start.x} ${start.y} L ${end.x} ${end.y}`
                : !dx ? `M ${source.x + 100} ${source.y} C ${source.x + 150} ${source.y}, ${target.x + 150} ${target.y}, ${target.x + 100} ${target.y}`
                : horizontal ? `M ${start.x} ${start.y} C ${(start.x + end.x) / 2} ${start.y}, ${(start.x + end.x) / 2} ${end.y}, ${end.x} ${end.y}`
                    : `M ${start.x} ${start.y} C ${start.x} ${(start.y + end.y) / 2}, ${end.x} ${(start.y + end.y) / 2}, ${end.x} ${end.y}`,
        );
        if (record.label) {
            record.label.setAttribute("x", String((source.x + target.x) / 2));
            record.label.setAttribute("y", String((source.y + target.y) / 2 - 6));
        }
        const crosses = radial() && (dx || dy) && [...positions].some(([id, point]) => {
            if (id === record.edge.source || id === record.edge.target) return false;
            for (let step = 1; step < 24; step++) {
                const x = start.x + (end.x - start.x) * step / 24, y = start.y + (end.y - start.y) * step / 24;
                if (Math.abs(x - point.x) < 96 && Math.abs(y - point.y) < 52) return true;
            }
            return false;
        });
        record.path.classList.toggle("edge-over", Boolean(crosses));
        const layer = crosses ? overLayer : edgeLayer;
        if (record.path.parentNode !== layer) layer.append(record.path);
    };
    const pointForEvent = (event) => {
        const point = root.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        return point.matrixTransform(root.getScreenCTM().inverse());
    };
    const zoomAt = (factor, point = { x: width / 2, y: canvasHeight / 2 }) => {
        autoFit = false;
        const next = Math.max(fixedViewport ? .1 : .25, Math.min(3, transform.scale * factor));
        transform.x = point.x - (point.x - transform.x) * (next / transform.scale);
        transform.y = point.y - (point.y - transform.y) * (next / transform.scale);
        transform.scale = next;
        updateTransform();
    };
    const fitScale = () => {
        const values = [...positions.values()];
        const spanX = Math.max(...values.map((item) => item.x)) - Math.min(...values.map((item) => item.x)) + 224;
        const spanY = Math.max(...values.map((item) => item.y)) - Math.min(...values.map((item) => item.y)) + 136;
        return Math.min(width / spanX, canvasHeight / spanY) * .92;
    };
    const fit = () => {
        autoFit = true;
        hint.textContent = "Drag tiles · drag background · wheel to zoom";
        const values = [...positions.values()];
        const minX = Math.min(...values.map((item) => item.x)) - 112;
        const maxX = Math.max(...values.map((item) => item.x)) + 112;
        const minY = Math.min(...values.map((item) => item.y)) - 68;
        const maxY = Math.max(...values.map((item) => item.y)) + 68;
        const scale = Math.max(fixedViewport ? .1 : .25, Math.min(1.5, fitScale()));
        transform.scale = scale;
        transform.x = (width - (minX + maxX) * scale) / 2;
        transform.y = (canvasHeight - (minY + maxY) * scale) / 2;
        updateTransform();
    };
    // Large slices open legibly around the focus; Fit remains available to show every node.
    const initialView = () => {
        const roleFocus = nodes.find((node) => ["Changed focus", "Selected focus"].includes(node.impact_role))?.id;
        const focus = fixedViewport && (positions.get(focusId) || positions.get(roleFocus));
        if (!focus || fitScale() >= .6) { fit(); return; }
        autoFit = true;
        transform.scale = .75;
        transform.x = width / 2 - focus.x * transform.scale;
        transform.y = canvasHeight / 2 - focus.y * transform.scale;
        updateTransform();
        hint.textContent = `Centered on the focus · Fit shows all ${nodes.length} nodes`;
    };

    for (const edge of edges.filter((item) => nodeIds.has(item.source) && nodeIds.has(item.target))) {
        const path = svg("path", {
            class: `edge edge-${edge.change || "unchanged"}`,
            "marker-end": "url(#arrow)",
            tabindex: "0",
        });
        const description = `${edge.type}: ${countLabel(edge.count || 1, "relationship")}`;
        const title = svg("title");
        title.textContent = description;
        path.append(title);
        path.addEventListener("click", (event) => {
            event.stopPropagation();
            onSelect(edge);
        });
        path.addEventListener("keydown", (event) => event.key === "Enter" && onSelect(edge));
        edgeLayer.append(path);
        let label = null;
        if ((edge.count || 1) > 1) {
            label = svg("text", { class: "edge-label" });
            label.textContent = String(edge.count);
            edgeLayer.append(label);
        }
        const record = { edge, path, label };
        edgeRecords.push(record);
        updateEdge(record);
    }

    for (const node of nodes) {
        const point = positions.get(node.id);
        const group = svg("g", {
            class: `node node-${node.change || "unchanged"}`,
            transform: `translate(${point.x} ${point.y})`,
            tabindex: "0",
            role: "button",
            "aria-label": `${displayName(node)}, ${metricText(node)}, ${countLabel(node._attention_count || 0, "attention finding")}`,
        });
        group.dataset.nodeId = node.id;
        const title = svg("title");
        title.textContent = `${displayName(node)}\n${metricText(node)}${node._attention_count
            ? `\n${countLabel(node._attention_count, "attention finding")} · highest impact ${node._attention_score}` : ""}`;
        group.append(title, svg("rect", { x: -96, y: -52, width: 192, height: 104, rx: 6 }));
        const kind = svg("text", { x: -80, y: -28, class: "node-kind" });
        kind.textContent = (node.kind || "item").toUpperCase();
        wrapLabel(tileName(node)).forEach((text, index) => {
            const name = svg("text", { x: -80, y: -5 + index * 16, class: "node-name" });
            name.textContent = text;
            group.append(name);
        });
        const metric = svg("text", { x: -80, y: 37, class: "node-metric" });
        for (const part of metricParts(node)) {
            const span = svg("tspan", part.className ? { class: part.className } : {});
            span.textContent = part.text;
            metric.append(span);
        }
        group.append(kind, metric);
        if (node._attention_count) {
            group.append(svg("circle", {
                cx: 79, cy: -36, r: 13,
                class: `attention-badge severity-${node._attention_severity || "medium"}`,
            }));
            const count = svg("text", { x: 79, y: -32, class: "attention-count" });
            count.textContent = String(node._attention_count);
            group.append(count);
        }
        group.addEventListener("pointerdown", (event) => {
            event.stopPropagation();
            event.preventDefault();
            group.dataset.dragMoved = "false";
            activeDrag = {
                node,
                group,
                point,
                last: pointForEvent(event),
                pointerId: event.pointerId,
            };
            root.setPointerCapture(event.pointerId);
            group.classList.add("dragging");
        });
        group.addEventListener("pointerenter", () => highlightEdges(node.id));
        group.addEventListener("pointerleave", () => highlightEdges(null));
        group.addEventListener("focus", () => highlightEdges(node.id));
        group.addEventListener("blur", () => highlightEdges(null));
        group.addEventListener("keydown", (event) => event.key === "Enter" && select(node));
        nodeLayer.append(group);
        nodeGroups.set(node.id, group);
    }

    let panStart = null;
    root.addEventListener("pointerdown", (event) => {
        if (event.target.closest?.(".node")) return;
        panStart = pointForEvent(event);
        root.setPointerCapture(event.pointerId);
        root.classList.add("panning");
    });
    root.addEventListener("pointermove", (event) => {
        if (activeDrag && root.hasPointerCapture(event.pointerId)) {
            const current = pointForEvent(event);
            const dx = (current.x - activeDrag.last.x) / transform.scale;
            const dy = (current.y - activeDrag.last.y) / transform.scale;
            if (Math.abs(dx) + Math.abs(dy) > 1) {
                activeDrag.group.dataset.dragMoved = "true";
                autoFit = false;
            }
            activeDrag.point.x += dx;
            activeDrag.point.y += dy;
            activeDrag.last = current;
            savedPositions.set(activeDrag.node.impact_role ? `impact:${activeDrag.node.id}` : activeDrag.node.id, { ...activeDrag.point });
            activeDrag.group.setAttribute("transform", `translate(${activeDrag.point.x} ${activeDrag.point.y})`);
            edgeRecords
                .filter((record) => record.edge.source === activeDrag.node.id || record.edge.target === activeDrag.node.id)
                .forEach(updateEdge);
            return;
        }
        if (!panStart || !root.hasPointerCapture(event.pointerId)) return;
        autoFit = false;
        const current = pointForEvent(event);
        transform.x += current.x - panStart.x;
        transform.y += current.y - panStart.y;
        panStart = current;
        updateTransform();
    });
    root.addEventListener("pointerup", (event) => {
        if (activeDrag) {
            const completedDrag = activeDrag;
            const moved = completedDrag.group.dataset.dragMoved === "true";
            completedDrag.group.classList.remove("dragging");
            completedDrag.group.dataset.dragMoved = "false";
            activeDrag = null;
            root.releasePointerCapture(event.pointerId);
            resizeGraph(container);
            if (!moved) select(completedDrag.node);
            return;
        }
        panStart = null;
        root.releasePointerCapture(event.pointerId);
        root.classList.remove("panning");
        resizeGraph(container);
    });
    root.addEventListener("pointercancel", () => {
        activeDrag?.group.classList.remove("dragging");
        activeDrag = null;
        panStart = null;
        root.classList.remove("panning");
        resizeGraph(container);
    });
    root.addEventListener("wheel", (event) => {
        event.preventDefault();
        zoomAt(event.deltaY < 0 ? 1.12 : .89, pointForEvent(event));
    }, { passive: false });

    const controls = document.createElement("div");
    controls.className = "graph-viewport-controls";
    controls.append(
        control("+", "Zoom in", () => zoomAt(1.2)),
        control("−", "Zoom out", () => zoomAt(.8)),
        control("Fit", "Fit all nodes", fit),
    );
    const hint = document.createElement("span");
    hint.textContent = "Drag tiles · drag background · wheel to zoom";
    controls.append(hint);
    container.append(root, controls);
    initialView();
    graphResizers.set(root, () => {
        const measuredWidth = container.clientWidth;
        if (!measuredWidth || activeDrag || panStart) return;
        const nextWidth = Math.max(measuredWidth, 320);
        const nextCanvas = fixedViewport ? Math.max(container.clientHeight || 0, 360) : null;
        if (nextWidth === width && (!fixedViewport || nextCanvas === canvasHeight)) return;
        width = nextWidth;
        height = graphHeight(nodes.length, width, nodes, edges);
        canvasHeight = canvasHeightFor();
        root.setAttribute("viewBox", `0 0 ${width} ${canvasHeight}`);
        if (fixedViewport) root.style.height = `${canvasHeight}px`;
        for (const [id, point] of layout(nodes, width, height, edges)) {
            Object.assign(positions.get(id), point);
            nodeGroups.get(id).setAttribute("transform", `translate(${point.x} ${point.y})`);
        }
        edgeRecords.forEach(updateEdge);
        if (autoFit) initialView();
    });
}
import { countLabel } from "./count-format.mjs";
