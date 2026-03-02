const GRAPH_STORAGE_KEY = "taste-atlas-graph-v1";

const pathwayCountEl = document.getElementById("pathway-count");
const pathwayEmptyTextEl = document.getElementById("pathway-empty-text");
const pathwayListEl = document.getElementById("pathway-list");

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

function buildPathways(nodes, edges) {
  const adjacency = new Map();
  edges.forEach((edge) => {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  });

  const pathways = [];
  const rootNodes = nodes.filter((node) => node.type === "music" || node.type === "movie");

  rootNodes.forEach((root) => {
    const neighborIds = adjacency.get(root.id) || [];
    const neighbors = neighborIds
      .map((id) => nodes.find((node) => node.id === id))
      .filter(Boolean)
      .slice(0, 4);

    const steps = [
      `1) Start with "${root.title}"`,
      `2) Read summary: ${root.desc || "No summary"}`,
      ...neighbors.map((node, index) => `${index + 3}) Explore connected concept: ${node.title}`),
    ];

    pathways.push({
      title: `${root.title} study path`,
      steps,
    });
  });

  return pathways;
}

function renderPathways() {
  const { nodes, edges } = loadGraph();
  const pathways = buildPathways(nodes, edges);
  pathwayCountEl.textContent = `${pathways.length} pathways`;

  if (!pathways.length) {
    pathwayEmptyTextEl.style.display = "block";
    return;
  }

  pathwayEmptyTextEl.style.display = "none";
  pathwayListEl.innerHTML = "";

  pathways.forEach((pathway) => {
    const article = document.createElement("article");
    article.className = "pathway-card";

    const title = document.createElement("h3");
    title.textContent = pathway.title;

    const list = document.createElement("ul");
    pathway.steps.forEach((step) => {
      const li = document.createElement("li");
      li.textContent = step;
      list.appendChild(li);
    });

    article.appendChild(title);
    article.appendChild(list);
    pathwayListEl.appendChild(article);
  });
}

renderPathways();
