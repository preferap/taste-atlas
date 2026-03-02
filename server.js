const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 5500;

loadEnvFile();

app.use(express.static(__dirname));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    sources: {
      musicbrainz: true,
      tmdb: Boolean(process.env.TMDB_API_KEY),
      wikidata: true,
      wikipedia: true,
    },
  });
});

app.get("/api/lookup", async (req, res) => {
  const type = String(req.query.type || "").trim();
  const q = String(req.query.q || "").trim();

  if (!type || !q) {
    return res.status(400).json({ error: "Missing query: type and q are required." });
  }

  try {
    if (type === "music") {
      const node = await lookupMusic(q);
      return res.json({ node });
    }

    if (type === "movie") {
      const node = await lookupMovie(q);
      return res.json({ node });
    }

    return res.status(400).json({ error: "type must be 'music' or 'movie'." });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/expand", async (req, res) => {
  const type = String(req.query.type || "").trim();
  const q = String(req.query.q || "").trim();

  if (!type || !q) {
    return res.status(400).json({ error: "Missing query: type and q are required." });
  }

  try {
    if (type === "music") {
      const nodes = await expandMusic(q);
      return res.json({ nodes });
    }
    if (type === "movie") {
      const nodes = await expandMovie(q);
      return res.json({ nodes });
    }
    return res.json({ nodes: [] });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(port, () => {
  console.log(`Taste Atlas server running at http://localhost:${port}`);
});

async function lookupMusic(query) {
  const searchUrl =
    "https://musicbrainz.org/ws/2/artist/?" +
    new URLSearchParams({
      query,
      fmt: "json",
      limit: "1",
    });

  const searchResponse = await fetch(searchUrl, {
    headers: { "User-Agent": "taste-atlas/0.1 (preferap)" },
  });

  if (!searchResponse.ok) {
    throw new Error(`MusicBrainz search failed (${searchResponse.status}).`);
  }

  const searchData = await searchResponse.json();
  const artist = searchData?.artists?.[0];

  if (!artist?.id) {
    return {
      title: query,
      type: "music",
      desc: "No artist found from MusicBrainz.",
      path: ["검색어 구체화", "연관 아티스트 수집", "장르 맥락 확장"],
      links: [],
    };
  }

  const detailUrl =
    `https://musicbrainz.org/ws/2/artist/${artist.id}?` +
    new URLSearchParams({
      inc: "tags+url-rels",
      fmt: "json",
    });

  const detailResponse = await fetch(detailUrl, {
    headers: { "User-Agent": "taste-atlas/0.1 (preferap)" },
  });

  if (!detailResponse.ok) {
    throw new Error(`MusicBrainz detail failed (${detailResponse.status}).`);
  }

  const detail = await detailResponse.json();
  const wikiSummary = await fetchWikipediaSummary(artist.name);
  const wikidataSummary = await fetchWikidataDescription(detail?.relations);
  const tagNames = (detail?.tags || []).slice(0, 6).map((tag) => tag.name);

  return {
    title: artist.name,
    type: "music",
    desc:
      wikiSummary ||
      wikidataSummary ||
      `${artist.name} is linked with ${tagNames.slice(0, 3).join(", ") || "multiple genres"}.`,
    path: [
      `${artist.name} 대표작 확인`,
      `장르 ${tagNames.slice(0, 2).join(" / ") || "분석"} 공부`,
      "영향받은 아티스트/씬 연결",
    ],
    links: [
      ...tagNames,
      `Country: ${detail?.country || "n/a"}`,
      `Disambiguation: ${detail?.disambiguation || "n/a"}`,
      "Source: MusicBrainz",
    ],
  };
}

async function lookupMovie(query) {
  if (!process.env.TMDB_API_KEY) {
    return {
      title: query,
      type: "movie",
      desc: "TMDB_API_KEY missing. Add key to .env first.",
      path: [],
      links: [],
      connectedSections: [],
    };
  }

  const movieSearchUrl =
    "https://api.themoviedb.org/3/search/movie?" +
    new URLSearchParams({
      api_key: process.env.TMDB_API_KEY,
      query,
      language: "ko-KR",
      include_adult: "false",
      page: "1",
    });
  const personSearchUrl =
    "https://api.themoviedb.org/3/search/person?" +
    new URLSearchParams({
      api_key: process.env.TMDB_API_KEY,
      query,
      language: "ko-KR",
      include_adult: "false",
      page: "1",
    });

  const [movieSearchResponse, personSearchResponse] = await Promise.all([
    fetch(movieSearchUrl),
    fetch(personSearchUrl),
  ]);
  if (!movieSearchResponse.ok || !personSearchResponse.ok) {
    throw new Error(`TMDB search failed (${movieSearchResponse.status}).`);
  }

  const movieSearchData = await movieSearchResponse.json();
  const personSearchData = await personSearchResponse.json();
  const movieByTitle = movieSearchData?.results?.[0];
  const directorPerson = (personSearchData?.results || []).find(
    (person) => person.known_for_department === "Directing"
  );

  const queryNormalized = normalizeText(query);
  const isDirectorNameQuery =
    directorPerson && normalizeText(directorPerson.name) === queryNormalized;

  let movie = movieByTitle;
  let searchMode = "title";

  if ((!movie && directorPerson) || isDirectorNameQuery) {
    movie = await findTopDirectedMovie(directorPerson.id);
    searchMode = "director";
  }

  if (!movie?.id) {
    return {
      title: query,
      type: "movie",
      desc: "No movie/director result found from TMDB.",
      path: [],
      links: [],
      connectedSections: [],
    };
  }

  const detailUrl =
    `https://api.themoviedb.org/3/movie/${movie.id}?` +
    new URLSearchParams({
      api_key: process.env.TMDB_API_KEY,
      language: "ko-KR",
    });

  const creditUrl =
    `https://api.themoviedb.org/3/movie/${movie.id}/credits?` +
    new URLSearchParams({
      api_key: process.env.TMDB_API_KEY,
      language: "ko-KR",
    });

  const [detailResponse, creditResponse] = await Promise.all([
    fetch(detailUrl),
    fetch(creditUrl),
  ]);

  if (!detailResponse.ok || !creditResponse.ok) {
    throw new Error("TMDB detail/credit fetch failed.");
  }

  const detail = await detailResponse.json();
  const credit = await creditResponse.json();
  const director = credit?.crew?.find((person) => person.job === "Director");
  const writers = uniqByName(
    credit?.crew?.filter((person) =>
      ["Screenplay", "Writer", "Story"].includes(person.job)
    ) || []
  ).slice(0, 5);
  const cast = uniqByName(credit?.cast || []).slice(0, 8);
  const musicCrew = uniqByName(
    credit?.crew?.filter((person) => person.job?.toLowerCase().includes("music")) || []
  ).slice(0, 3);
  const artCrew = uniqByName(
    credit?.crew?.filter((person) =>
      ["Production Design", "Art Direction", "Set Decoration"].includes(person.job)
    ) || []
  ).slice(0, 3);
  const costumeCrew = uniqByName(
    credit?.crew?.filter((person) => person.job?.toLowerCase().includes("costume")) || []
  ).slice(0, 3);

  const productionCompanies = (detail?.production_companies || []).slice(0, 6);
  const wikiSummary = await fetchWikipediaSummary(detail.title || movie.title || query);
  const directorSummary = director?.name ? await fetchWikipediaSummary(director.name) : null;
  const { awards, distributors } = await fetchMovieWikidataMeta(detail.title || movie.title);

  const creditsItems = [];
  if (director?.name) {
    creditsItems.push({
      label: `Director: ${director.name}`,
      url: buildKnowledgeUrl(director.name),
    });
  }
  writers.forEach((person) => {
    creditsItems.push({
      label: `Writer: ${person.name}`,
      url: buildKnowledgeUrl(person.name),
    });
  });
  productionCompanies.forEach((company) => {
    creditsItems.push({
      label: `Production: ${company.name}`,
      url: buildKnowledgeUrl(company.name),
    });
  });
  if (distributors.length) {
    distributors.forEach((name) => {
      creditsItems.push({
        label: `Distributor: ${name}`,
        url: buildKnowledgeUrl(name),
      });
    });
  } else {
    creditsItems.push({
      label: "Distributor: n/a",
      url: "",
    });
  }
  cast.forEach((person) => {
    creditsItems.push({
      label: `Cast: ${person.name}`,
      url: buildKnowledgeUrl(person.name),
    });
  });
  musicCrew.forEach((person) => {
    creditsItems.push({
      label: `Music: ${person.name}`,
      url: buildKnowledgeUrl(person.name),
    });
  });
  artCrew.forEach((person) => {
    creditsItems.push({
      label: `Art: ${person.name}`,
      url: buildKnowledgeUrl(person.name),
    });
  });
  costumeCrew.forEach((person) => {
    creditsItems.push({
      label: `Costume: ${person.name}`,
      url: buildKnowledgeUrl(person.name),
    });
  });

  const genreItems = (detail?.genres || []).map((genre) => ({
    label: genre.name,
    url: buildKnowledgeUrl(genre.name),
  }));
  const directorFeature = firstSentence(directorSummary) || "Open data에서 감독 특징 정보가 제한적입니다.";
  const awardItems = awards.length
    ? awards.map((award) => ({ label: award, url: buildKnowledgeUrl(award) }))
    : [{ label: "No award records found in open data.", url: "" }];

  const connectedSections = [
    { title: "1) Credits", items: creditsItems.slice(0, 40) },
    { title: "2) Genres", items: genreItems.slice(0, 10) },
    {
      title: "3) Director Signatures",
      items: [
        {
          label: director?.name
            ? `${director.name}: ${directorFeature}`
            : directorFeature,
          url: director?.name ? buildKnowledgeUrl(director.name) : "",
        },
      ],
    },
    { title: "4) Awards", items: awardItems.slice(0, 20) },
  ];

  return {
    title: detail.title,
    type: "movie",
    desc:
      wikiSummary ||
      detail.overview ||
      `${detail.title} (${searchMode} search), released on ${detail.release_date || "n/a"}.`,
    path: [],
    links: [
      `Search mode: ${searchMode}`,
      ...((detail.genres || []).slice(0, 6).map((genre) => genre.name)),
      `Release: ${detail.release_date || "n/a"}`,
      "Source: TMDB",
    ],
    connectedSections,
  };
}

async function findTopDirectedMovie(personId) {
  if (!personId || !process.env.TMDB_API_KEY) {
    return null;
  }
  const creditsUrl =
    `https://api.themoviedb.org/3/person/${personId}/movie_credits?` +
    new URLSearchParams({
      api_key: process.env.TMDB_API_KEY,
      language: "ko-KR",
    });
  const creditsResponse = await fetch(creditsUrl);
  if (!creditsResponse.ok) {
    return null;
  }
  const credits = await creditsResponse.json();
  const directed = (credits?.crew || []).filter((item) => item.job === "Director");
  directed.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return directed[0] || null;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqByName(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeText(item?.name);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildKnowledgeUrl(name) {
  if (!name) {
    return "";
  }
  if (/[가-힣]/.test(name)) {
    return `https://namu.wiki/w/${encodeURIComponent(name)}`;
  }
  return `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(name)}`;
}

function firstSentence(text) {
  if (!text) {
    return "";
  }
  const [head] = String(text).split(/(?<=[.!?])\s+/);
  return head || text;
}

async function fetchMovieWikidataMeta(title) {
  const qid = await fetchWikipediaQid(title);
  if (!qid) {
    return { awards: [], distributors: [] };
  }
  const entity = await fetchWikidataEntity(qid);
  if (!entity) {
    return { awards: [], distributors: [] };
  }
  const awardIds = extractClaimEntityIds(entity, "P166");
  const distributorIds = extractClaimEntityIds(entity, "P750");
  const labelMap = await fetchWikidataLabels([...awardIds, ...distributorIds]);
  return {
    awards: awardIds.map((id) => labelMap[id]).filter(Boolean),
    distributors: distributorIds.map((id) => labelMap[id]).filter(Boolean),
  };
}

async function fetchWikipediaQid(title) {
  if (!title) {
    return null;
  }
  const url =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      format: "json",
      prop: "pageprops",
      ppprop: "wikibase_item",
      titles: title,
      origin: "*",
    });
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  const pages = data?.query?.pages || {};
  const firstPage = Object.values(pages)[0];
  return firstPage?.pageprops?.wikibase_item || null;
}

async function fetchWikidataEntity(qid) {
  const url =
    "https://www.wikidata.org/w/api.php?" +
    new URLSearchParams({
      action: "wbgetentities",
      ids: qid,
      props: "claims",
      format: "json",
      origin: "*",
    });
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data?.entities?.[qid] || null;
}

function extractClaimEntityIds(entity, propertyId) {
  const claims = entity?.claims?.[propertyId] || [];
  const ids = [];
  claims.forEach((claim) => {
    const id = claim?.mainsnak?.datavalue?.value?.id;
    if (id) {
      ids.push(id);
    }
  });
  return [...new Set(ids)];
}

async function fetchWikidataLabels(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) {
    return {};
  }
  const url =
    "https://www.wikidata.org/w/api.php?" +
    new URLSearchParams({
      action: "wbgetentities",
      ids: uniqueIds.join("|"),
      props: "labels",
      languages: "en|ko",
      format: "json",
      origin: "*",
    });
  const response = await fetch(url);
  if (!response.ok) {
    return {};
  }
  const data = await response.json();
  const entities = data?.entities || {};
  const output = {};
  uniqueIds.forEach((id) => {
    output[id] = entities?.[id]?.labels?.ko?.value || entities?.[id]?.labels?.en?.value || id;
  });
  return output;
}

async function expandMusic(query) {
  const searchUrl =
    "https://musicbrainz.org/ws/2/artist/?" +
    new URLSearchParams({
      query,
      fmt: "json",
      limit: "1",
    });

  const searchResponse = await fetch(searchUrl, {
    headers: { "User-Agent": "taste-atlas/0.1 (preferap)" },
  });
  if (!searchResponse.ok) {
    throw new Error(`MusicBrainz search failed (${searchResponse.status}).`);
  }

  const searchData = await searchResponse.json();
  const artist = searchData?.artists?.[0];
  if (!artist?.id) {
    return [];
  }

  const detailUrl =
    `https://musicbrainz.org/ws/2/artist/${artist.id}?` +
    new URLSearchParams({
      inc: "tags+url-rels",
      fmt: "json",
    });
  const detailResponse = await fetch(detailUrl, {
    headers: { "User-Agent": "taste-atlas/0.1 (preferap)" },
  });
  if (!detailResponse.ok) {
    throw new Error(`MusicBrainz detail failed (${detailResponse.status}).`);
  }
  const detail = await detailResponse.json();

  const tagNodes = (detail?.tags || []).slice(0, 6).map((tag) => ({
    title: tag.name,
    type: "concept",
    desc: `${artist.name}와 연결된 음악 태그.`,
    path: [`${tag.name} 장르/태그 기원 탐색`, `${artist.name}와 연관된 작품 비교`],
    links: ["Source: MusicBrainz tag"],
  }));

  const contextNodes = [];
  if (detail?.country) {
    contextNodes.push({
      title: detail.country,
      type: "concept",
      desc: `${artist.name}의 활동 국가 코드.`,
      path: ["해당 국가 음악 씬 조사", "동시대 아티스트 비교"],
      links: ["Source: MusicBrainz country"],
    });
  }

  return [...tagNodes, ...contextNodes];
}

async function expandMovie(query) {
  if (!process.env.TMDB_API_KEY) {
    return [
      {
        title: "TMDB key needed",
        type: "concept",
        desc: "TMDB_API_KEY 설정 후 영화 확장 기능이 활성화됩니다.",
        path: ["TMDB API 키 발급", ".env에 TMDB_API_KEY 추가"],
        links: [],
      },
    ];
  }

  const searchUrl =
    "https://api.themoviedb.org/3/search/movie?" +
    new URLSearchParams({
      api_key: process.env.TMDB_API_KEY,
      query,
      language: "en-US",
      include_adult: "false",
      page: "1",
    });
  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    throw new Error(`TMDB search failed (${searchResponse.status}).`);
  }
  const searchData = await searchResponse.json();
  const movie = searchData?.results?.[0];
  if (!movie?.id) {
    return [];
  }

  const detailUrl =
    `https://api.themoviedb.org/3/movie/${movie.id}?` +
    new URLSearchParams({
      api_key: process.env.TMDB_API_KEY,
      language: "en-US",
    });
  const creditUrl =
    `https://api.themoviedb.org/3/movie/${movie.id}/credits?` +
    new URLSearchParams({
      api_key: process.env.TMDB_API_KEY,
      language: "en-US",
    });

  const [detailResponse, creditResponse] = await Promise.all([
    fetch(detailUrl),
    fetch(creditUrl),
  ]);
  if (!detailResponse.ok || !creditResponse.ok) {
    throw new Error("TMDB detail/credits failed.");
  }
  const detail = await detailResponse.json();
  const credit = await creditResponse.json();

  const director = credit?.crew?.find((person) => person.job === "Director");
  const genreNodes = (detail?.genres || []).slice(0, 6).map((genre) => ({
    title: genre.name,
    type: "concept",
    desc: `${detail.title}의 장르 연결 노드`,
    path: [`${genre.name}의 역사 조사`, "대표 영화 리스트 정리"],
    links: ["Source: TMDB genre"],
  }));

  const directorNode = director
    ? [
        {
          title: director.name,
          type: "person",
          desc: `${detail.title}의 감독`,
          path: [`${director.name} 필모그래피 조사`, "연출 스타일 특징 정리"],
          links: ["Source: TMDB credits"],
        },
      ]
    : [];

  return [...directorNode, ...genreNodes];
}

async function fetchWikipediaSummary(title) {
  if (!title) {
    return null;
  }

  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return data.extract || null;
}

async function fetchWikidataDescription(relations) {
  const wikidataUrl = relations?.find((rel) => rel?.type === "wikidata")?.url?.resource;
  if (!wikidataUrl) {
    return null;
  }

  const qid = wikidataUrl.split("/").pop();
  if (!qid) {
    return null;
  }

  const url =
    "https://www.wikidata.org/w/api.php?" +
    new URLSearchParams({
      action: "wbgetentities",
      ids: qid,
      props: "descriptions",
      format: "json",
      origin: "*",
    });

  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data?.entities?.[qid]?.descriptions?.en?.value || null;
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      return;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}
