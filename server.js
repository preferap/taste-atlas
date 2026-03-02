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

app.get("/api/search", async (req, res) => {
  const type = String(req.query.type || "").trim();
  const q = String(req.query.q || "").trim();

  if (!type || !q) {
    return res.status(400).json({ error: "Missing query: type and q are required." });
  }

  try {
    if (type === "movie") {
      const candidates = await searchMovieCandidates(q);
      return res.json({ candidates });
    }
    if (type === "music") {
      const candidates = await searchMusicCandidates(q);
      return res.json({ candidates });
    }
    return res.status(400).json({ error: "type must be 'music' or 'movie'." });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/lookup", async (req, res) => {
  const type = String(req.query.type || "").trim();
  const q = String(req.query.q || "").trim();
  const candidateId = String(req.query.candidateId || "").trim();
  const candidateKind = String(req.query.candidateKind || "").trim();

  if (!type || (!q && !candidateId)) {
    return res.status(400).json({ error: "Missing query." });
  }

  try {
    if (type === "movie") {
      const node = await lookupMovie({ q, candidateId, candidateKind });
      return res.json({ node });
    }
    if (type === "music") {
      const node = await lookupMusic({ q, candidateId, candidateKind });
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
    if (type === "movie") {
      const nodes = await expandMovie(q);
      return res.json({ nodes });
    }
    if (type === "music") {
      const nodes = await expandMusic(q);
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

async function searchMovieCandidates(query) {
  if (!process.env.TMDB_API_KEY) {
    return [
      {
        id: "missing-key",
        kind: "movie",
        title: query,
        subtitle: "TMDB_API_KEY missing. Add key to .env first.",
        posterUrl: "",
      },
    ];
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

  const [movieResponse, personResponse] = await Promise.all([
    fetch(movieSearchUrl),
    fetch(personSearchUrl),
  ]);

  if (!movieResponse.ok || !personResponse.ok) {
    throw new Error(`TMDB search failed (${movieResponse.status}).`);
  }

  const movieData = await movieResponse.json();
  const personData = await personResponse.json();

  const movieCandidates = (movieData?.results || []).slice(0, 8).map((movie) => ({
    id: String(movie.id),
    kind: "movie",
    title: movie.title,
    subtitle: `${movie.release_date || "n/a"} · ${movie.original_title || ""}`,
    posterUrl: tmdbImageUrl(movie.poster_path, "w185"),
  }));

  const directorCandidates = (personData?.results || [])
    .filter((person) => person.known_for_department === "Directing")
    .slice(0, 6)
    .map((person) => ({
      id: String(person.id),
      kind: "director",
      title: person.name,
      subtitle: `Director · ${person.known_for?.map((item) => item.title).filter(Boolean).join(", ") || "known works"}`,
      posterUrl: tmdbImageUrl(person.profile_path, "w185"),
    }));

  const qn = normalizeText(query);
  const directorMatch = directorCandidates.some(
    (candidate) =>
      normalizeText(candidate.title).includes(qn) ||
      normalizeText(candidate.subtitle).includes(qn)
  );
  const movieMatch = movieCandidates.some(
    (candidate) =>
      normalizeText(candidate.title).includes(qn) ||
      normalizeText(candidate.subtitle).includes(qn)
  );
  const prioritizeDirector = directorMatch || (!movieMatch && directorCandidates.length > 0);
  const ordered = prioritizeDirector
    ? [...directorCandidates, ...movieCandidates]
    : [...movieCandidates, ...directorCandidates];
  return dedupeCandidates(ordered);
}

async function searchMusicCandidates(query) {
  try {
    const artistSearchUrl =
      "https://musicbrainz.org/ws/2/artist/?" +
      new URLSearchParams({
        query,
        fmt: "json",
        limit: "8",
      });

    const releaseSearchUrl =
      "https://musicbrainz.org/ws/2/release-group/?" +
      new URLSearchParams({
        query,
        fmt: "json",
        limit: "8",
      });

    const [artistResponse, releaseResponse] = await Promise.all([
      fetch(artistSearchUrl, { headers: { "User-Agent": "taste-atlas/0.1 (preferap)" } }),
      fetch(releaseSearchUrl, { headers: { "User-Agent": "taste-atlas/0.1 (preferap)" } }),
    ]);

    if (!artistResponse.ok || !releaseResponse.ok) {
      throw new Error(`MusicBrainz search failed (${artistResponse.status}).`);
    }

    const artistData = await artistResponse.json();
    const releaseData = await releaseResponse.json();

    const artistCandidates = (artistData?.artists || []).slice(0, 8).map((artist) => ({
      id: artist.id,
      kind: "artist",
      title: artist.name,
      subtitle: `${artist.country || "n/a"} · ${artist.disambiguation || "artist"}`,
      posterUrl: "",
    }));

    const releaseCandidates = (releaseData?.["release-groups"] || [])
      .slice(0, 8)
      .map((release) => ({
        id: release.id,
        kind: "release",
        title: release.title,
        subtitle: `${release["first-release-date"] || "n/a"} · ${
          release["artist-credit"]?.[0]?.name || "unknown"
        }`,
        posterUrl: coverArtUrl(release.id),
      }));

    return dedupeCandidates([...artistCandidates, ...releaseCandidates]);
  } catch (_error) {
    return [
      {
        id: "fallback-music",
        kind: "artist",
        title: query,
        subtitle: "MusicBrainz connection failed. Use this fallback.",
        posterUrl: "",
      },
    ];
  }
}

async function lookupMovie({ q, candidateId, candidateKind }) {
  if (!process.env.TMDB_API_KEY) {
    return {
      title: q || "movie",
      type: "movie",
      desc: "TMDB_API_KEY missing. Add key to .env first.",
      path: [],
      links: [],
      connectedSections: [],
      posterUrl: "",
    };
  }

  let movie = null;
  let searchMode = "title";
  let directorRef = null;

  if (candidateKind === "movie" && candidateId) {
    movie = { id: Number(candidateId) };
  } else if (candidateKind === "director" && candidateId) {
    movie = await findTopDirectedMovie(Number(candidateId));
    directorRef = await getTmdbPerson(Number(candidateId));
    searchMode = "director";
  } else {
    const candidates = await searchMovieCandidates(q);
    const first = candidates[0];
    if (first?.kind === "director") {
      movie = await findTopDirectedMovie(Number(first.id));
      directorRef = await getTmdbPerson(Number(first.id));
      searchMode = "director";
    } else if (first?.kind === "movie") {
      movie = { id: Number(first.id) };
    }
  }

  if (!movie?.id) {
    return {
      title: q,
      type: "movie",
      desc: "No movie/director result found from TMDB.",
      path: [],
      links: [],
      connectedSections: [],
      posterUrl: "",
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

  const [detailResponse, creditResponse] = await Promise.all([fetch(detailUrl), fetch(creditUrl)]);
  if (!detailResponse.ok || !creditResponse.ok) {
    throw new Error("TMDB detail/credit fetch failed.");
  }

  const detail = await detailResponse.json();
  const credit = await creditResponse.json();
  const director = credit?.crew?.find((person) => person.job === "Director") || directorRef;

  const writers = uniqByName(
    credit?.crew?.filter((person) => ["Screenplay", "Writer", "Story"].includes(person.job)) || []
  ).slice(0, 5);
  const cast = uniqByName(credit?.cast || []).slice(0, 8);
  const musicCrew = uniqByName(
    credit?.crew?.filter((person) => person.job?.toLowerCase().includes("music")) || []
  ).slice(0, 3);
  const artCrew = uniqByName(
    credit?.crew?.filter((person) => ["Production Design", "Art Direction", "Set Decoration"].includes(person.job)) || []
  ).slice(0, 3);
  const costumeCrew = uniqByName(
    credit?.crew?.filter((person) => person.job?.toLowerCase().includes("costume")) || []
  ).slice(0, 3);

  const productionCompanies = (detail?.production_companies || []).slice(0, 6);
  const wikiSummary = await fetchWikipediaSummary(detail.title || q);
  const directorSummary = director?.name ? await fetchWikipediaSummary(director.name) : null;
  const { awards, distributors } = await fetchMovieWikidataMeta(detail.title || q);

  const creditsItems = [];
  if (director?.name) {
    creditsItems.push({ label: `Director: ${director.name}`, url: buildKnowledgeUrl(director.name) });
  }
  writers.forEach((person) => {
    creditsItems.push({ label: `Writer: ${person.name}`, url: buildKnowledgeUrl(person.name) });
  });
  productionCompanies.forEach((company) => {
    creditsItems.push({ label: `Production: ${company.name}`, url: buildKnowledgeUrl(company.name) });
  });
  if (distributors.length) {
    distributors.forEach((name) => {
      creditsItems.push({ label: `Distributor: ${name}`, url: buildKnowledgeUrl(name) });
    });
  }
  cast.forEach((person) => {
    creditsItems.push({ label: `Cast: ${person.name}`, url: buildKnowledgeUrl(person.name) });
  });
  musicCrew.forEach((person) => {
    creditsItems.push({ label: `Music: ${person.name}`, url: buildKnowledgeUrl(person.name) });
  });
  artCrew.forEach((person) => {
    creditsItems.push({ label: `Art: ${person.name}`, url: buildKnowledgeUrl(person.name) });
  });
  costumeCrew.forEach((person) => {
    creditsItems.push({ label: `Costume: ${person.name}`, url: buildKnowledgeUrl(person.name) });
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
          label: director?.name ? `${director.name}: ${directorFeature}` : directorFeature,
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
    posterUrl: tmdbImageUrl(detail.poster_path, "w500"),
  };
}

async function lookupMusic({ q, candidateId, candidateKind }) {
  let artistId = "";
  let sourceKind = candidateKind || "artist";
  let posterUrl = "";

  if (candidateId && candidateKind === "artist") {
    artistId = candidateId;
  }

  if (candidateId && candidateKind === "release") {
    const releaseDetail = await fetchMusicBrainzReleaseGroup(candidateId);
    const artistCredit = releaseDetail?.["artist-credit"]?.[0]?.artist;
    if (artistCredit?.id) {
      artistId = artistCredit.id;
      sourceKind = "artist";
    }
    posterUrl = coverArtUrl(candidateId);
  }

  if (!artistId) {
    const candidates = await searchMusicCandidates(q);
    const firstArtist = candidates.find((candidate) => candidate.kind === "artist");
    if (firstArtist) {
      artistId = firstArtist.id;
      sourceKind = "artist";
    }
  }

  if (artistId.startsWith("fallback-")) {
    return {
      title: q || "music",
      type: "music",
      desc: "MusicBrainz connection is currently unavailable. Fallback node created.",
      path: ["검색어 보존", "네트워크 복구 후 재조회", "장르/아티스트 맥락 확장"],
      links: ["Source: local fallback"],
      connectedSections: [
        {
          title: "1) Profile",
          items: [{ label: `Query: ${q}`, url: "" }],
        },
        {
          title: "2) Genres",
          items: [{ label: "n/a", url: "" }],
        },
        {
          title: "3) Artist Signatures",
          items: [{ label: "n/a", url: "" }],
        },
        {
          title: "4) Awards",
          items: [{ label: "n/a", url: "" }],
        },
      ],
      posterUrl: "",
    };
  }

  if (!artistId) {
    return {
      title: q,
      type: "music",
      desc: "No artist found from MusicBrainz.",
      path: ["검색어 구체화", "연관 아티스트 수집", "장르 맥락 확장"],
      links: [],
      connectedSections: [],
      posterUrl: "",
    };
  }

  const detail = await fetchMusicBrainzArtist(artistId);
  const wikiSummary = await fetchWikipediaSummary(detail.name);
  const wikidataDesc = await fetchWikidataDescription(detail?.relations);
  const tagNames = (detail?.tags || []).slice(0, 10).map((tag) => tag.name);
  const { awards } = await fetchWikidataMetaFromRelations(detail?.relations);

  const profileItems = [
    { label: `Artist: ${detail.name}`, url: buildKnowledgeUrl(detail.name) },
    { label: `Country: ${detail.country || "n/a"}`, url: "" },
    { label: `Disambiguation: ${detail.disambiguation || "n/a"}`, url: "" },
    { label: `Source kind: ${sourceKind}`, url: "" },
  ];

  const genreItems = tagNames.map((tag) => ({ label: tag, url: buildKnowledgeUrl(tag) }));
  const signatureItems = [
    { label: firstSentence(wikiSummary || wikidataDesc || "Artist signature data is limited."), url: buildKnowledgeUrl(detail.name) },
  ];
  const awardItems = awards.length
    ? awards.map((award) => ({ label: award, url: buildKnowledgeUrl(award) }))
    : [{ label: "No award records found in open data.", url: "" }];

  return {
    title: detail.name,
    type: "music",
    desc:
      wikiSummary ||
      wikidataDesc ||
      `${detail.name} is linked with ${tagNames.slice(0, 3).join(", ") || "multiple genres"}.`,
    path: [
      `${detail.name} 대표작 확인`,
      `장르 ${tagNames.slice(0, 2).join(" / ") || "분석"} 공부`,
      "연결 씬/아티스트 비교",
    ],
    links: [
      ...tagNames.slice(0, 6),
      `Country: ${detail.country || "n/a"}`,
      "Source: MusicBrainz",
    ],
    connectedSections: [
      { title: "1) Profile", items: profileItems },
      { title: "2) Genres", items: genreItems.slice(0, 12) },
      { title: "3) Artist Signatures", items: signatureItems },
      { title: "4) Awards", items: awardItems.slice(0, 20) },
    ],
    posterUrl,
  };
}

async function expandMovie(query) {
  const base = await lookupMovie({ q: query, candidateId: "", candidateKind: "" });
  return buildExpansionNodes(base, "movie");
}

async function expandMusic(query) {
  const base = await lookupMusic({ q: query, candidateId: "", candidateKind: "" });
  return buildExpansionNodes(base, "music");
}

function buildExpansionNodes(baseNode, parentType) {
  const sections = Array.isArray(baseNode.connectedSections) ? baseNode.connectedSections : [];
  const output = [];

  sections.forEach((section) => {
    const items = Array.isArray(section.items) ? section.items : [];
    items.slice(0, 4).forEach((item) => {
      const label = item?.label || item?.name || "";
      if (!label) {
        return;
      }
      output.push({
        title: label.replace(/^[^:]+:\s*/, ""),
        type: "concept",
        desc: `${baseNode.title} → ${section.title}`,
        path: [],
        links: ["Source: open data"],
        branchGroup: section.title,
      });
    });
  });

  if (!output.length) {
    output.push({
      title: parentType === "movie" ? "Related cinema context" : "Related music context",
      type: "concept",
      desc: `No structured expansion data found for ${baseNode.title}`,
      path: [],
      links: ["Source: open data"],
      branchGroup: "Related",
    });
  }

  return output;
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

async function getTmdbPerson(personId) {
  if (!personId || !process.env.TMDB_API_KEY) {
    return null;
  }
  const url =
    `https://api.themoviedb.org/3/person/${personId}?` +
    new URLSearchParams({ api_key: process.env.TMDB_API_KEY, language: "ko-KR" });
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function tmdbImageUrl(pathValue, size = "w342") {
  if (!pathValue) {
    return "";
  }
  return `https://image.tmdb.org/t/p/${size}${pathValue}`;
}

function coverArtUrl(releaseGroupId) {
  if (!releaseGroupId) {
    return "";
  }
  return `https://coverartarchive.org/release-group/${releaseGroupId}/front-250`;
}

async function fetchMusicBrainzArtist(artistId) {
  const url =
    `https://musicbrainz.org/ws/2/artist/${artistId}?` +
    new URLSearchParams({ inc: "tags+url-rels", fmt: "json" });
  const response = await fetch(url, { headers: { "User-Agent": "taste-atlas/0.1 (preferap)" } });
  if (!response.ok) {
    throw new Error(`MusicBrainz artist fetch failed (${response.status}).`);
  }
  return response.json();
}

async function fetchMusicBrainzReleaseGroup(releaseId) {
  const url =
    `https://musicbrainz.org/ws/2/release-group/${releaseId}?` +
    new URLSearchParams({ inc: "artists+tags+url-rels", fmt: "json" });
  const response = await fetch(url, { headers: { "User-Agent": "taste-atlas/0.1 (preferap)" } });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function dedupeCandidates(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.kind}:${normalizeText(item.title)}:${normalizeText(item.subtitle)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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

async function fetchWikidataMetaFromRelations(relations) {
  const qid = extractQidFromRelations(relations);
  if (!qid) {
    return { awards: [] };
  }
  const entity = await fetchWikidataEntity(qid);
  if (!entity) {
    return { awards: [] };
  }
  const awardIds = extractClaimEntityIds(entity, "P166");
  const labels = await fetchWikidataLabels(awardIds);
  return {
    awards: awardIds.map((id) => labels[id]).filter(Boolean),
  };
}

function extractQidFromRelations(relations) {
  const resource = relations?.find((rel) => rel?.type === "wikidata")?.url?.resource;
  if (!resource) {
    return null;
  }
  return resource.split("/").pop() || null;
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
  if (!qid) {
    return null;
  }
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

async function fetchWikidataDescription(relations) {
  const qid = extractQidFromRelations(relations);
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
  return data?.entities?.[qid]?.descriptions?.en?.value || data?.entities?.[qid]?.descriptions?.ko?.value || null;
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
