# Taste Atlas

Minimal portfolio prototype for building a personal taste knowledge map across music and movies.
Music source is now `MusicBrainz + Wikidata + Wikipedia` (no Spotify required).

## Current Stage

- Stage 1 done: search-first workflow (`Search` page) without map exposure
- Stage 2 done: separate `Nodes` menu for node-map review
- Stage 3 done: candidate selection flow for duplicate names
- Stage 4 done: split search results into `콘텐츠 / 사람`
- Next stage: music result detail tuning
- Stage 5 in progress: deeper music sections (profile groups, signature summary, awards articles)
- Next stage: optional 3D node map and final polish

## Run

```bash
npm install
cp .env.example .env
# fill .env keys
npm run dev
```

Open `http://localhost:5500`.

Pages:

- `/map.html`: Search
- `/nodes.html`: Node map (2D placeholder, future 3D target)
- `/archive.html`: Saved node archive
- `/pathways.html`: Generated pathways

## API

- `GET /api/health`: source key status
- `GET /api/search?type=movie&q=parasite`
- `GET /api/search?type=music&q=radiohead`
- `GET /api/lookup?type=music&q=radiohead`
- `GET /api/lookup?type=movie&q=pulp%20fiction`
- `GET /api/expand?type=music&q=radiohead`
- `GET /api/expand?type=movie&q=pulp%20fiction`

Movie lookup supports both title and director-name queries (Korean/English).

## Keys

- TMDB: create API key at TMDB settings
- OpenAI: set `OPENAI_API_KEY` to enable GPT-based Director Signatures (academic tone, long form)
- MusicBrainz/Wikidata/Wikipedia: no key needed in this prototype
