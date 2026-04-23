# Indexing Monitor — Deployment Guide

Three-tier architecture:

1. **Vercel** hosts the static dashboard (`dashboard/`) and the thin read APIs (`api/*.py`).
2. **GitHub Actions** runs the actual 5–20 minute indexing engine (`engine/runner.py`) via `workflow_dispatch`.
3. **Supabase** (Postgres) holds clients, URL status, runs, and run snapshots.

Do the steps below **in order** — each step assumes the previous one is done.

---

## 1. Supabase — create tables

1. Open the Supabase project → **SQL Editor** → **New query**.
2. Paste the contents of `supabase/migrations/0001_schema.sql` and **Run**.
3. Verify:
   ```sql
   select table_name from information_schema.tables
   where table_schema = 'public'
   order by table_name;
   -- expect: clients, run_urls, runs, url_status
   ```

Grab these values from **Project Settings → API** — you'll paste them into Vercel + GitHub:

| Name              | Where it shows up              |
| ----------------- | ------------------------------ |
| `SUPABASE_URL`    | Project URL                    |
| `SUPABASE_SECRET` | `service_role` key (NOT `anon`) |

> The service_role key bypasses RLS. Never commit it, never ship it to the browser.

---

## 2. Migrate existing SQLite data to Supabase

One-shot copy of the four existing clients + their `url_status` tables.

```bash
cd indexing-monitor

# set creds for this shell only
export SUPABASE_URL="https://dtfljepvwblmgfcjvkkz.supabase.co"
export SUPABASE_SECRET="<service_role key>"

python -m scripts.migrate_sqlite_to_supabase
```

Expected output:
```
Migrating 4 client(s) from clients.json ...
  clients: upserted 4

Migrating url_status tables ...
  msplaunchpad: upserted N url_status rows
  techlocity:   upserted N url_status rows
  rtc:          upserted N url_status rows
  ajtc:         upserted N url_status rows
```

Verify in the Supabase SQL editor:
```sql
select count(*) from clients;
select client_id, count(*) from url_status group by client_id;
```

The script is idempotent — safe to re-run.

---

## 3. GitHub — push repo + configure Actions

### 3a. Push the repo

```bash
cd indexing-monitor
git init
git add .
git commit -m "Initial commit: Vercel + GHA + Supabase port"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

`<owner>` and `<repo>` are whatever you choose — remember them, Vercel needs them in step 5.

### 3b. Add repo secrets (**Settings → Secrets and variables → Actions → New repository secret**)

| Secret name         | Value                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`      | same as above                                                                                |
| `SUPABASE_SECRET`   | same as above                                                                                |
| `GOOGLE_CREDENTIALS`| the **full JSON contents** of `service-account.json` (paste the file body, not a file path) |

### 3c. (Optional) Repo variables — only if you want to override runner limits

| Variable name                  | Default | Meaning                                    |
| ------------------------------ | ------- | ------------------------------------------ |
| `MAX_SUBMISSIONS_PER_RUN`      | `180`   | Indexing API daily submission cap          |
| `MAX_SUBMIT_ATTEMPTS_PER_URL`  | `5`     | Give up on a URL after this many attempts  |

### 3d. Create a Personal Access Token so Vercel can dispatch the workflow

**Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic)**

- **Name:** `indexing-monitor dispatcher`
- **Expiration:** 1 year (renewal reminder goes on your calendar)
- **Scopes:**
  - `repo` → `public_repo` (or full `repo` if the indexing-monitor repo is private)
  - `workflow`

Copy the token (starts with `ghp_…`). You won't see it again. This becomes Vercel's `GITHUB_DISPATCH_TOKEN`.

### 3e. Smoke-test the workflow (optional but recommended)

**Actions → indexing-monitor → Run workflow** — fill in a real `client_id` (e.g. `msplaunchpad`) and a UUID you make up for `run_id` (just for the smoke test). Confirm the job starts and streams logs.

---

## 4. Deploy to Vercel

```bash
cd indexing-monitor

# one-time login if you haven't
vercel login

# first-time project link
vercel link

# then for every deploy:
vercel --prod
```

If you want it fully non-interactive (CI or scripted):
```bash
vercel --prod --yes --token=$VERCEL_ACCESS_TOKEN
```

Vercel reads `vercel.json`:
- static files served from `dashboard/`
- `api/**/*.py` become Python serverless functions (max 30s each — fine, they only read Supabase and dispatch)
- `/api/run-status` and `/api/run-csv` rewrites allow hyphens in the public URL while the Python file is underscored

---

## 5. Vercel — environment variables

**Dashboard → <project> → Settings → Environment Variables** — add each for **Production, Preview, Development**:

| Name                    | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `SUPABASE_URL`          | same as step 1                                                 |
| `SUPABASE_SECRET`       | same as step 1 (service_role)                                  |
| `GITHUB_REPO_OWNER`     | owner you pushed to in step 3a                                 |
| `GITHUB_REPO_NAME`      | repo name you pushed to in step 3a                             |
| `GITHUB_DISPATCH_TOKEN` | PAT from step 3d                                               |
| `GITHUB_WORKFLOW`       | `indexing-monitor.yml` (default — only set if you rename the file) |
| `GITHUB_REF`            | `main` (default — only set if you dispatch from another branch) |

After adding env vars, redeploy so the functions pick them up:
```bash
vercel --prod
```

---

## 6. End-to-end smoke test

1. Open the production URL — the **All clients** page should list the four migrated clients with their current indexed/not-indexed counts.
2. Click a client → **Run** tab → **Start a new check**.
3. Watch the live progress bar; the page polls `/api/run-status` every 2 s. In a second tab, go to **Actions** on GitHub and confirm a workflow run was dispatched with the same `run_id`.
4. When the run finishes, open **History** and download the CSV for the run you just completed.

If any step fails, check:
- **Vercel function logs** (Dashboard → Deployments → latest → Functions) for API errors.
- **GitHub Actions run logs** for engine errors.
- **Supabase SQL editor**: `select * from runs order by started_at desc limit 5;`

---

## 7. Adding a new client

Either:
- **UI path:** Add client → fill the form. Before clicking Save, make sure the service-account bot is an Owner on that Search Console property (the alert on the form names the exact email).
- **SQL path (bulk):** insert straight into `public.clients` via the Supabase SQL editor.

New clients have no `url_status` rows until you trigger the first run.

---

## 8. Rotating keys

When any of `SUPABASE_SECRET`, `GOOGLE_CREDENTIALS`, or the GitHub PAT changes, update it in **both** places it lives (GitHub Actions secrets **and** Vercel env vars) — they're independent copies.

The old `.env` file at the repo root contained live secrets and should be treated as leaked: rotate `SUPABASE_SECRET` and `VERCEL_ACCESS_TOKEN` before going live if it was ever committed.

---

## 9. Local development

The old `app.py` (Streamlit) still works against SQLite for offline tinkering:

```bash
pip install -r requirements.txt
streamlit run app.py
```

It is **not** wired to Supabase — it's kept purely as a local fallback. The production path is always Vercel + GHA + Supabase.
