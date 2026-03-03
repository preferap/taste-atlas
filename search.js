const GRAPH_STORAGE_KEY = "taste-atlas-graph-v2";
const LAST_RESULTS_KEY = "taste-atlas-last-results-v1";

const formEl = document.getElementById("taste-form");
const inputEl = document.getElementById("title");
const sourceStatusEl = document.getElementById("source-status");
const searchShellEl = document.getElementById("search-shell");
const typeMovieEl = document.getElementById("type-movie");
const typeMusicEl = document.getElementById("type-music");
const searchResultsEl = document.getElementById("search-results");
const contentResultListEl = document.getElementById("content-result-list");
const personResultListEl = document.getElementById("person-result-list");
const contentResultHeadingEl = document.getElementById("content-result-heading");
const personResultHeadingEl = document.getElementById("person-result-heading");

const detailEmptyEl = document.getElementById("detail-empty");
const detailCardEl = document.getElementById("detail-card");
const detailTitleEl = document.getElementById("detail-title");
const detailTypeEl = document.getElementById("detail-type");
const detailPosterEl = document.getElementById("detail-poster");
const detailDescEl = document.getElementById("detail-desc");
const detailConnectedSectionsEl = document.getElementById("detail-connected-sections");

let activeType = "movie";
let pendingSearch = null;

function setActiveType(type) {
  activeType = type;
  typeMovieEl.classList.toggle("active", type === "movie");
  typeMusicEl.classList.toggle("active", type === "music");
  updateResultHeadings();
}

typeMovieEl.addEventListener("click", () => setActiveType("movie"));
typeMusicEl.addEventListener("click", () => setActiveType("music"));

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = inputEl.value.trim();
  if (!query) {
    return;
  }

  sourceStatusEl.textContent = "Searching candidates...";
  try {
    const response = await fetch(
      `/api/search?type=${encodeURIComponent(activeType)}&q=${encodeURIComponent(query)}`
    );
    if (!response.ok) {
      throw new Error(`search failed ${response.status}`);
    }
    const data = await response.json();
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];

    const grouped = groupCandidates(candidates);
    pendingSearch = {
      type: activeType,
      q: query,
      grouped,
    };

    window.localStorage.setItem(LAST_RESULTS_KEY, JSON.stringify(grouped));
    renderCandidates(grouped);
    setShellState(true);
    sourceStatusEl.textContent = `Found ${candidates.length} result(s).`;
  } catch (_error) {
    sourceStatusEl.textContent = "Search failed. Check API/network.";
    clearCandidates();
  }
});

function groupCandidates(candidates) {
  const content = [];
  const person = [];

  candidates.forEach((candidate) => {
    if (["director", "artist", "person"].includes(candidate.kind)) {
      person.push(candidate);
    } else {
      content.push(candidate);
    }
  });

  return { content, person };
}

function renderCandidates(grouped) {
  searchResultsEl.classList.remove("hidden");
  renderCandidateList(contentResultListEl, grouped.content);
  renderCandidateList(personResultListEl, grouped.person);
}

function clearCandidates() {
  searchResultsEl.classList.add("hidden");
  contentResultListEl.innerHTML = "";
  personResultListEl.innerHTML = "";
  setShellState(false);
}

function renderCandidateList(container, items) {
  container.innerHTML = "";

  if (!items.length) {
    const li = document.createElement("li");
    li.className = "search-result-item";
    li.innerHTML = `<div class="search-result-main"><strong>n/a</strong><span>No results</span></div>`;
    container.appendChild(li);
    return;
  }

  items.forEach((candidate) => {
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

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "search-result-use";
    selectButton.textContent = "Select";
    selectButton.addEventListener("click", () => selectCandidate(candidate));

    li.appendChild(image);
    li.appendChild(main);
    li.appendChild(selectButton);
    container.appendChild(li);
  });
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
      throw new Error(`lookup failed ${response.status}`);
    }

    const data = await response.json();
    const node = normalizeNode(data.node);
    saveNode(node);
    renderDetail(node);

    sourceStatusEl.textContent = "Saved to nodes.";
  } catch (_error) {
    sourceStatusEl.textContent = "Lookup failed. Check API/network.";
  }
}

