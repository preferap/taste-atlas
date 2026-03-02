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

const nodes = [];
const edges = [];

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

function addNode(node) {
  const id = `node-${nodes.length + 1}`;
  const point = randomPoint();
  nodes.push({ id, ...node, ...point });

  if (nodes.length > 1) {
    const target = nodes[Math.floor(Math.random() * (nodes.length - 1))];
    edges.push({ from: id, to: target.id });
  }

  render();
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
    circle.setAttribute("fill", "#ffffff");
    circle.setAttribute("stroke", "#0a0a0a");
    circle.setAttribute("stroke-width", "2");
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
    addNode(data.node);
    sourceStatusEl.textContent = "Live API node added.";
  } catch (_error) {
    addNode({
      title,
      type,
      desc: "Live API failed. Local fallback node added.",
      path: ["API 키 확인", "데이터 소스 연결", "지식지도 확장"],
      links: [],
    });
    sourceStatusEl.textContent = "API failed, fallback node added.";
  }
  formEl.reset();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const key = chip.getAttribute("data-seed");
    const seed = seedDb[key];
    if (seed) addNode(seed);
  });
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

["pulp-fiction", "radiohead", "hitchcock"].forEach((seed) => addNode(seedDb[seed]));
checkSourceHealth();
