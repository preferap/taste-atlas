const mapEl = document.getElementById("map");
const formEl = document.getElementById("taste-form");
const nodeCountEl = document.getElementById("node-count");
const archiveEmptyEl = document.getElementById("archive-empty");
const archiveCardEl = document.getElementById("archive-card");
const archiveTitleEl = document.getElementById("archive-title");
const archiveTypeEl = document.getElementById("archive-type");
const archivePosterEl = document.getElementById("archive-poster");
const archiveDescEl = document.getElementById("archive-desc");
const studyPathSectionEl = document.getElementById("study-path-section");
const archivePathEl = document.getElementById("archive-path");
const archiveConnectedSectionsEl = document.getElementById("archive-connected-sections");
const archiveLinksEl = document.getElementById("archive-links");
const sourceStatusEl = document.getElementById("source-status");
const expandNodeEl = document.getElementById("expand-node");
const resetMapEl = document.getElementById("reset-map");
const searchResultsEl = document.getElementById("search-results");
const searchResultListEl = document.getElementById("search-result-list");

const nodes = [];
const edges = [];
let selectedNodeId = null;
let nodeSerial = 0;
let pendingSearch = null;

const GRAPH_STORAGE_KEY = "taste-atlas-graph-v2";
const MAP_VIEWBOX = { width: 900, height: 560 };

const seedDb = {
  "pulp-fiction": {
    title: "Pulp Fiction",
    type: "movie",
    desc: "Crime anthology style, nonlinear narrative, pop-culture dialogue.",
    path: [],
    links: ["Quentin Tarantino", "Neo-noir", "Crime", "Nonlinear storytelling"],
  },
  hitchcock: {
    title: "Alfred Hitchcock",
    type: "movie",
    desc: "Suspense grammar, visual tension, psychological thriller archetypes.",
    path: [],
    links: ["Suspense", "Psychological thriller", "Vertigo", "Psycho"],
  },
  radiohead: {
    title: "Radiohead",
    type: "music",
    desc: "Art rock with electronic experimentation and emotional abstraction.",
    path: ["대표 앨범 탐색", "연결 장르 확장", "동시대 씬 비교"],
    links: ["Art rock", "Alternative", "Thom Yorke", "Warp/IDM influence"],
  },
  shoegaze: {
    title: "Shoegaze",
    type: "music",
    desc: "Layered guitar textures, dreamy vocals, noise-pop atmosphere.",
    path: ["대표 아티스트 탐색", "하위 장르 비교", "시대별 사운드 변화"],
    links: ["Dream pop", "Noise pop", "My Bloody Valentine", "Cocteau Twins"],
  },
};

function nextNodeId() {
  nodeSerial += 1;
  return `node-${Date.now()}-${nodeSerial}`;
}

function normalizeTitle(title) {
  return String(title || "").trim().toLowerCase();
}

function findNodeByIdentity(title, type) {
  const normalizedTitle = normalizeTitle(title);
  return nodes.find(
    (node) => normalizeTitle(node.title) === normalizedTitle && node.type === type
  );
}

function addEdge(from, to, relation = "secondary") {
  const exists = edges.some((edge) => edge.from === from && edge.to === to);
  if (!exists) {
    edges.push({ from, to, relation });
  }
}

function persistGraph() {
  const payload = {
    nodes,
    edges,
    selectedNodeId,
    nodeSerial,
  };
  window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(payload));
}

function restoreGraph() {
  const raw = window.localStorage.getItem(GRAPH_STORAGE_KEY);
  if (!raw) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return false;
    }
    nodes.splice(0, nodes.length, ...parsed.nodes);
    edges.splice(0, edges.length, ...parsed.edges);
    selectedNodeId = parsed.selectedNodeId || null;
    nodeSerial = parsed.nodeSerial || nodes.length;
    return true;
  } catch {
    return false;
  }
}

function addNode(inputNode, options = {}) {
  const node = {
    ...inputNode,
    type: inputNode.type || "concept",
    path: Array.isArray(inputNode.path) ? inputNode.path : [],
    links: Array.isArray(inputNode.links) ? inputNode.links : [],
    connectedSections: Array.isArray(inputNode.connectedSections)
      ? inputNode.connectedSections
      : [],
  };

  const existing = findNodeByIdentity(node.title, node.type);
  const linkToId = options.linkToId || null;
  const branchGroup = options.branchGroup || node.branchGroup || "related";

  if (existing) {
    if (linkToId && existing.id !== linkToId) {
      addEdge(linkToId, existing.id, "primary");
      if (!existing.parentId) {
        existing.parentId = linkToId;
      }
      existing.depth = Math.max(existing.depth || 1, (getDepth(linkToId) || 0) + 1);
      existing.branchGroup = existing.branchGroup || branchGroup;
    }
    recalculateLayout();
    render();
    persistGraph();
    return existing;
  }

  const id = nextNodeId();
  const parentId = linkToId || null;
  const depth = parentId ? (getDepth(parentId) || 0) + 1 : 0;

  const newNode = {
    id,
    ...node,
    parentId,
    depth,
    branchGroup: parentId ? branchGroup : node.type,
    x: 0,
    y: 0,
  };

  nodes.push(newNode);

  if (parentId) {
    addEdge(parentId, id, "primary");
  }

  recalculateLayout();
  render();
  persistGraph();
  return newNode;
}