function normalizeNode(node) {
  return {
    ...node,
    type: node.type || activeType,
    path: Array.isArray(node.path) ? node.path : [],
    links: Array.isArray(node.links) ? node.links : [],
    connectedSections: Array.isArray(node.connectedSections) ? node.connectedSections : [],
    depth: 0,
    parentId: null,
    branchGroup: node.type || activeType,
  };
}

function saveNode(node) {
  const graph = loadGraph();
  const existing = graph.nodes.find(
    (candidate) =>
      normalizeText(candidate.title) === normalizeText(node.title) && candidate.type === node.type
  );

  if (existing) {
    Object.assign(existing, node);
  } else {
    graph.nodes.push({
      id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      ...node,
    });
  }

  window.localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(graph));
}

function renderDetail(node) {
  detailEmptyEl.classList.add("hidden");
  detailCardEl.classList.remove("hidden");

  detailTitleEl.textContent = node.title;
  detailTypeEl.textContent = String(node.type || "unknown").toUpperCase();
  detailDescEl.textContent = node.desc || "No description yet.";

  if (node.posterUrl) {
    detailPosterEl.src = node.posterUrl;
    detailPosterEl.classList.remove("hidden");
  } else {
    detailPosterEl.removeAttribute("src");
    detailPosterEl.classList.add("hidden");
  }

  detailConnectedSectionsEl.innerHTML = "";
  node.connectedSections.forEach((section) => {
    const wrapper = document.createElement("section");
    wrapper.className = "connected-group";

    const title = document.createElement("h5");
    title.textContent = section.title;
    wrapper.appendChild(title);

    const groups = Array.isArray(section.groups) ? section.groups : [];
    if (groups.length > 0) {
      groups.forEach((group) => {
        const groupTitle = document.createElement("p");
        groupTitle.className = "muted";
        groupTitle.textContent = group.title || "";
        wrapper.appendChild(groupTitle);
        const groupList = document.createElement("ul");
        const groupItems = Array.isArray(group.items) ? group.items : [];
        groupItems.forEach((item) => {
          const li = document.createElement("li");
          if (item.url) {
            const a = document.createElement("a");
            a.href = item.url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = item.label || item.name || "";
            li.appendChild(a);
          } else {
            li.textContent = item.label || item.name || "";
          }
          groupList.appendChild(li);
        });
        wrapper.appendChild(groupList);
      });
    }

    const items = Array.isArray(section.items) ? section.items : [];
    if (items.length) {
      const list = document.createElement("ul");
      items.forEach((item) => {
        const li = document.createElement("li");
        if (item.url) {
          const a = document.createElement("a");
          a.href = item.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = item.label || item.name || "";
          li.appendChild(a);
        } else {
          li.textContent = item.label || item.name || "";
        }
        list.appendChild(li);
      });
      wrapper.appendChild(list);
    }
    detailConnectedSectionsEl.appendChild(wrapper);
  });
}

function updateResultHeadings() {
  if (!contentResultHeadingEl || !personResultHeadingEl) {
    return;
  }
  if (activeType === "music") {
    contentResultHeadingEl.textContent = "Albums";
    personResultHeadingEl.textContent = "Artists";
    return;
  }
  contentResultHeadingEl.textContent = "Films";
  personResultHeadingEl.textContent = "People";
}

function setShellState(active) {
  if (!searchShellEl) {
    return;
  }
  searchShellEl.classList.toggle("active", active);
  searchShellEl.classList.toggle("idle", !active);
}

function loadGraph() {
  const raw = window.localStorage.getItem(GRAPH_STORAGE_KEY);
  if (!raw) {
    return { nodes: [], edges: [], nodeSerial: 0 };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      nodeSerial: parsed.nodeSerial || 0,
    };
  } catch {
    return { nodes: [], edges: [], nodeSerial: 0 };
  }
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

async function checkSourceHealth() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      throw new Error("health failed");
    }
    const data = await response.json();
    const music = data.sources.musicbrainz ? "MusicBrainz: ON" : "MusicBrainz: OFF";
    const tmdb = data.sources.tmdb ? "TMDB: ON" : "TMDB: OFF";
    sourceStatusEl.textContent = `${music} | ${tmdb} | Wikidata: ON`;
  } catch (_error) {
    sourceStatusEl.textContent = "Health check failed. Start with: npm run dev";
  }
}

checkSourceHealth();
updateResultHeadings();
