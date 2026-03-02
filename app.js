const mapEl = document.getElementById("map");
const formEl = document.getElementById("taste-form");
const nodeCountEl = document.getElementById("node-count");
const archiveEmptyEl = document.getElementById("archive-empty");
const archiveCardEl = document.getElementById("archive-card");
const archiveTitleEl = document.getElementById("archive-title");
const archiveTypeEl = document.getElementById("archive-type");
const archiveDescEl = document.getElementById("archive-desc");
const archivePathEl = document.getElementById("archive-path");
const archiveLinksEl = document.getElementById("archive-links");
const sourceStatusEl = document.getElementById("source-status");
const expandNodeEl = document.getElementById("expand-node");
const resetMapEl = document.getElementById("reset-map");

const nodes = [];
const edges = [];
let selectedNodeId = null;
let nodeSerial = 0;

const GRAPH_STORAGE_KEY = "taste-atlas-graph-v1";

const seedDb = {
  "pulp-fiction": {
    title: "Pulp Fiction",
    type: "movie",
    desc: "Crime anthology style, nonlinear narrative, pop-culture dialogue.",
    path: ["Tarantino style 분석", "90s American independent cinema", "Neo-noir study"],
    links: ["Quentin Tarantino", "Neo-noir", "Crime", "Nonlinear storytelling"],
  },
  hitchcock: {
    title: "Alfred Hitchcock",
    type: "movie",
    desc: "Suspense grammar, visual tension, psychological thriller archetypes.",
    path: ["Suspense shot design", "Vertigo/Camera language", "Modern thriller influences"],
    links: ["Suspense", "Psychological thriller", "Vertigo", "Psycho"],
  },
  radiohead: {
    title: "Radiohead",
    type: "music",
    desc: "Art rock with electronic experimentation and emotional abstraction.",
    path: ["OK Computer 시대 배경", "Art rock vs Alternative", "Electronic texture analysis"],
    links: ["Art rock", "Alternative", "Thom Yorke", "Warp/IDM influence"],
  },
  shoegaze: {
    title: "Shoegaze",
    type: "music",
    desc: "Layered guitar textures, dreamy vocals, noise-pop atmosphere.",
    path: ["My Bloody Valentine", "Pedal chain basics", "Dream pop relation map"],
    links: ["Dream pop", "Noise pop", "My Bloody Valentine", "Cocteau Twins"],
  },
};

function randomPoint() {
  const x = 80 + Math.random() * 740;
  const y = 80 + Math.random() * 400;
  return { x, y };
}

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

function addEdge(from, to) {
  const exists = edges.some((edge) => edge.from === from && edge.to === to);
  if (!exists) {
    edges.push({ from, to });
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

function addNode(node, options = {}) {
  const existing = findNodeByIdentity(node.title, node.type);
  const linkToId = options.linkToId || null;

  if (existing) {
    if (linkToId && existing.id !== linkToId) {
      addEdge(linkToId, existing.id);
    }
    render();
    persistGraph();
    return existing;
  }

  const id = nextNodeId();
  const point = randomPoint();
  const newNode = { id, ...node, ...point };
  nodes.push(newNode);

  if (linkToId && linkToId !== id) {
    addEdge(linkToId, id);
  } else if (nodes.length > 1) {
    const candidates = nodes.filter((item) => item.id !== id);
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    if (target) {
      addEdge(id, target.id);
    }
  }

  render();
  persistGraph();
  return newNode;
}

function render() {
  while (mapEl.firstChild) {
    mapEl.removeChild(mapEl.firstChild);
  }

  edges.forEach((edge) => {
    const from = nodes.find((n) => n.id === edge.from);
    const to = nodes.find((n) => n.id === edge.to);
    if (!from || !to) return;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", from.x);
    line.setAttribute("y1", from.y);
    line.setAttribute("x2", to.x);
    line.setAttribute("y2", to.y);
    line.setAttribute("stroke", "#b8b8b8");
    line.setAttribute("stroke-width", "1.5");
    mapEl.appendChild(line);
  });

  nodes.forEach((node) => {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", node.x);
    circle.setAttribute("cy", node.y);
    circle.setAttribute("r", "26");
    circle.setAttribute("fill", node.id === selectedNodeId ? "#f1f1f1" : "#ffffff");
    circle.setAttribute("stroke", "#0a0a0a");
    circle.setAttribute("stroke-width", node.id === selectedNodeId ? "3" : "2");
    circle.style.cursor = "pointer";

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", node.x);
    label.setAttribute("y", node.y + 4);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("font-size", "10");
    label.setAttribute("font-family", "Helvetica, Pretendard, sans-serif");
    label.textContent = node.title.length > 11 ? `${node.title.slice(0, 11)}...` : node.title;

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

  archivePathEl.innerHTML = "";
  (node.path || []).forEach((step) => {
    const li = document.createElement("li");
    li.textContent = step;
    archivePathEl.appendChild(li);
  });

  archiveLinksEl.innerHTML = "";
  (node.links || []).forEach((link) => {
    const li = document.createElement("li");
    li.textContent = link;
    archiveLinksEl.appendChild(li);
  });
  persistGraph();
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(formEl);
  const type = formData.get("type");
  const title = String(formData.get("title") || "").trim();

  if (!title) {
    return;
  }

  sourceStatusEl.textContent = "Looking up live data...";
  try {
    const response = await fetch(
      `/api/lookup?type=${encodeURIComponent(type)}&q=${encodeURIComponent(title)}`
    );
    if (!response.ok) {
      throw new Error(`Lookup failed (${response.status})`);
    }
    const data = await response.json();
    const added = addNode(data.node);
    openArchive(added);
    sourceStatusEl.textContent = "Live API node added.";
  } catch (_error) {
    const fallback = addNode({
      title,
      type,
      desc: "Live API failed. Local fallback node added.",
      path: ["API 키 확인", "데이터 소스 연결", "지식지도 확장"],
      links: [],
    });
    openArchive(fallback);
    sourceStatusEl.textContent = "API failed, fallback node added.";
  }
  formEl.reset();
});

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
    expandedNodes.forEach((node) => {
      addNode(node, { linkToId: selectedNode.id });
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
render();
if (selectedNodeId) {
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  if (selectedNode) {
    openArchive(selectedNode);
  }
}
checkSourceHealth();
