# Indexing Monitor — Context

Internal SEO tool that tracks per-client Google indexing status and submits not-indexed URLs through Google's Indexing API. Runs in production at https://indexing-monitor.vercel.app.

## What it does

For each client (a Search Console property + sitemap):

1. Pulls every URL from the sitemap (supports sitemap-index files and `.xml.gz`).
2. Calls the Search Console **URL Inspection API** to record `indexed` = `yes` / `no` / `unknown`.
3. For URLs that come back `no`, calls the **Indexing API** (`urlNotifications:publish` with `type=URL_UPDATED`) up to a per-day quota.
4. Persists everything to Supabase. Dashboard shows live progress, per-client stats, run history, coverage breakdown, and a manual submit-by-paste flow.

## Stack

- **Next.js 16 App Router** dashboard (TypeScript, React 19, Tailwind v4) — deployed on Vercel.
- **Python engine** (`engine/runner.py`) — does the heavy work (sitemap fetch, GSC inspection loop, Indexing API submissions). Runs on **GitHub Actions**, dispatched per-client by the Vercel API on demand. Lives outside the request/response cycle so a 20-min run doesn't fight Vercel's function timeout.
- **Supabase Postgres** — single source of truth. Both Vercel and the GHA runner connect with the `service_role` key (RLS bypassed; never expose the anon key for these tables).
- **Streamlit dashboard** (`app.py`, `dashboard/`) — legacy, still runs in parallel; the Next.js app is the primary surface now.

## Repo layout

```
app/                       Next.js routes (App Router)
  api/clients/[id]/...     run, history, monthly, urls, urls-by-reason, activity, run-status
  api/runs/[runId]/csv     CSV export
  api/submit               manual paste-and-submit flow (route + dispatch actions)
  clients/                 list + detail + new
  submit/                  paste URLs page
  settings/                config UI
components/                React components (client-card, client-detail-view, …)
lib/
  supabase.ts              server-only Supabase client + Row types + Database<>
  google-indexing.ts       JWT signing + Indexing API call (Node runtime)
  github-dispatch.ts       fires workflow_dispatch for engine runs
  route-urls.ts            domain-matching helper for the manual submit UI
  local-runner.ts          dev-time runner (skips GHA, runs engine inline)
  format.ts, slug.ts       small utilities
engine/
  runner.py                main loop: sitemap → GSC inspect → Indexing submit → Supabase upsert
  supabase_db.py           Python Supabase client
.github/workflows/
  indexing-monitor.yml     workflow_dispatch entrypoint, calls engine.runner
supabase/migrations/
  0001_schema.sql          source of truth for the schema
```

Python files at the repo root (`app.py`, `gsc.py`, `sitemap.py`, `main.py`, `manual_submit.py`, `report.py`) belong to the legacy Streamlit app.

## Database (4 tables)

All defined in `supabase/migrations/0001_schema.sql`. TypeScript mirrors live in `lib/supabase.ts`.

- **`clients`** — id (text PK, slug), name, domain, sitemap_url, gsc_site_url. `id` is referenced by `url_status` and `runs` with `ON DELETE CASCADE` — so deleting a client wipes all its history in one statement.
- **`url_status`** — composite PK `(client_id, url)`. Current state per URL: `indexed`, `last_checked`, `submitted`, `last_submitted`, `notes`, `submit_attempts`, `source` (`sitemap` | `manual`). Upserted on every run and on every manual submit.
- **`runs`** — one row per run. Doubles as the live-progress store: while `status='running'` the same row is UPDATEd on each URL (`current`, `pct`, `log_tail`). Dashboard polls the latest row to render the progress bar. End-of-run summary counts (`indexed_count`, `not_indexed_count`, `submitted_count`) are populated when `finished_at` is set.
- **`run_urls`** — per-URL snapshot at run completion (CSV-row equivalent). Powers History view + CSV download.

## Request flow: "Run Now"

1. User clicks Run Now in the dashboard.
2. `POST /api/clients/[id]/run` — Vercel function inserts a `runs` row (status=`running`), then calls `dispatchIndexingRun()` which fires GitHub `workflow_dispatch` with `{client_id, run_id}` as inputs. Returns 200 immediately. Returns 409 if a run is already in flight for that client.
3. GHA workflow `indexing-monitor.yml` checks out the repo, installs Python deps, runs `python -m engine.runner <client_id> <run_id>`.
4. The engine UPDATEs the same `runs` row as it works through the sitemap — `current`, `pct`, `log_tail` tick forward; on each URL it upserts `url_status`.
5. Dashboard polls `/api/clients/[id]/run-status` (and the activity log) to redraw the progress bar live.
6. On completion the engine sets `status='done'`, fills summary counts, and writes a `run_urls` snapshot.

