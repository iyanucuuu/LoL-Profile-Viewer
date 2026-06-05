# LoL Profile Viewer

A personal League of Legends profile tracker built with Angular and Node.js. Search any EUW summoner by Riot ID to view ranked stats, match history, champion performance, and improvement insights powered by your own match data.

![Angular](https://img.shields.io/badge/Angular-19-red?logo=angular) ![Node.js](https://img.shields.io/badge/Node.js-Express-green?logo=node.js) ![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ecf8e?logo=supabase)

## Features

- **Profile & Ranked** — summoner card, LP chart reconstructed from match history
- **Match History** — full season Solo/Duo matches streamed in real time, paginated
- **Champion Detail** — per-champion stats, CS/min, damage, KDA, build order from timelines, rune analysis, radar chart vs rank average
- **Insights** — winrate by hour/day/session position, weekly trend, tilt risk detection
- **Coach Tips** — auto-generated improvement tips compared to rank averages
- **Meta** — OP.GG skill order and counter matchups scraped server-side (1 h cache)

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Angular 19, TypeScript, pure CSS |
| Backend | Node.js, Express, Axios, Cheerio |
| Database | Supabase (PostgreSQL) — match & timeline cache |
| Data | Riot Games API v5, Data Dragon, CommunityDragon |

## Prerequisites

- Node.js 18+
- A [Riot Games API key](https://developer.riotgames.com/) (Development key is enough for personal use)
- A [Supabase](https://supabase.com/) project with the schema below

## Setup

### 1. Clone

```bash
git clone https://github.com/your-username/lol-profile-viewer.git
cd lol-profile-viewer
```

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env   # fill in your keys
node server.js
```

### 3. Frontend

```bash
cd frontend
npm install
npx ng serve --port 4200
```

Open [http://localhost:4200](http://localhost:4200).

> **Windows shortcut:** run `iniciar.bat` from the project root to launch both servers at once.

## Supabase schema

```sql
create table lol_matches (
  match_id      text not null,
  puuid         text not null,
  match_data    jsonb not null,
  game_creation bigint not null,
  primary key (match_id, puuid)
);

create table lol_timelines (
  match_id text not null,
  puuid    text not null,
  events   jsonb not null,
  primary key (match_id, puuid)
);
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `RIOT_API_KEY` | Riot Games API key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Supabase anon public key |
| `PORT` | Backend port (default: `3000`) |

## Project structure

```
├── backend/
│   ├── server.js          # Express API — Riot proxy, Supabase cache, OP.GG scraper
│   └── .env.example
└── frontend/
    └── src/app/
        ├── app.ts                  # Root component — search, season stream, coach
        ├── services/riot-api.ts    # HTTP client, DDragon helpers
        └── components/
            ├── profile-card/
            ├── ranked-stats/       # LP chart
            ├── match-history/
            ├── champion-mastery/
            └── champion-detail/    # Build order, runes, radar chart
```

## Notes

- Match data is cached in Supabase to avoid hitting Riot rate limits on every visit.
- The LP chart is an estimate — it reconstructs LP history backwards from your current LP using average win/loss values.
- OP.GG data is scraped server-side and cached for 1 hour per champion/position.

## License

MIT
