# Indexing Monitor — Next.js on Vercel

This replaces the old `api/*.py` + `dashboard/` Vercel attempt with a proper
Next.js 16 + TypeScript app. Three parts of the system still live where they
always lived:

| Part | Location | Notes |
| --- | --- | --- |
| Front-end + read/write API | **Vercel (this app)** | Next.js 16 App Router |
| Long-running engine | **GitHub Actions** (`engine/runner.py`) | unchanged |
| Storage | **Supabase** | unchanged; schema in `supabase/migrations/0001_schema.sql` |

The Streamlit app on Streamlit Cloud keeps running untouched — it reads the
same Supabase tables, so the two UIs stay in sync while you validate the
Vercel rebuild.

---

## 1. Local dev

```bash
cd indexing-monitor
cp .env.local.example .env.local
# fill in SUPABASE_URL, SUPABASE_SECRET, GITHUB_* values

npm install
npm run dev
# open http://localhost:3000
```

On first run the server hits your real Supabase project, so you'll see the
existing four clients (msplaunchpad, techlocity, rtc, ajtc) the moment the
page loads.

> The GitHub dispatch call will fail locally without a valid
> `GITHUB_DISPATCH_TOKEN`. That's fine for UI iteration — just don't click
> "Start a new check" until the token is wired up.

---

## 2. Vercel deploy

The project is already linked (`.vercel/project.json` exists). From this
folder:

```bash
vercel --prod
```

The new `vercel.json` tells Vercel this is a Next.js project; the build
command is `next build`. Function max duration is 30s — every Route Handler
finishes in well under that (the heavy work runs in GitHub Actions).

### First deploy checklist

1. Set these environment variables in **Vercel → Project → Settings → Environment Variables** for **Production, Preview, Development**:
   - `SUPABASE_URL`
   - `SUPABASE_SECRET` (service_role key)
   - `GITHUB_REPO_OWNER`
   - `GITHUB_REPO_NAME`
   - `GITHUB_DISPATCH_TOKEN`
   - (optional) `GITHUB_WORKFLOW`, `GITHUB_REF`
2. Re-run `vercel --prod` so the functions pick up the new vars.
3. Smoke-test:
   - Open the production URL → **All clients** shows your four properties.
   - Click a client → **Run** tab → **Start a new check**.
   - Watch the log tail update every 2s. In another tab, verify the GHA
     workflow was dispatched with the same `run_id`.
   - When it finishes, open **History** and download the CSV.

---

## 3. What's different vs the old Python-on-Vercel attempt

| | Old | New |
| --- | --- | --- |
| Front-end | Vanilla JS + static HTML | Next.js + React Server Components |
| API | 6 `api/*.py` files (Vercel Python) | 6 Route Handlers in `app/api/**/route.ts` |
| Cold start | ~500ms (Python runtime) | ~50ms (Node runtime) |
| Types | None | End-to-end TypeScript + Supabase row types |
| Styling | Hand-rolled CSS at `dashboard/styles.css` | Tailwind 4 + CSS variables, same brand tokens |
| Theme | Manual JS toggle | Same UX, SSR-safe (no flash) |
| CSV export | Python `csv` module | Native streaming Response |

The old `api/*.py` and `dashboard/` folders are still on disk for reference
but are now excluded from the Vercel build via `.vercelignore`. Delete them
only after you've confirmed the Next.js version is happy in production.

---

## 4. Rollback

If the Next.js deploy ever misbehaves, Streamlit Cloud is your live fallback —
it's reading the same Supabase project, so the data is identical.

To roll the Vercel deploy back specifically:
```bash
vercel rollback            # interactive — picks a prior deployment
```

Supabase, the GitHub Actions workflow, and the Python engine are all
unaffected by Vercel deploys, so no data is ever at risk from a rollback.
