const GRAPH_STORAGE_KEY = "taste-atlas-graph-v2";
const LAST_RESULTS_KEY = "taste-atlas-last-results-v1";
const MAP_VIEWBOX = { width: 900, height: 560 };

const mapEl = document.getElementById("node-map");
const nodesCountEl = document.getElementById("nodes-count");
const refreshNodesEl = document.getElementById("refresh-nodes");
const resetViewEl = document.getElementById("reset-view");
const nodesFilterEl = document.getElementById("nodes-filter");

const nodesContentResultsEl = document.getElementById("nodes-content-results");
const nodesPersonResultsEl = document.getElementById("nodes-person-results");

const nodeDetailEmptyEl = document.getElementById("node-detail-empty");
const nodeDetailCardEl = document.getElementById("node-detail-card");
const nodeDetailTitleEl = document.getElementById("node-detail-title");
const nodeDetailTypeEl = document.getElementById("node-detail-type");
const nodeDetailPosterEl = document.getElementById("node-detail-poster");
const nodeDetailDescEl = document.getElementById("node-detail-desc");

let graph = loadGraph();
let selectedNodeId = null;
let activeFilter = "all";
let viewState = { x: 0, y: 0, width: MAP_VIEWBOX.width, height: MAP_VIEWBOX.height };
let isPanning = false;
let panStart = null;
let panViewStart = null;

