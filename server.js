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

  const genreItems = (detail?.genres || []).map((genre) => ({
    label: genre.name,
    url: buildKnowledgeUrl(genre.name),
  }));

  const creditGroups = [
    {
      title: "감독+각본",
      items: [
        ...(director?.name
          ? [{ label: `Director: ${director.name}`, url: buildKnowledgeUrl(director.name) }]
          : []),
        ...writers.map((person) => ({
          label: `Writer: ${person.name}`,
          url: buildKnowledgeUrl(person.name),
        })),
      ],
    },
    {
      title: "제작사+배급사",
      items: [
        ...productionCompanies.map((company) => ({
          label: `Production: ${company.name}`,
          url: buildKnowledgeUrl(company.name),
        })),
        ...distributors.map((name) => ({
          label: `Distributor: ${name}`,
          url: buildKnowledgeUrl(name),
        })),
      ],
    },
    {
      title: "출연",
      items: cast.map((person) => ({
        label: `Cast: ${person.name}`,
        url: buildKnowledgeUrl(person.name),
      })),
    },
    {
      title: "음악+미술+의상",
      items: [
        ...musicCrew.map((person) => ({
          label: `Music: ${person.name}`,
          url: buildKnowledgeUrl(person.name),
        })),
        ...artCrew.map((person) => ({
          label: `Art: ${person.name}`,
          url: buildKnowledgeUrl(person.name),
        })),
        ...costumeCrew.map((person) => ({
          label: `Costume: ${person.name}`,
          url: buildKnowledgeUrl(person.name),
        })),
      ],
    },
  ].map((group) => ({
    ...group,
    items: group.items.slice(0, 12),
  }));

  const directorSignatureProfile = await buildDirectorSignatureProfile({
    directorName: director?.name || "",
    movieTitle: detail.title || q || "",
    directorSummary: directorSummary || "",
    movieSummary: wikiSummary || detail.overview || "",
  });

  const awardItems = awards.length
    ? awards.map((award) => ({ label: award, url: buildKnowledgeUrl(award) }))
    : [{ label: "No award records found in open data.", url: "" }];
  const awardArticleItems = awards.length
    ? await fetchAwardArticles({
        movieTitle: detail.title || q || "",
        directorName: director?.name || "",
        awards,
      })
    : [];

  const connectedSections = [
    { title: "1) Credits", groups: creditGroups, items: [] },
    { title: "2) Genres", items: genreItems.slice(0, 10) },
    {
      title: "3) Director Signatures",
      items: [
        { label: `Style: ${directorSignatureProfile.style}`, url: "" },
        { label: `Themes: ${directorSignatureProfile.themes}`, url: "" },
        { label: `Form: ${directorSignatureProfile.form}`, url: "" },
        { label: `Critical Reception: ${directorSignatureProfile.criticalReception}`, url: "" },
        { label: `Landmark Works: ${directorSignatureProfile.landmarkWorks}`, url: "" },
        { label: `Study Guide: ${directorSignatureProfile.studyGuide}`, url: "" },
      ],
    },
    {
      title: "4) Awards",
      items: [
        ...awardItems.slice(0, 10),
        ...awardArticleItems.slice(0, 3),
      ],
    },
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
    const groupedItems = Array.isArray(section.groups)
      ? section.groups.flatMap((group) => (Array.isArray(group.items) ? group.items : []))
      : [];
    const items = [
      ...(Array.isArray(section.items) ? section.items : []),
      ...groupedItems,
    ];
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

async function buildDirectorSignatureProfile({
  directorName,
  movieTitle,
  directorSummary,
  movieSummary,
}) {
  const fallback = buildFallbackDirectorProfile({
    directorName,
    movieTitle,
    directorSummary,
    movieSummary,
  });

  if (!process.env.OPENAI_API_KEY || !directorName) {
    return fallback;
  }

  try {
    const prompt = [
      "당신은 영화연구 조교수다.",
      "아래 감독에 대해 학술형 한국어 요약을 작성하라.",
      "각 항목은 정확히 4문장으로 구성하라.",
      "항목: style, themes, form, criticalReception, landmarkWorks, studyGuide",
      "JSON만 반환하고 다른 텍스트는 쓰지 마라.",
      `감독: ${directorName}`,
      `관련 작품: ${movieTitle}`,
      `감독 요약 자료: ${directorSummary || "n/a"}`,
      `작품 요약 자료: ${movieSummary || "n/a"}`,
    ].join("\n");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: prompt,
      }),
    });

    if (!response.ok) {
      return fallback;
    }

    const data = await response.json();
    const text = extractResponseText(data);
    const parsed = parseJsonObject(text);
    if (!parsed) {
      return fallback;
    }

    return {
      style: ensureSentenceCount(parsed.style, 4) || fallback.style,
      themes: ensureSentenceCount(parsed.themes, 4) || fallback.themes,
      form: ensureSentenceCount(parsed.form, 4) || fallback.form,
      criticalReception:
        ensureSentenceCount(parsed.criticalReception, 4) || fallback.criticalReception,
      landmarkWorks: ensureSentenceCount(parsed.landmarkWorks, 4) || fallback.landmarkWorks,
      studyGuide: ensureSentenceCount(parsed.studyGuide, 4) || fallback.studyGuide,
    };
  } catch (_error) {
    return fallback;
  }
}

