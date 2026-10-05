# Key Topics Reporting

Programme status reporting (topics + RAG updates). Pure Node.js — zero npm dependencies.

## Run

```bash
node server.js
```

Or:

```bash
npm start
```

Listens on `0.0.0.0` and `process.env.PORT || 3080` (Azure Web App compatible).

Open http://localhost:3080

## Data

CSV files under `data/`:

| File | Columns |
|------|---------|
| `topics.csv` | id, name, cadence, owner, active, sort_order, created_at, updated_at |
| `comments.csv` | id, topic_id, week_ending, kind, author, body, resolved, created_at, updated_at |
| `reports.csv` | id, topic_id, period_start, period_end, exec_summary, achievements, next_steps, rag, trend, gtg_plan, created_at, updated_at |

`categories.csv` (id, name, sort_order) holds the topic categories. Manage them on the **Settings** page (add, rename, reorder, delete); it is seeded with Project / POC / AI use case on first run. Renaming updates every topic that uses the category; deleting offers to move its topics to another category or to Uncategorised. API: `GET/POST /api/categories`, `PATCH/DELETE /api/categories/:id` (`?reassign=<name>`), `POST /api/categories/order` (`{ids}`).

Weekly report downloads (no dependencies, built in `export.js`): `GET /api/weekly.pdf?ending=YYYY-MM-DD` and `GET /api/weekly.pptx?ending=YYYY-MM-DD`; the Weekly pack page has **Download PDF** / **Download PPT** buttons.

Narrative fields store HTML. Values are RFC 4180 quoted (including multiline).

Cadence: `weekly` \| `fortnightly` \| `monthly`  
RAG: `Red` \| `Amber` \| `Green`  
Trend: `Improving` \| `Stable` \| `Declining`  

GTG plan is required when RAG is not Green.

## API

- `GET /api/health`
- `GET /api/dashboard?category=` — overview chart data, optionally scoped to one category (`none` = uncategorised)
- `GET /api/topics` — topics with `latest_report`
- `POST /api/topics` — `{name,cadence,owner}`
- `PATCH /api/topics/:id`
- `GET /api/topics/:id/reports`
- `GET /api/topics/:id/latest`
- `POST /api/topics/:id/reports`

- `GET /api/weekly?ending=YYYY-MM-DD` — weekly bundle (items include `comments`)
- `POST /api/topics/:id/comments` — `{week_ending,body}; author comes from the signed-in user (Azure App Service auth headers)` reviewer comment (`kind` defaults to `comment`)
- `PATCH /api/comments/:id` — `{resolved}`; `DELETE /api/comments/:id`

Static UI from `public/`.

## Export

Printing is disabled. The weekly report has **Download PNG** (whole report, or per topic) — rendered client-side with no dependencies.

## Azure Web App

Set startup command to `node server.js`. Bind to `PORT` (provided by the platform). Persist or mount `data/` if you need durable storage across restarts.