function loadGraph() {
  const raw = window.localStorage.getItem(GRAPH_STORAGE_KEY);
  if (!raw) {
    return { nodes: [], edges: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

function getFilteredNodes() {
  if (activeFilter === "all") {
    return graph.nodes;
  }
  return graph.nodes.filter((node) => node.type === activeFilter);
}

function getFilteredEdges(filteredNodes) {
  const ids = new Set(filteredNodes.map((node) => node.id));
  return graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

function recalculateLayout() {
  const centerX = MAP_VIEWBOX.width / 2;
  const centerY = MAP_VIEWBOX.height / 2;

  const roots = graph.nodes
    .filter((node) => !node.parentId)
    .sort((a, b) => `${a.type}:${a.title}`.localeCompare(`${b.type}:${b.title}`));

  if (!roots.length) {
    return;
  }

  const rootRadius = Math.min(200, 90 + roots.length * 10);
  roots.forEach((root, index) => {
    const angle = (Math.PI * 2 * index) / roots.length - Math.PI / 2;
    root.x = clamp(centerX + Math.cos(angle) * rootRadius, 40, MAP_VIEWBOX.width - 40);
    root.y = clamp(centerY + Math.sin(angle) * rootRadius, 40, MAP_VIEWBOX.height - 40);
    placeBranch(root, angle, Math.PI * 0.95, 118);
  });
}

function placeBranch(parent, baseAngle, spread, distance) {
  const children = graph.nodes
    .filter((node) => node.parentId === parent.id)
    .sort((a, b) => `${a.branchGroup}:${a.title}`.localeCompare(`${b.branchGroup}:${b.title}`));

  if (!children.length) {
    return;
  }

  const groups = new Map();
  children.forEach((child) => {
    const key = child.branchGroup || "related";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(child);
  });

  const groupEntries = Array.from(groups.entries());
  groupEntries.forEach(([_, groupChildren], groupIndex) => {
    const groupAngle =
      baseAngle - spread / 2 + (spread * (groupIndex + 1)) / (groupEntries.length + 1);
    const groupSpread = Math.max(0.12, spread / (groupEntries.length * 2));

    groupChildren.forEach((child, childIndex) => {
      const childAngle =
        groupAngle - groupSpread / 2 +
        (groupSpread * (childIndex + 1)) / (groupChildren.length + 1);
      const childDistance = distance + Math.max(0, (child.depth || 0) - 1) * 26;
      child.x = clamp(parent.x + Math.cos(childAngle) * childDistance, 20, MAP_VIEWBOX.width - 20);
      child.y = clamp(parent.y + Math.sin(childAngle) * childDistance, 20, MAP_VIEWBOX.height - 20);
      placeBranch(child, childAngle, spread * 0.68, distance * 0.85);
    });
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function renderMap() {
  while (mapEl.firstChild) {
    mapEl.removeChild(mapEl.firstChild);
  }

  const filteredNodes = getFilteredNodes();
  const filteredEdges = getFilteredEdges(filteredNodes);

  filteredEdges.forEach((edge) => {
    const from = filteredNodes.find((node) => node.id === edge.from);
    const to = filteredNodes.find((node) => node.id === edge.to);
    if (!from || !to) {
      return;
    }

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", from.x);
    line.setAttribute("y1", from.y);
    line.setAttribute("x2", to.x);
    line.setAttribute("y2", to.y);
    line.setAttribute("stroke", edge.relation === "primary" ? "#7a7a7a" : "#b8b8b8");
    line.setAttribute("stroke-width", edge.relation === "primary" ? "2" : "1.2");
    line.setAttribute("stroke-dasharray", edge.relation === "primary" ? "" : "4 2");
    mapEl.appendChild(line);
  });

  filteredNodes.forEach((node) => {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", node.x || 0);
    circle.setAttribute("cy", node.y || 0);
    circle.setAttribute("r", node.depth === 0 ? "30" : "24");
    circle.setAttribute("fill", node.id === selectedNodeId ? "#ededed" : "#ffffff");
    circle.setAttribute("stroke", "#0a0a0a");
    circle.setAttribute("stroke-width", node.id === selectedNodeId ? "3" : "2");

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", node.x || 0);
    label.setAttribute("y", (node.y || 0) + 4);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", "10");
    label.setAttribute("font-family", "Helvetica, Pretendard, sans-serif");
    label.textContent = node.title.length > 12 ? `${node.title.slice(0, 12)}...` : node.title;

    group.appendChild(circle);
    group.appendChild(label);
    group.addEventListener("click", () => openNode(node));

    mapEl.appendChild(group);
  });

  nodesCountEl.textContent = `${filteredNodes.length} nodes`;
  applyViewBox();
}

function applyViewBox() {
  mapEl.setAttribute(
    "viewBox",
    `${viewState.x} ${viewState.y} ${viewState.width} ${viewState.height}`
  );
}

function openNode(node) {
  selectedNodeId = node.id;
  renderMap();

  nodeDetailEmptyEl.classList.add("hidden");
  nodeDetailCardEl.classList.remove("hidden");

  nodeDetailTitleEl.textContent = node.title;
  nodeDetailTypeEl.textContent = String(node.type || "unknown").toUpperCase();
  nodeDetailDescEl.textContent = node.desc || "No description yet.";

  if (node.posterUrl) {
    nodeDetailPosterEl.src = node.posterUrl;
    nodeDetailPosterEl.classList.remove("hidden");
  } else {
    nodeDetailPosterEl.removeAttribute("src");
    nodeDetailPosterEl.classList.add("hidden");
  }
}

function renderLatestResults() {
  const raw = window.localStorage.getItem(LAST_RESULTS_KEY);
  if (!raw) {
    renderResultList(nodesContentResultsEl, []);
    renderResultList(nodesPersonResultsEl, []);
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    renderResultList(nodesContentResultsEl, Array.isArray(parsed.content) ? parsed.content : []);
    renderResultList(nodesPersonResultsEl, Array.isArray(parsed.person) ? parsed.person : []);
  } catch {
    renderResultList(nodesContentResultsEl, []);
    renderResultList(nodesPersonResultsEl, []);
  }
}

function renderResultList(container, items) {
  container.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "search-result-item";
    li.innerHTML = `<div class="search-result-main"><strong>n/a</strong><span>No recent results</span></div>`;
    container.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "search-result-item";

    const image = document.createElement("img");
    image.className = "search-result-poster";
    image.alt = "result image";
    if (item.posterUrl) {
      image.src = item.posterUrl;
    }

    const main = document.createElement("div");
    main.className = "search-result-main";
    main.innerHTML = `<strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(
      item.subtitle || ""
    )}</span>`;

    li.appendChild(image);
    li.appendChild(main);
    container.appendChild(li);
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resetView() {
  viewState = { x: 0, y: 0, width: MAP_VIEWBOX.width, height: MAP_VIEWBOX.height };
  applyViewBox();
}

function setupPanZoom() {
  mapEl.addEventListener("wheel", (event) => {
    event.preventDefault();
    const scale = event.deltaY > 0 ? 1.08 : 0.92;

    const rect = mapEl.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    const mouseX = viewState.x + viewState.width * px;
    const mouseY = viewState.y + viewState.height * py;

    const nextWidth = clamp(viewState.width * scale, 240, MAP_VIEWBOX.width * 2);
    const nextHeight = clamp(viewState.height * scale, 180, MAP_VIEWBOX.height * 2);

    viewState.x = mouseX - nextWidth * px;
    viewState.y = mouseY - nextHeight * py;
    viewState.width = nextWidth;
    viewState.height = nextHeight;

    applyViewBox();
  });

  mapEl.addEventListener("mousedown", (event) => {
    isPanning = true;
    panStart = { x: event.clientX, y: event.clientY };
    panViewStart = { ...viewState };
    mapEl.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (event) => {
    if (!isPanning || !panStart || !panViewStart) {
      return;
    }
    const rect = mapEl.getBoundingClientRect();
    const dx = ((event.clientX - panStart.x) / rect.width) * panViewStart.width;
    const dy = ((event.clientY - panStart.y) / rect.height) * panViewStart.height;
    viewState.x = panViewStart.x - dx;
    viewState.y = panViewStart.y - dy;
    applyViewBox();
  });

  window.addEventListener("mouseup", () => {
    isPanning = false;
    panStart = null;
    panViewStart = null;
    mapEl.style.cursor = "default";
  });
}

function initialize() {
  graph = loadGraph();
  recalculateLayout();
  renderMap();
  renderLatestResults();
}

refreshNodesEl.addEventListener("click", initialize);
resetViewEl.addEventListener("click", resetView);
nodesFilterEl.addEventListener("change", (event) => {
  activeFilter = event.target.value;
  renderMap();
});

setupPanZoom();
initialize();