function getDepth(nodeId) {
  return nodes.find((node) => node.id === nodeId)?.depth || 0;
}

function recalculateLayout() {
  const centerX = MAP_VIEWBOX.width / 2;
  const centerY = MAP_VIEWBOX.height / 2;

  const roots = nodes
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
  const children = nodes
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

function render() {
  while (mapEl.firstChild) {
    mapEl.removeChild(mapEl.firstChild);
  }

  edges.forEach((edge) => {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
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

  nodes.forEach((node) => {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", node.x);
    circle.setAttribute("cy", node.y);
    circle.setAttribute("r", node.depth === 0 ? "30" : "24");
    circle.setAttribute("fill", node.id === selectedNodeId ? "#ededed" : "#ffffff");
    circle.setAttribute("stroke", "#0a0a0a");
    circle.setAttribute("stroke-width", node.id === selectedNodeId ? "3" : "2");
    circle.style.cursor = "pointer";

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", node.x);
    label.setAttribute("y", node.y + 4);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", "10");
    label.setAttribute("font-family", "Helvetica, Pretendard, sans-serif");
    label.textContent =
      node.title.length > 12 ? `${node.title.slice(0, 12)}...` : node.title;

    group.appendChild(circle);
    group.appendChild(label);
    group.addEventListener("click", () => openArchive(node));
    mapEl.appendChild(group);
  });

  nodeCountEl.textContent = `${nodes.length} nodes`;
}

function openArchive(node) {
  selectedNodeId = node.id;
  render();

  archiveEmptyEl.classList.add("hidden");
  archiveCardEl.classList.remove("hidden");
  archiveTitleEl.textContent = node.title;
  archiveTypeEl.textContent = node.type.toUpperCase();
  archiveDescEl.textContent = node.desc || "No description yet.";

  if (node.posterUrl) {
    archivePosterEl.src = node.posterUrl;
    archivePosterEl.classList.remove("hidden");
  } else {
    archivePosterEl.removeAttribute("src");
    archivePosterEl.classList.add("hidden");
  }

  const showStudyPath = node.type !== "movie";
  studyPathSectionEl.style.display = showStudyPath ? "block" : "none";
  archivePathEl.innerHTML = "";
  node.path.forEach((step) => {
    const li = document.createElement("li");
    li.textContent = step;
    archivePathEl.appendChild(li);
  });

  archiveConnectedSectionsEl.innerHTML = "";
  const connectedSections = node.connectedSections || [];
  if (connectedSections.length > 0) {
    archiveLinksEl.classList.add("hidden");
    connectedSections.forEach((section) => {
      const group = document.createElement("section");
      group.className = "connected-group";

      const title = document.createElement("h5");
      title.textContent = section.title || "Connected";
      group.appendChild(title);

      const list = document.createElement("ul");
      const items = Array.isArray(section.items) ? section.items : [];
      items.forEach((item) => {
        const li = document.createElement("li");
        const label = item?.label || item?.name || "";
        if (item?.url) {
          const link = document.createElement("a");
          link.href = item.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = label;
          li.appendChild(link);
        } else {
          li.textContent = label;
        }
        list.appendChild(li);
      });
      group.appendChild(list);
      archiveConnectedSectionsEl.appendChild(group);
    });
  } else {
    archiveLinksEl.classList.remove("hidden");
  }

  archiveLinksEl.innerHTML = "";
  node.links.forEach((linkText) => {
    const li = document.createElement("li");
    li.textContent = linkText;
    archiveLinksEl.appendChild(li);
  });

  persistGraph();
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(formEl);
  const type = String(formData.get("type") || "");
  const title = String(formData.get("title") || "").trim();

  if (!title) {
    return;
  }

  sourceStatusEl.textContent = "Searching candidates...";
  try {
    const response = await fetch(
      `/api/search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(title)}`
    );
    if (!response.ok) {
      throw new Error(`Search failed (${response.status})`);
    }
    const data = await response.json();
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];

    if (!candidates.length) {
      sourceStatusEl.textContent = "No search results found.";
      searchResultsEl.classList.add("hidden");
      return;
    }

    pendingSearch = { type, q: title, candidates };
    renderSearchCandidates();
    sourceStatusEl.textContent = `Choose one from ${candidates.length} result(s).`;
  } catch (_error) {
    sourceStatusEl.textContent = "Search failed. Check API/network.";
    searchResultsEl.classList.add("hidden");
  }
});

function renderSearchCandidates() {
  const candidates = pendingSearch?.candidates || [];
  if (!candidates.length) {
    searchResultsEl.classList.add("hidden");
    return;
  }

  searchResultListEl.innerHTML = "";
  candidates.forEach((candidate) => {
    const li = document.createElement("li");
    li.className = "search-result-item";

    const image = document.createElement("img");
    image.className = "search-result-poster";
    image.alt = "candidate image";
    if (candidate.posterUrl) {
      image.src = candidate.posterUrl;
    }

    const main = document.createElement("div");
    main.className = "search-result-main";
    const title = document.createElement("strong");
    title.textContent = candidate.title;
    const subtitle = document.createElement("span");
    subtitle.textContent = candidate.subtitle || "";
    main.appendChild(title);
    main.appendChild(subtitle);

    const useButton = document.createElement("button");
    useButton.type = "button";
    useButton.className = "search-result-use";
    useButton.textContent = "Select";
    useButton.addEventListener("click", () => selectCandidate(candidate));

    li.appendChild(image);
    li.appendChild(main);
    li.appendChild(useButton);
    searchResultListEl.appendChild(li);
  });

  searchResultsEl.classList.remove("hidden");
}

async function selectCandidate(candidate) {
  if (!pendingSearch) {
    return;
  }

  sourceStatusEl.textContent = "Loading selected result...";
  try {
    const response = await fetch(
      `/api/lookup?type=${encodeURIComponent(pendingSearch.type)}&q=${encodeURIComponent(
        pendingSearch.q
      )}&candidateId=${encodeURIComponent(candidate.id)}&candidateKind=${encodeURIComponent(
        candidate.kind
      )}`
    );
    if (!response.ok) {
      throw new Error(`Lookup failed (${response.status})`);
    }

    const data = await response.json();
    const added = addNode(data.node);
    openArchive(added);
    sourceStatusEl.textContent = "Selected result added to map.";

    searchResultsEl.classList.add("hidden");
    searchResultListEl.innerHTML = "";
    pendingSearch = null;
    formEl.reset();
  } catch (_error) {
    sourceStatusEl.textContent = "Lookup failed. Check API/network.";
  }
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const key = chip.getAttribute("data-seed");
    const seed = seedDb[key];
    if (!seed) {
      return;
    }
    const added = addNode(seed);
    openArchive(added);
  });
});

