# Taste Atlas

Minimal portfolio prototype for building a personal taste knowledge map across music and movies.

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

## Keys

- Spotify: create app at Spotify Developer Dashboard
- TMDB: create API key at TMDB settings
- Wikidata/Wikipedia: no key needed in this prototype
