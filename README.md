## pnp_x — Realtime X mentions indexer (NestJS)

Fetches and indexes mentions of a target X/Twitter account in near real-time and saves them to JSON. Also supports a one-shot backfill of the last ~7 days via an API endpoint and an hourly cron snapshot.

### Features
- Realtime polling (~15s) for new mentions using Twitter v2 recent search.
- Console logging of new mentions as they arrive.
- Appends new mentions to JSON at `data/tweets.json`.
- Backfill endpoint to fetch last ~7 days and optionally save a full snapshot.
- Hourly cron snapshot (toggle via env).

### Requirements
- Node.js 18+
- Twitter API v2 Bearer Token

### Install

```bash
npm install
npm install twitter-api-v2 @nestjs/config @nestjs/schedule
```

### Configure environment
Create `.env` (see `.env.example`):

```
TWITTER_BEARER_TOKEN=YOUR_BEARER_TOKEN
TARGET_ACCOUNT=abc              # without @
OUTPUT_PATH=data/tweets.json    # where JSON will be written/appended
MENTIONS_CRON_ENABLED=true      # hourly snapshot
MENTIONS_POLL_ENABLED=true      # realtime polling every ~15s
```

### Run

```bash
# dev watch
npm run start:dev

# or normal
npm run start
```

On startup, the service primes the latest mention id and begins polling. New mentions are:
- Logged to the console
- Appended to `OUTPUT_PATH` (default `data/tweets.json`)

### Backfill (last ~7 days)

Trigger on demand via HTTP:

```bash
curl "http://localhost:3000/mentions?save=true"
```

- Returns a JSON payload with metadata and tweets.
- If `save=true`, writes a full snapshot to `OUTPUT_PATH`.

### Cron snapshot

- Enabled by `MENTIONS_CRON_ENABLED=true`.
- Runs hourly and writes a fresh snapshot for the last ~7 days to `OUTPUT_PATH`.

### API

- `GET /mentions?save=true|false`
  - Fetch last ~7 days and optionally save a snapshot.

### File structure highlights

- `src/mentions/mentions.service.ts` — realtime polling, cron, and search logic.
- `src/mentions/mentions.controller.ts` — backfill endpoint.
- `src/mentions/twitter.provider.ts` — provides configured Twitter client.
- `src/shared/file-storage.service.ts` — JSON save/append helpers.
- `src/app.module.ts` — wires `ConfigModule`, `ScheduleModule`, and `MentionsModule`.

### Troubleshooting

- No logs and no writes: ensure `.env` is set and `TWITTER_BEARER_TOKEN` is valid.
- Only realtime, no history: call `GET /mentions?save=true` to backfill last ~7 days.
- Disable realtime: set `MENTIONS_POLL_ENABLED=false`.
- Disable cron: set `MENTIONS_CRON_ENABLED=false`.