expandNodeEl.addEventListener("click", async () => {
  if (!selectedNodeId) {
    sourceStatusEl.textContent = "Select a node first.";
    return;
  }

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  if (!selectedNode) {
    sourceStatusEl.textContent = "Selected node not found.";
    return;
  }
  if (!["movie", "music"].includes(selectedNode.type)) {
    sourceStatusEl.textContent = "Expand is available only for movie/music seed nodes.";
    return;
  }

  sourceStatusEl.textContent = "Expanding selected node...";
  try {
    const response = await fetch(
      `/api/expand?type=${encodeURIComponent(selectedNode.type)}&q=${encodeURIComponent(
        selectedNode.title
      )}`
    );
    if (!response.ok) {
      throw new Error(`Expand failed (${response.status})`);
    }
    const data = await response.json();
    const expandedNodes = Array.isArray(data.nodes) ? data.nodes : [];
    expandedNodes.forEach((child) => {
      addNode(child, {
        linkToId: selectedNode.id,
        branchGroup: child.branchGroup || "related",
      });
    });
    sourceStatusEl.textContent = `Expanded ${expandedNodes.length} connected nodes.`;
  } catch (_error) {
    sourceStatusEl.textContent = "Expand failed. Check API/network.";
  }
});

resetMapEl.addEventListener("click", () => {
  const confirmed = window.confirm("Reset current map?");
  if (!confirmed) {
    return;
  }
  nodes.splice(0, nodes.length);
  edges.splice(0, edges.length);
  selectedNodeId = null;
  nodeSerial = 0;
  pendingSearch = null;
  searchResultsEl.classList.add("hidden");
  searchResultListEl.innerHTML = "";
  window.localStorage.removeItem(GRAPH_STORAGE_KEY);
  archiveCardEl.classList.add("hidden");
  archiveEmptyEl.classList.remove("hidden");
  render();
  sourceStatusEl.textContent = "Map reset complete.";
});

async function checkSourceHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      throw new Error("health check failed");
    }
    const data = await response.json();
    const music = data.sources.musicbrainz ? "MusicBrainz: ON" : "MusicBrainz: OFF";
    const tmdb = data.sources.tmdb ? "TMDB: ON" : "TMDB: OFF";
    sourceStatusEl.textContent = `${music} | ${tmdb} | Wikidata: ON`;
  } catch (_error) {
    sourceStatusEl.textContent = "Health check failed. Start with: npm run dev";
  }
}

if (!restoreGraph()) {
  ["pulp-fiction", "radiohead", "hitchcock"].forEach((seed) => addNode(seedDb[seed]));
}
recalculateLayout();
render();
if (selectedNodeId) {
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  if (selectedNode) {
    openArchive(selectedNode);
  }
}
checkSourceHealth();
