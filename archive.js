const GRAPH_STORAGE_KEY = "taste-atlas-graph-v2";

const archiveCountEl = document.getElementById("archive-count");
const archiveEmptyTextEl = document.getElementById("archive-empty-text");
const archiveListEl = document.getElementById("archive-list");

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

function countConnections(edges, nodeId) {
  return edges.filter((edge) => edge.from === nodeId || edge.to === nodeId).length;
}

function renderArchive() {
  const { nodes, edges } = loadGraph();
  archiveCountEl.textContent = `${nodes.length} items`;

  if (!nodes.length) {
    archiveEmptyTextEl.style.display = "block";
    return;
  }

  archiveEmptyTextEl.style.display = "none";
  archiveListEl.innerHTML = "";

  const sortedNodes = [...nodes].sort((a, b) => a.title.localeCompare(b.title));
  sortedNodes.forEach((node) => {
    const li = document.createElement("li");
    li.className = "archive-item";

    const connections = countConnections(edges, node.id);
    const path = Array.isArray(node.path) ? node.path : [];
    const links = Array.isArray(node.links) ? node.links : [];
    const connectedSections = Array.isArray(node.connectedSections) ? node.connectedSections : [];
    const connectedSummary = connectedSections
      .map((section) => {
        const directItems = Array.isArray(section.items) ? section.items : [];
        const groupedItems = Array.isArray(section.groups)
          ? section.groups.flatMap((group) => (Array.isArray(group.items) ? group.items : []))
          : [];
        const items = [...directItems, ...groupedItems];
        return `${section.title}: ${items.map((item) => item.label || item.name).join(", ")}`;
      })
      .join(" | ");

    li.innerHTML = `
      <div class="archive-head">
        <strong>${escapeHtml(node.title)}</strong>
        <span class="badge">${escapeHtml(String(node.type || "unknown").toUpperCase())}</span>
      </div>
      <p>${escapeHtml(node.desc || "No description yet.")}</p>
      <p class="muted">Connections: ${connections}</p>
      <p class="muted">Study Path: ${escapeHtml(path.join(" -> ") || "n/a")}</p>
      <p class="muted">Linked Concepts: ${escapeHtml(links.join(", ") || "n/a")}</p>
      <p class="muted">Connected Sections: ${escapeHtml(connectedSummary || "n/a")}</p>
    `;
    archiveListEl.appendChild(li);
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

renderArchive();