## Request flow: manual paste-and-submit

1. User pastes a list of URLs on `/submit`.
2. `POST /api/submit` with `action: "route"` — pure string match, no Google calls; returns which client each URL maps to (via `lib/route-urls.ts`).
3. UI groups by client, user clicks Submit.
4. `POST /api/submit` with `action: "dispatch"` — for each URL: `submitUrlForIndexing(url)` → upsert `url_status` with `source: "manual"`, recording outcome.

This path runs entirely in a Vercel function and does NOT go through GitHub Actions.

## Auth into Google

`lib/google-indexing.ts` does service-account → JWT bearer → access token → Indexing API publish. Module-scoped caches: `cachedSa` (parsed service account) and `cachedToken` (access token, 1h TTL with 60s skew).

The credential is read from `GOOGLE_CREDENTIALS` at runtime. Two formats accepted: a filesystem path, or the raw JSON (must start with `{`). On Vercel paste the JSON directly. The loader normalizes literal `\n` two-char sequences in `private_key` back to real newlines — without that, `createPrivateKey` accepts the mangled PEM but produces signatures Google rejects with `invalid_grant: Invalid JWT Signature`.

**Gotcha:** when storing `GOOGLE_CREDENTIALS` on Vercel, use `encrypted` type, not `sensitive`. Sensitive vars are opaque to the Vercel API (you can't decrypt them back to verify), and any corruption during write is invisible. After updating the var you must trigger a redeploy — running deployments don't pick up env changes.

## Environment variables

App reads (`.env.example` is canonical):

| Var | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SECRET` | Vercel + GHA secrets | service_role connection |
| `GOOGLE_CREDENTIALS` | Vercel + GHA secrets | service-account JSON (raw) |
| `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `GITHUB_DISPATCH_TOKEN` | Vercel only | fires workflow_dispatch |
| `GITHUB_WORKFLOW` (default `indexing-monitor.yml`), `GITHUB_REF` (default `main`) | Vercel optional | which workflow + branch |
| `MAX_SUBMISSIONS_PER_RUN` (default 180), `MAX_SUBMIT_ATTEMPTS_PER_URL` (default 5) | GHA vars | safety limits — Indexing API quota is 200/day/project |

Service-account email currently in use: `indexing-monitor-bot@indexing-monitor-494117.iam.gserviceaccount.com`. Must be added as **Owner** in each client's Search Console property (Users & permissions). The "Add new client" page surfaces this as a copy-chip.

## Per-client onboarding

1. Search Console property must already exist and be verified.
2. Add the bot service-account email as **Owner** on that property.
3. Use `/clients/new` to add the client — pick a slug (becomes `clients.id`), paste sitemap URL and GSC property URL.
4. Click Run Now on the card.

## Dev

```
npm install
npm run dev          # Next dashboard on :3000
npm run typecheck    # tsc --noEmit
npm run build        # production build
```

Python engine for local debugging:

```
pip install -r engine/requirements.txt
python -m engine.runner <client_id> <run_id>
```

`lib/local-runner.ts` lets the Run Now button shell out to the Python engine inline instead of hitting GitHub Actions — useful in dev when you don't want GHA in the loop.

## Deployment

Production: Vercel project `prj_i6DZjtN9qklcQ3fdlorr2cEDH6kz` in team `team_N9vL7OHq7kxbxNmKkC9LQOx2`, alias `indexing-monitor.vercel.app`. Engine runs on the `main` branch of this repo.

Schema changes: paste new migration into Supabase SQL Editor; everything is `if not exists` so re-running is safe.

## Known sharp edges

- **Sensitive env vars on Vercel are opaque.** If credentials misbehave in prod, recreate as `encrypted`, verify by decrypting back, then redeploy.
- **Module-scope caches in `google-indexing.ts`.** Across redeploys this is fine (new lambda = empty cache); within a single warm instance, a rotated credential won't be picked up until the instance recycles. Redeploy after rotating.
- **Concurrency.** GHA workflow uses `concurrency.group: indexing-monitor-${client_id}` with `cancel-in-progress: false` — same client can't run twice at once, different clients run in parallel.
- **Indexing API quota.** 200 req/day per Google Cloud project. `MAX_SUBMISSIONS_PER_RUN=180` leaves headroom; the manual `/submit` flow shares the same quota.
- **`run_state.py`, `db.py`, `indexing.db`** are legacy Streamlit/SQLite artifacts from before the Supabase migration. The current data path is Supabase only.