function buildFallbackDirectorProfile({
  directorName,
  movieTitle,
  directorSummary,
  movieSummary,
}) {
  const director = directorName || "이 감독";
  const film = movieTitle || "해당 작품";
  const directorHead = firstSentence(directorSummary) || `${director}는 장르 혼합과 정교한 연출 전략으로 논의된다.`;
  const movieHead = firstSentence(movieSummary) || `${film}는 사회적 맥락과 서사적 장치를 함께 제시한다.`;

  return {
    style: `${directorHead} 연출의 핵심은 장면의 리듬을 통제하면서 감정 곡선을 단계적으로 설계하는 방식이다. 카메라의 이동과 인물 배치를 통해 서사의 권력관계를 시각적으로 구조화한다. 이러한 스타일은 상업성과 작가성을 동시에 확보하려는 전략으로 읽힌다.`,
    themes: `${movieHead} 반복되는 주제는 계급, 욕망, 도덕적 균열처럼 사회구조와 개인심리의 접점에 놓인다. 인물들은 제도적 압력 속에서 선택을 강요받으며 그 과정이 드라마의 긴장을 만든다. 이 주제 구성은 지역적 맥락을 넘어서 동시대 관객의 보편적 불안을 자극한다.`,
    form: `${director}의 형식적 특징은 미장센의 층위를 통해 의미를 누적시키는 데 있다. 컷 전환은 설명보다 함축을 우선하며 관객의 해석 참여를 유도한다. 사운드와 침묵의 대비를 사용해 서사의 전환점을 강조한다. 결과적으로 형식은 내용의 보조가 아니라 비평적 논점을 생성하는 장치로 작동한다.`,
    criticalReception: `${director}에 대한 평단 평가는 대체로 높은 완성도와 장르 혁신을 긍정한다. 동시에 일부 평론은 상징의 과잉이나 주제의 직접성을 한계로 지적한다. 그럼에도 핵심 합의는 대중성과 비평성을 동시 달성했다는 데 있다. 최근 논의에서는 글로벌 수용 맥락에서 이 연출이 어떻게 번역되는지도 중요한 평가 축이 된다.`,
    landmarkWorks: `${director}의 대표작은 시대별 문제의식을 서로 다른 장르 실험으로 제시한다. ${film}는 그중에서도 서사구조와 사회비판의 결합이 선명한 사례로 자주 인용된다. 다른 주요 작품들과 비교하면 동일한 주제가 변주되는 방식이 관찰된다. 따라서 대표작 읽기는 개별 영화 감상보다 작가적 연속성을 추적하는 방식이 효과적이다.`,
    studyGuide: `첫 단계에서는 ${film}를 중심으로 인물관계와 공간구조를 도식화해 기본 문법을 파악한다. 두 번째 단계에서는 같은 감독의 전후기 작품을 비교해 주제와 형식의 변화축을 기록한다. 세 번째 단계에서는 동시대 감독과의 비교를 통해 차별적 미학을 검증한다. 마지막으로 평론문과 인터뷰를 교차독해해 해석의 편향을 점검한다.`,
  };
}

function extractResponseText(data) {
  if (!data) {
    return "";
  }
  if (typeof data.output_text === "string") {
    return data.output_text;
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const texts = [];
  output.forEach((item) => {
    const content = Array.isArray(item?.content) ? item.content : [];
    content.forEach((part) => {
      if (typeof part?.text === "string") {
        texts.push(part.text);
      }
    });
  });
  return texts.join("\n").trim();
}

function parseJsonObject(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0 || end <= start) {
      return null;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function ensureSentenceCount(text, minSentences) {
  const value = String(text || "").trim();
  if (!value) {
    return "";
  }
  const parts = value
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= minSentences) {
    return parts.join(" ");
  }
  const pad = [...parts];
  while (pad.length < minSentences) {
    pad.push("추가적인 학술적 검토가 필요한 지점으로 평가된다.");
  }
  return pad.join(" ");
}

async function fetchAwardArticles({ movieTitle, directorName, awards }) {
  const queryTerms = [movieTitle, directorName, ...awards.slice(0, 2)]
    .filter(Boolean)
    .join(" ");
  if (!queryTerms) {
    return [];
  }

  const rssUrl =
    "https://news.google.com/rss/search?" +
    new URLSearchParams({
      q: `${queryTerms} award`,
      hl: "ko",
      gl: "KR",
      ceid: "KR:ko",
    });

  try {
    const response = await fetch(rssUrl);
    if (!response.ok) {
      return [];
    }
    const xml = await response.text();
    const items = parseGoogleNewsRss(xml).slice(0, 3);
    return items.map((item) => ({
      label: `Article: ${item.title}`,
      url: item.link,
    }));
  } catch (_error) {
    return [];
  }
}

function parseGoogleNewsRss(xml) {
  const matches = [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return matches
    .map((match) => {
      const block = match[1] || "";
      const title = decodeXmlText(extractTag(block, "title"));
      const link = decodeXmlText(extractTag(block, "link"));
      return { title, link };
    })
    .filter((item) => item.title && item.link);
}

function extractTag(source, tagName) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(source || "").match(pattern);
  return match?.[1] || "";
}

function decodeXmlText(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
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
