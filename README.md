# SNSW Emergency Monitor

Emergency alert system for the **South NSW Conference** — monitors bushfires,
floods, severe storms and earthquakes across **southern NSW + the ACT**,
shows them on a live dashboard, and emails staff tiered alerts when something
serious happens.

> Adapted from the open-source [Crucix](https://github.com/calesthio/Crucix)
> OSINT dashboard by calesthio. Licensed **AGPL-3.0** — this fork stays public
> and keeps the same licence. All credentials live in `.env` (gitignored).

## Data sources

| Source | What it provides | Auth |
|---|---|---|
| **NSW RFS** major incidents feed | Fires + incidents with official alert level (Emergency Warning / Watch and Act / Advice) — the authority for alerting | none |
| **BOM** NSW/ACT warnings (IDZ00054) | Flood, severe thunderstorm, severe weather, fire weather warnings | none (browser UA) |
| **Geoscience Australia** | Earthquakes, last 7 days, region + 1° margin | none |
| **NASA FIRMS** | Satellite fire detections over the region (corroboration only — never alerts on its own) | free key |
| **GDELT** | Australian hazard news layer (dashboard context only) | none |

## Alert tiers

| Tier | Trigger | Email behaviour |
|---|---|---|
| 🔴 **FLASH** | RFS **Emergency Warning** (new or escalated), major flood, tsunami, M5+ quake | Sent immediately, never cooldown-blocked |
| 🟡 **PRIORITY** | **Watch and Act**, severe thunderstorm, moderate flood, M4+ quake | 15 min cooldown, 4/hr |
| 🔵 **ROUTINE** | New Advice incident, minor flood, fire weather, M3+ quake | 60 min cooldown, 2/hr |

Escalations (e.g. an incident moving Advice → Watch and Act → Emergency
Warning) are the highest-priority trigger and are detected per incident.
Repeat signals are suppressed with decaying cooldowns (0/6/12/24 h) so nobody
gets spammed about the same fire every sweep.

## Quick start

```bash
npm install
cp .env.example .env    # fill in FIRMS key + SMTP settings
npm start               # dashboard at http://localhost:3117
```

Requires Node 22+. The system sweeps every `REFRESH_INTERVAL_MINUTES`
(default 5) and pushes live updates to the dashboard over SSE.

### Test the email chain (no emergency required)

```bash
npm run test:alert            # sends FLASH + PRIORITY + ROUTINE test emails
npm run test:alert -- flash   # a single tier
```

### Running a drill

Rehearse the full sweep → detection → email chain with a fixture:

1. Serve two fixture files (baseline and escalated) locally, e.g.
   `python3 -m http.server 8899` in a folder with `rfs-drill.json`.
2. Start the server with `RFS_FEED_URL=http://localhost:8899/rfs-drill.json`.
3. After the first sweep, replace the fixture with the escalated version and
   trigger a manual sweep: `curl -X POST localhost:3117/api/sweep`.
4. The Emergency Warning escalation should arrive as a `[FLASH]` email.
   A third sweep with the same fixture must NOT re-alert (dedup).

### Useful commands

```bash
npm run sweep       # one-off sweep, prints raw JSON
npm run diag        # environment/module preflight
npm run clean       # reset sweep memory (runs/)
curl -X POST localhost:3117/api/sweep   # manual sweep (localhost only)
curl localhost:3117/api/health
```

## Configuration

- **Region bbox** — `crucix.config.mjs` `region` (env `REGION_*`). Default:
  west 141.0, south -37.6, east 151.7, north -34.0 (Vic border → just south
  of Sydney, SA border → coast, includes ACT).
- **Alert sensitivity** — `crucix.config.mjs` `delta.thresholds.count`.
- **BOM district filter** — `BOM_DISTRICT_FILTER=on` once tuned (off by
  default; statewide warnings are kept rather than risk missing a flood).

## Operations notes

- **FIRMS** flags hazard-reduction burns too; it corroborates but never
  escalates a tier by itself. RFS is the authority.
- **BOM** requires a browser-like User-Agent (handled) and its product IDs
  can change; if the feed 404s, check http://www.bom.gov.au/rss/ for the
  current NSW warnings product.
- **No auth on the dashboard** — run it on a trusted network, or put a
  reverse proxy with auth in front before exposing it anywhere.
- **Docker**: `docker compose up` works as-is (memory persists in `./runs`);
  note the Dockerfile healthcheck hardcodes port 3117.
- In a real emergency **call 000** and follow official RFS/SES/BOM
  instructions — this monitor is an awareness tool, not an official channel.

## Fork provenance

Upstream Crucix source modules (markets, sanctions, aviation, etc.) are kept
on disk but deregistered in `apis/briefing.mjs`, keeping future upstream
merges clean. The Telegram/Discord alerters remain functional but dormant —
configure their env vars to enable them alongside email.
