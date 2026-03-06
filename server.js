const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 5500;

loadEnvFile();

app.get(["/", "/index.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "map.html"));
});

app.use(express.static(__dirname, { index: false }));

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
    _popularity: Number(movie.popularity || 0),
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
      _popularity: Number(person.popularity || 0),
    }));

  const rankedMovie = rankCandidatesByRelevance(movieCandidates, query, (c) => c._popularity || 0);
  const rankedDirector = rankCandidatesByRelevance(
    directorCandidates,
    query,
    (c) => c._popularity || 0
  );
  const qn = normalizeText(query);
  const directorMatch = rankedDirector.some((candidate) => candidate._matchScore > 0);
  const movieMatch = rankedMovie.some((candidate) => candidate._matchScore > 0);
  const prioritizeDirector = directorMatch || (!movieMatch && rankedDirector.length > 0);
  const ordered = prioritizeDirector
    ? [...rankedDirector, ...rankedMovie]
    : [...rankedMovie, ...rankedDirector];
  const cleaned = ordered.map(({ _popularity, _matchScore, _extraScore, ...candidate }) => candidate);
  return dedupeCandidates(cleaned);
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
      _score: Number(artist.score || 0),
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
        _score: Number(release.score || 0),
      }));

    const rankedArtist = rankCandidatesByRelevance(artistCandidates, query, (c) => c._score || 0);
    const rankedRelease = rankCandidatesByRelevance(
      releaseCandidates,
      query,
      (c) => c._score || 0
    );
    const ordered = [...rankedArtist, ...rankedRelease].map(
      ({ _score, _matchScore, _extraScore, ...candidate }) => candidate
    );
    return dedupeCandidates(ordered);
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
  let selectedRelease = null;

  if (candidateId && candidateKind === "artist") {
    artistId = candidateId;
  }

  if (candidateId && candidateKind === "release") {
    const releaseDetail = await fetchMusicBrainzReleaseGroup(candidateId);
    selectedRelease = releaseDetail;
    const artistCredit = releaseDetail?.["artist-credit"]?.[0]?.artist;
    if (artistCredit?.id) {
      artistId = artistCredit.id;
      sourceKind = "release";
    }
    posterUrl = coverArtUrl(candidateId);
  }

  if (!artistId) {
    const candidates = await searchMusicCandidates(q);
    const first = candidates[0];
    if (first?.kind === "artist") {
      artistId = first.id;
      sourceKind = "artist";
    } else if (first?.kind === "release") {
      const releaseDetail = await fetchMusicBrainzReleaseGroup(first.id);
      selectedRelease = releaseDetail;
      artistId = releaseDetail?.["artist-credit"]?.[0]?.artist?.id || "";
      sourceKind = "release";
      posterUrl = coverArtUrl(first.id);
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
          title: "Artists",
          items: [{ label: `Query: ${q}`, url: "" }],
        },
        {
          title: "Artist Signatures",
          items: [{ label: "n/a", url: "" }],
        },
        {
          title: "Album",
          items: [{ label: "n/a", url: "" }],
        },
        {
          title: "Discography Highlights",
          items: [{ label: "n/a", url: "" }],
        },
        {
          title: "Genres + Era",
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
  const wikiSummaryRaw = await fetchWikipediaSummary(detail.name, { languages: ["ko", "en"] });
  const wikiSummary = await summarizeToKorean(wikiSummaryRaw, `음악 아티스트 ${detail.name} 설명`);
  const wikidataDesc = await fetchWikidataDescription(detail?.relations);
  const tagNames = (detail?.tags || []).slice(0, 10).map((tag) => tag.name);
  const topReleases = await fetchMusicBrainzReleaseGroupsByArtist(artistId);
  const artistName = detail.name;
  const releaseNodeTitle = selectedRelease?.title || "";
  const releaseArtistName =
    selectedRelease?.["artist-credit"]?.map((credit) => credit.name).filter(Boolean).join(", ") ||
    artistName;
  const artistItems = buildMusicArtistItems({
    artistName,
    relations: detail?.relations,
    country: detail.country || "",
    disambiguation: detail.disambiguation || "",
  });
  const albumItems = buildMusicAlbumItems({
    selectedRelease,
    releaseNodeTitle,
    releaseArtistName,
    topReleases,
    sourceKind,
    genres: selectedRelease?.tags?.map((tag) => tag.name).filter(Boolean) || [],
    primaryType: selectedRelease?.["primary-type"] || "",
    secondaryTypes: selectedRelease?.["secondary-types"] || [],
  });
  const genreItems = buildGenreEraItems(tagNames, artistName);
  const releaseItems = topReleases.slice(0, 8).map((release) => ({
    label: `${release.title} (${release["first-release-date"] || "n/a"})`,
    url: buildSpotifySearchUrl(`${artistName} ${release.title}`),
  }));
  const artistSignatureProfile = await buildArtistSignatureProfile({
    artistName,
    referenceWork: selectedRelease?.title || topReleases[0]?.title || "",
    artistSummary: wikiSummary || wikidataDesc || "",
  });
  const signatureItems = [
    { label: `Style: ${artistSignatureProfile.style}`, url: "" },
    { label: `Themes: ${artistSignatureProfile.themes}`, url: "" },
    { label: `Form: ${artistSignatureProfile.form}`, url: "" },
    { label: `Critical Reception: ${artistSignatureProfile.criticalReception}`, url: "" },
    { label: `Landmark Works: ${artistSignatureProfile.landmarkWorks}`, url: "" },
    { label: `Study Guide: ${artistSignatureProfile.studyGuide}`, url: "" },
  ];

  return {
    title: selectedRelease
      ? `${releaseNodeTitle || artistName}${releaseArtistName ? ` — ${releaseArtistName}` : ""}`
      : artistName,
    type: "music",
    desc:
      (selectedRelease
        ? `${releaseNodeTitle || artistName}은(는) ${releaseArtistName}의 작품이다. ${
            selectedRelease["first-release-date"]
              ? `${selectedRelease["first-release-date"]}에 최초 발매되었다.`
              : ""
          }`
        : "") ||
      wikiSummary ||
      wikidataDesc ||
      `${artistName}은(는) ${tagNames.slice(0, 3).join(", ") || "다양한 장르"}와 연결된다.`,
    path: [
      `${artistName} 대표작 확인`,
      `장르 ${tagNames.slice(0, 2).join(" / ") || "분석"} 공부`,
      "연결 씬/아티스트 비교",
    ],
    links: [
      ...tagNames.slice(0, 6),
      `Country: ${detail.country || "n/a"}`,
      "Source: MusicBrainz",
    ],
    connectedSections: [
      { title: "Artists", items: artistItems.slice(0, 12) },
      { title: "Artist Signatures", items: signatureItems },
      { title: "Album", items: albumItems.slice(0, 10) },
      { title: "Discography Highlights", items: releaseItems },
      { title: "Genres + Era", items: genreItems.slice(0, 12) },
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
    new URLSearchParams({
      inc: "tags+url-rels+artist-rels+label-rels+work-rels+recording-rels",
      fmt: "json",
    });
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

async function fetchMusicBrainzReleaseGroupsByArtist(artistId) {
  if (!artistId) {
    return [];
  }
  const url =
    "https://musicbrainz.org/ws/2/release-group/?" +
    new URLSearchParams({
      artist: artistId,
      fmt: "json",
      limit: "12",
    });
  const response = await fetch(url, {
    headers: { "User-Agent": "taste-atlas/0.1 (preferap)" },
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return Array.isArray(data?.["release-groups"]) ? data["release-groups"] : [];
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

function rankCandidatesByRelevance(items, query, extraScoreFn = () => 0) {
  const qn = normalizeText(query);
  const tokens = qn.split(/\s+/).filter(Boolean);
  return [...items]
    .map((item) => {
      const title = normalizeText(item.title);
      const subtitle = normalizeText(item.subtitle);
      let matchScore = 0;
      if (title === qn) {
        matchScore += 1000;
      }
      if (title.startsWith(qn)) {
        matchScore += 700;
      }
      if (title.includes(qn)) {
        matchScore += 400;
      }
      if (subtitle.includes(qn)) {
        matchScore += 160;
      }
      tokens.forEach((token) => {
        if (title.includes(token)) {
          matchScore += 90;
        }
        if (subtitle.includes(token)) {
          matchScore += 30;
        }
      });
      const extraScore = Number(extraScoreFn(item) || 0);
      return {
        ...item,
        _matchScore: matchScore,
        _extraScore: extraScore,
      };
    })
    .sort((a, b) => {
      if (b._matchScore !== a._matchScore) {
        return b._matchScore - a._matchScore;
      }
      return b._extraScore - a._extraScore;
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

function uniqByLabel(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${normalizeText(item?.label)}|${normalizeText(item?.url)}`;
    if (!item?.label || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildMusicArtistItems({ artistName, relations, country, disambiguation }) {
  const members = uniqByLabel(
    (Array.isArray(relations) ? relations : [])
      .filter((rel) => rel?.["target-type"] === "artist")
      .filter((rel) => normalizeText(rel?.type).includes("member"))
      .map((rel) => ({
        label: `Member: ${rel.artist?.name || ""}`,
        url: buildKnowledgeUrl(rel.artist?.name || ""),
      }))
  );
  return [
    { label: `Primary Artist: ${artistName}`, url: buildKnowledgeUrl(artistName) },
    { label: `Country: ${country || "n/a"}`, url: "" },
    ...(disambiguation ? [{ label: `Disambiguation: ${disambiguation}`, url: "" }] : []),
    ...members.slice(0, 10),
  ];
}

function buildMusicAlbumItems({
  selectedRelease,
  releaseNodeTitle,
  releaseArtistName,
  topReleases,
  sourceKind,
  genres,
  primaryType,
  secondaryTypes,
}) {
  if (selectedRelease) {
    return [
      {
        label: `Album: ${releaseNodeTitle || "n/a"}`,
        url: releaseNodeTitle ? buildSpotifySearchUrl(`${releaseArtistName} ${releaseNodeTitle}`) : "",
      },
      {
        label: `Artist: ${releaseArtistName || "n/a"}`,
        url: releaseArtistName ? buildKnowledgeUrl(releaseArtistName) : "",
      },
      {
        label: `First Release Date: ${selectedRelease["first-release-date"] || "n/a"}`,
        url: "",
      },
      {
        label: `Album Type: ${primaryType || "n/a"}${
          Array.isArray(secondaryTypes) && secondaryTypes.length
            ? ` / ${secondaryTypes.slice(0, 2).join(", ")}`
            : ""
        }`,
        url: "",
      },
      {
        label: `Genre Tags: ${
          Array.isArray(genres) && genres.length ? genres.slice(0, 3).join(", ") : "n/a"
        }`,
        url: "",
      },
      { label: `Source kind: ${sourceKind || "release"}`, url: "" },
      { label: "Data Source: MusicBrainz release-group + Cover Art Archive", url: "" },
    ];
  }
  const lead = topReleases[0];
  return [
    {
      label: `Album: ${lead?.title || "n/a"}`,
      url: lead?.title ? buildSpotifySearchUrl(lead.title) : "",
    },
    {
      label: `First Release Date: ${lead?.["first-release-date"] || "n/a"}`,
      url: "",
    },
    { label: `Source kind: ${sourceKind || "artist"}`, url: "" },
    { label: "Data Source: MusicBrainz release-group", url: "" },
  ];
}

function buildGenreEraItems(tagNames, artistName) {
  return (tagNames || []).map((tag) => {
    const meta = inferGenreEra(tag, artistName);
    return {
      label: `${tag} (${meta.era})\n${meta.analysis}`,
      url: buildKnowledgeUrl(tag),
    };
  });
}

function inferGenreEra(tagName, artistName) {
  const key = normalizeText(tagName);
  const table = {
    pop: {
      era: "1960s-present",
      analysis:
        `${artistName || "이 아티스트"}의 팝 문법은 멜로디 중심 구조를 유지하면서도 프로덕션 질감을 시대별로 갱신한다. 대중 친화적 후렴과 스타일 전환을 병치하는 방식이 핵심 특징이다.`,
    },
    rock: {
      era: "1970s-1990s peak",
      analysis:
        "록 기반 사운드는 기타/드럼의 에너지와 라이브 감각을 중심으로 정체성을 강화한다. 최근에는 전자 프로덕션과 결합해 하이브리드 록으로 확장되는 흐름이 강하다.",
    },
    hiphop: {
      era: "1990s-present",
      analysis:
        "힙합 계열은 리듬과 발화의 밀도를 통해 서사적 캐릭터를 구축한다. 비트 선택과 보컬 톤의 대비가 시대성을 드러내는 핵심 축으로 작동한다.",
    },
    "hip hop": {
      era: "1990s-present",
      analysis:
        "힙합 계열은 리듬과 발화의 밀도를 통해 서사적 캐릭터를 구축한다. 비트 선택과 보컬 톤의 대비가 시대성을 드러내는 핵심 축으로 작동한다.",
    },
    rnb: {
      era: "1990s-2000s peak",
      analysis:
        "R&B는 보컬 디테일과 그루브 중심 편곡을 통해 감정선의 미세한 변화를 전달한다. 현대 R&B에서는 전자음향과 미니멀 리듬을 결합한 질감이 특징적으로 나타난다.",
    },
    electronic: {
      era: "1990s-present",
      analysis:
        "전자음악 기반 장르는 사운드 디자인 자체를 서사의 중심에 두는 경향이 강하다. 클럽 미학과 실험성이 교차하며 트랙의 질감 변화가 핵심 청취 포인트가 된다.",
    },
    kpop: {
      era: "2010s-present",
      analysis:
        "K-pop 문법은 퍼포먼스 구조와 멀티장르 편곡을 결합해 곡 단위 임팩트를 극대화한다. 글로벌 유통 환경에 맞춘 훅 중심 구성과 시각적 콘셉트 연동이 중요한 특징이다.",
    },
    jazz: {
      era: "1940s-1960s peak",
      analysis:
        "재즈 계열은 화성과 리듬의 변주를 통해 즉흥적 긴장감을 조직한다. 현대 맥락에서는 팝/힙합과의 융합을 통해 청취 진입 장벽을 낮추는 경향이 나타난다.",
    },
  };
  if (table[key]) {
    return table[key];
  }
  return {
    era: "varies by region/era",
    analysis:
      `${artistName || "이 아티스트"}의 장르 표기는 지역 신(scene)과 시기에 따라 해석 폭이 달라진다. 대표작의 편곡/보컬/리듬 선택을 함께 보면 장르 맥락을 더 정확히 파악할 수 있다.`,
  };
}

function buildSpotifySearchUrl(query) {
  if (!query) {
    return "";
  }
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
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

function buildAcademicArtistSignature({ artistName, summary }) {
  const base = firstSentence(summary) || `${artistName}는 동시대 대중음악 담론에서 중요한 참조점으로 호출된다.`;
  return `${base} 이 아티스트의 미학은 장르의 경계를 고정하기보다 사운드 문법을 갱신하는 방식으로 작동한다. 평단은 작품 간 연속성과 단절의 배치를 통해 시대적 감수성을 조직한다는 점을 주목한다. 따라서 학습 과정에서는 대표작 단위가 아니라 시기별 앨범군의 변화를 구조적으로 읽는 접근이 적절하다.`;
}

async function buildArtistSignatureProfile({
  artistName,
  referenceWork,
  artistSummary,
}) {
  const fallback = buildFallbackArtistProfile({
    artistName,
    referenceWork,
    artistSummary,
  });

  if (!process.env.OPENAI_API_KEY || !artistName) {
    return fallback;
  }

  try {
    const prompt = [
      "당신은 음악연구 조교수다.",
      "아래 아티스트에 대해 학술 톤 50%, 쉬운 톤 50%의 한국어 요약을 작성하라.",
      "기존보다 짧게, 각 항목은 정확히 3문장으로 구성하라.",
      "항목: style, themes, form, criticalReception, landmarkWorks, studyGuide",
      "JSON만 반환하고 다른 텍스트는 쓰지 마라.",
      `아티스트: ${artistName}`,
      `대표 참고작: ${referenceWork || "n/a"}`,
      `참고 요약 자료: ${artistSummary || "n/a"}`,
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
      style: ensureSentenceCount(parsed.style, 3) || fallback.style,
      themes: ensureSentenceCount(parsed.themes, 3) || fallback.themes,
      form: ensureSentenceCount(parsed.form, 3) || fallback.form,
      criticalReception:
        ensureSentenceCount(parsed.criticalReception, 3) || fallback.criticalReception,
      landmarkWorks: ensureSentenceCount(parsed.landmarkWorks, 3) || fallback.landmarkWorks,
      studyGuide: ensureSentenceCount(parsed.studyGuide, 3) || fallback.studyGuide,
    };
  } catch (_error) {
    return fallback;
  }
}

function buildFallbackArtistProfile({ artistName, referenceWork, artistSummary }) {
  const artist = artistName || "이 아티스트";
  const work = referenceWork || "대표작";
  const summaryHead =
    firstSentence(artistSummary) || `${artist}는 장르 실험과 시대 감수성의 결합으로 평가된다.`;

  return {
    style: `${summaryHead} 핵심은 익숙한 장르 문법을 가져와 새로운 질감으로 다시 조합하는 데 있다. 어렵게 들릴 수 있지만, 실제 청취 포인트는 보컬 톤과 리듬 대비를 먼저 잡으면 이해가 빠르다.`,
    themes: `${artist}의 주제는 정체성, 관계, 시대 감정처럼 개인과 사회가 만나는 지점에 집중된다. 가사와 사운드가 같은 메시지를 다른 방식으로 반복해 듣는 사람이 맥락을 쉽게 따라가게 만든다. 그래서 작품을 들을 때 키워드가 트랙마다 어떻게 변주되는지 확인하면 좋다.`,
    form: `${artist}는 한 곡의 완결성보다 앨범 전체 흐름을 설계하는 방식을 자주 택한다. 곡 배치와 사운드 밀도 변화가 이야기의 긴장과 완급을 만든다. 즉 형식은 장식이 아니라 감정 전달 구조로 기능한다.`,
    criticalReception: `${artist}에 대한 평가는 대체로 장르 확장과 사운드 실험의 지속성에 높은 점수를 준다. 동시에 일부 평론은 난해함이나 대중 접근성의 한계를 지적한다. 종합하면, 영향력은 크지만 해석 난이도는 청자에 따라 갈린다는 평가가 많다.`,
    landmarkWorks: `${artist}의 대표작은 시기별 미학 변화를 가장 선명하게 보여주는 기준점이다. ${work}는 그 전환을 확인하기 좋은 입문용 사례로 자주 언급된다. 초기-중기-후기를 비교하면 같은 문제의식이 어떤 사운드로 달라지는지 빠르게 파악할 수 있다.`,
    studyGuide: `먼저 ${work}를 중심으로 트랙 순서와 사운드 층을 메모하며 들어보면 기본 문법을 잡기 쉽다. 다음으로 전후기 작품을 비교해 무엇이 유지되고 무엇이 바뀌는지 확인한다. 마지막으로 인터뷰나 평론을 함께 보면 청취 경험과 비평 언어를 연결하기 쉬워진다.`,
  };
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
      "아래 감독에 대해 학술 톤 50%, 쉬운 톤 50%의 한국어 요약을 작성하라.",
      "기존보다 짧게, 각 항목은 정확히 3문장으로 구성하라.",
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
      style: ensureSentenceCount(parsed.style, 3) || fallback.style,
      themes: ensureSentenceCount(parsed.themes, 3) || fallback.themes,
      form: ensureSentenceCount(parsed.form, 3) || fallback.form,
      criticalReception:
        ensureSentenceCount(parsed.criticalReception, 3) || fallback.criticalReception,
      landmarkWorks: ensureSentenceCount(parsed.landmarkWorks, 3) || fallback.landmarkWorks,
      studyGuide: ensureSentenceCount(parsed.studyGuide, 3) || fallback.studyGuide,
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
    style: `${directorHead} 연출의 핵심은 장면 리듬과 인물 배치를 통해 감정선을 단계적으로 쌓는 방식이다. 전문적으로 보면 미장센의 통제력이 강하고, 관객 입장에서는 장면 전환이 명확해 몰입이 쉽다.`,
    themes: `${movieHead} 반복되는 주제는 권력, 욕망, 불안처럼 사회와 개인이 충돌하는 지점에 모인다. 인물의 선택이 서사 긴장을 만들기 때문에 사건보다 관계 변화를 따라가며 보면 이해가 빨라진다. 이 점이 국내외 관객에게 폭넓게 통하는 이유로 자주 언급된다.`,
    form: `${director}는 설명을 줄이고 이미지와 소리로 의미를 쌓는 형식을 선호한다. 컷 전환과 침묵의 사용이 서사의 전환점을 자연스럽게 강조한다. 결과적으로 형식은 줄거리 전달을 넘어서 해석 방향을 안내하는 장치가 된다.`,
    criticalReception: `${director}에 대한 평가는 완성도와 장르 운용 능력에 높은 점수를 주는 편이다. 다만 일부 평론은 상징의 직접성이나 과잉 해석 가능성을 한계로 지적한다. 전반적으로는 대중성과 비평성을 동시에 확보했다는 합의가 강하다.`,
    landmarkWorks: `${director}의 대표작은 시기별 문제의식과 연출 전략의 변화를 보여주는 기준점이다. ${film}는 그중에서도 서사 구조와 사회적 해석이 잘 맞물린 사례로 자주 인용된다. 다른 작품과 함께 보면 같은 주제가 어떻게 변주되는지 선명해진다.`,
    studyGuide: `먼저 ${film}를 보며 인물 관계와 공간 이동을 간단히 도식화해 기본 구조를 잡는다. 다음으로 전후기 작품을 비교해 주제와 형식의 유지/변화를 체크한다. 마지막으로 평론과 인터뷰를 함께 읽으면 해석의 폭을 안정적으로 넓힐 수 있다.`,
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
    const items = rankAndFilterNewsItems(parseGoogleNewsRss(xml)).slice(0, 3);
    return items.map((item) => ({
      label: `Article: ${item.title}`,
      url: item.link,
    }));
  } catch (_error) {
    return [];
  }
}

async function fetchAwardArticlesForMusic({ artistName, awards }) {
  if (!artistName) {
    return [];
  }
  const keywords = awards?.length
    ? [...awards.slice(0, 2), "music award", "수상"]
    : ["Grammy", "Billboard Music Awards", "Brit Awards", "MAMA", "수상"];
  const queries = keywords.map((keyword) => `${artistName} ${keyword}`);
  const buckets = await Promise.all(
    queries.map(async (query) => {
      const rssUrl =
        "https://news.google.com/rss/search?" +
        new URLSearchParams({
          q: query,
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
        return parseGoogleNewsRss(xml);
      } catch {
        return [];
      }
    })
  );
  const ranked = rankAndFilterNewsItems(buckets.flat()).slice(0, 3);
  return ranked.map((item) => ({
    label: `Article: ${item.title}`,
    url: item.link,
  }));
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

function rankAndFilterNewsItems(items) {
  const seen = new Set();
  return items
    .map((item) => {
      const host = safeHostname(item.link);
      const title = normalizeText(item.title);
      let score = 0;
      if (/[가-힣]/.test(item.title)) {
        score += 80;
      }
      if (host.endsWith(".kr")) {
        score += 70;
      }
      if (host.includes("news.google")) {
        score -= 20;
      }
      if (title.includes("advertisement") || title.includes("sponsored")) {
        score -= 80;
      }
      return { ...item, _score: score, _host: host, _normTitle: title };
    })
    .filter((item) => {
      if (!item._normTitle) {
        return false;
      }
      const key = `${item._host}:${item._normTitle}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => b._score - a._score)
    .map(({ _score, _host, _normTitle, ...item }) => item);
}

function safeHostname(link) {
  try {
    return new URL(link).hostname || "";
  } catch {
    return "";
  }
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

async function fetchWikipediaSummary(title, options = {}) {
  if (!title) {
    return null;
  }
  const languages =
    Array.isArray(options.languages) && options.languages.length ? options.languages : ["en"];
  for (const language of languages) {
    const url = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      title
    )}`;
    const response = await fetch(url);
    if (!response.ok) {
      continue;
    }
    const data = await response.json();
    if (data.extract) {
      return data.extract;
    }
  }
  return null;
}

async function summarizeToKorean(text, topicLabel = "") {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }
  if (/[가-힣]/.test(source)) {
    return source;
  }
  if (!process.env.OPENAI_API_KEY) {
    return source;
  }
  try {
    const prompt = [
      "다음 텍스트를 한국어로 자연스럽게 번역/요약하라.",
      "2~3문장으로 간결하게 작성하라.",
      `주제: ${topicLabel || "n/a"}`,
      `원문: ${source}`,
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
      return source;
    }
    const data = await response.json();
    const out = extractResponseText(data).trim();
    return out || source;
  } catch {
    return source;
  }
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
