# Taste Atlas

Minimal portfolio prototype for building a personal taste knowledge map across music and movies.
Music source is now `MusicBrainz + Wikidata + Wikipedia` (no Spotify required).

## Current Stage

- Stage 1 done: base map UI + node archive view
- Stage 2 done: live lookup API for music/movie
- Stage 3 done: expand selected node into connected concept nodes
- Stage 4 done: dedicated `Home / Map / Archive / Pathways` pages
- Next stage: refine graph layout and improve pathway ranking logic

## Run

```bash
npm install
cp .env.example .env
# fill .env keys
npm run dev
```

Open `http://localhost:5500`.

## API

- `GET /api/health`: source key status
- `GET /api/lookup?type=music&q=radiohead`
- `GET /api/lookup?type=movie&q=pulp%20fiction`
- `GET /api/expand?type=music&q=radiohead`
- `GET /api/expand?type=movie&q=pulp%20fiction`

## Keys

- TMDB: create API key at TMDB settings
- MusicBrainz/Wikidata/Wikipedia: no key needed in this prototype
