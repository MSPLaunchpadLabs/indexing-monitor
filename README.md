# indexing-monitor

A small Python tool that runs once a day, checks every URL in your
sitemap against Google's index, and auto-submits any URL that Google
hasn't indexed yet. It also resubmits your sitemap so Google gets a
fresh crawl hint, and saves everything to a CSV report so you can
track progress over time.

## What it does

1. Fetches your sitemap (supports sitemap index files and `.xml.gz`).
2. Compares today's URL list with the one saved in `indexing.db` and
   flags any brand-new URLs.
3. Calls the **Google Search Console URL Inspection API** for every
   URL and records whether it's indexed.
4. For any URL that's not indexed:
   - Submits it to the **Google Indexing API**.
   - Resubmits the whole sitemap via `sitemaps.submit`.
   - Won't resubmit the same URL more than once every 48 hours.
5. Writes a row per URL to the local SQLite DB (`indexing.db`):
   `url | is_new | indexed | last_checked | submitted | last_submitted |
   notes | first_seen | submit_attempts`.
6. Exports the whole table to `reports/YYYY-MM-DD.csv` and prints a
   summary to the terminal like:

   ```
   Total URLs: 120
   New today: 4
   Indexed: 108
   Not indexed: 12
   Submitted for indexing: 12
   ```

## Heads-up about the Indexing API

Google's official docs say the Indexing API is **only** for
`JobPosting` and `BroadcastEvent` pages. Using it for general URLs
works in practice — lots of SEO tools do it — but it's a grey area.
Google has said publicly that they may ignore or throttle submissions
that aren't for those two content types.

If that makes you uncomfortable, you can switch to the fully official
path by commenting out the `session.gsc.submit_url(url)` call in
`main.py` (step 4 of `run`). You'll still get the sitemap resubmit,
which is the official signal for general pages.

For everyone else: the tool prints this notice on every run so you
can't forget it exists.

## Setup — step by step

You'll do this once. After that it's just `python main.py run`.

### 1. Enable the two Google APIs

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Create a new project (or pick an existing one).
2. Go to **APIs & Services → Library**.
3. Search for and enable each of:
   - **Google Search Console API**
   - **Web Search Indexing API** (this is the one `google.com/update` uses)

### 2. Create a service account and download its JSON key

Still in the Cloud Console:

1. Go to **APIs & Services → Credentials**.
2. Click **Create credentials → Service account**.
3. Give it a name like `indexing-monitor` and click **Create and continue**.
   You don't need to grant it any project-level roles — skip that step.
4. Click **Done**.
5. On the service account list, click the new account's email.
6. Go to the **Keys** tab → **Add key → Create new key → JSON**.
7. A JSON file will download. Save it somewhere safe. **This is a
   credential — don't commit it to git.** (The project's `.gitignore`
   blocks common credential filenames but don't rely on it.)

Note the service account's **email address** (it looks like
`indexing-monitor@your-project.iam.gserviceaccount.com`). You'll need
it in the next step.

### 3. Add the service account as an Owner in Search Console

Both APIs we're calling need this. Full-user permission works for URL
inspection alone, but `sitemaps.submit` needs Owner — one setting
covers both.

1. Open [Google Search Console](https://search.google.com/search-console).
2. Select your property.
3. Click **Settings** (gear icon, bottom left) → **Users and permissions**.
4. Click **Add user**.
5. Paste the service account's email address.
6. Set permission to **Owner**.
7. Click **Add**.

### 4. Fill in `.env`

From the project directory:

```bash
cp .env.example .env
```

Then open `.env` and set:

- `SITEMAP_URL` — the public URL of your sitemap.
- `GSC_SITE_URL` — your Search Console property, in its canonical form.
  For a URL-prefix property it's `https://example.com/` (with trailing
  slash). For a domain property it's `sc-domain:example.com`.
- `GOOGLE_CREDENTIALS` — one of:
  - the absolute path to the JSON file you downloaded in step 2, or
  - the JSON itself pasted as a single string (useful for GitHub
    Actions secrets — see below).

The two `MAX_*` limits are already set to sensible defaults. You can
leave them alone.

### 5. Install dependencies and run

```bash
pip install -r requirements.txt
python main.py run
```

First run will create `indexing.db` in the current directory and
`reports/YYYY-MM-DD.csv` under `reports/`. Subsequent runs build on
the same DB.

## CLI reference

```
python main.py run          Full daily flow: inspect + submit + report.
python main.py status       Print the current status without API calls.
python main.py check <url>  Inspect one URL manually.
```

## Running on a schedule with GitHub Actions

The repo includes `.github/workflows/indexing-monitor.yml` which runs
`python main.py run` every day at 06:00 UTC. To enable it:

1. Create a new GitHub repo for this tool and push the **contents** of
   the `indexing-monitor/` folder to the repo root — not the folder
   itself. `main.py` should be at the repo root, and `.github/` needs
   to be at the repo root too or GitHub Actions won't find the workflow.
2. In the repo, go to **Settings → Secrets and variables → Actions**.
3. Add these three repository secrets:
   - `SITEMAP_URL` — same value as in your local `.env`.
   - `GSC_SITE_URL` — same value as in your local `.env`.
   - `GOOGLE_CREDENTIALS` — **paste the entire contents of the JSON
     key file** as the secret value. GitHub secrets handle multiline
     input; paste it as-is. The private key has newline characters —
     those must stay intact, so copy from the file, don't retype.
4. Go to the repo's **Actions** tab. If this is the first workflow,
   click the enable button.
5. Trigger a test run: click the `indexing-monitor` workflow →
   **Run workflow**. It should complete in a minute or two and upload
   `reports/*.csv` as an artifact you can download from the run page.

The workflow also caches `indexing.db` across runs so the 48-hour
cooldown and URL history survive between daily runs without needing
to commit the database.

## Troubleshooting

**`Missing required env vars`**
You haven't created `.env` yet, or one of the three required values
is blank. Copy `.env.example` to `.env` and fill in the values.

**`Google denied the request (HTTP 401/403)`**
Three likely causes, in order of likelihood:

- The service account isn't added as **Owner** in Search Console
  (step 3 above). Full-user permission isn't enough for
  `sitemaps.submit`.
- One of the two APIs isn't enabled in your GCP project (step 1).
- `GSC_SITE_URL` doesn't exactly match a verified property.
  URL-prefix needs the trailing slash; domain properties need the
  `sc-domain:` prefix.

**`Google returned HTTP 429`**
You've hit a daily API quota. That's normal on very large sites —
the tool stops and will pick up where it left off on the next run.
The per-day quotas are roughly 2,000 URL inspections per property
and 200 Indexing API submissions per project.

**`sitemap has unexpected root element`**
The URL you gave for `SITEMAP_URL` responded with something that
wasn't a `<urlset>` or `<sitemapindex>` — often an HTML error page
or a redirect to a login. Open the URL in a browser and confirm it
returns actual sitemap XML.

**`GOOGLE_CREDENTIALS ... isn't valid JSON`**
This usually happens when the JSON was pasted into a shell and
something escaped the newlines. Paste the file contents exactly
as-is, or use the file-path form instead.

## Project layout

```
indexing-monitor/
  main.py              # CLI entry point (Click)
  db.py                # SQLite storage layer
  sitemap.py           # fetch + parse sitemap (incl. gzip + index)
  gsc.py               # Google API wrapper (inspect + submit)
  report.py            # CSV export + rich terminal summary
  requirements.txt     # pinned Python deps
  .env.example         # env template (copy to .env)
  .gitignore
  reports/             # daily CSVs land here
  .github/workflows/   # daily 6am UTC scheduled run
```
