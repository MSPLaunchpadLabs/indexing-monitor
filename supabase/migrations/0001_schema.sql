-- indexing-monitor — Supabase schema
-- Apply in the Supabase SQL Editor (Dashboard → SQL Editor → New query → paste → Run).
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------
create table if not exists public.clients (
    id           text primary key,
    name         text not null,
    domain       text not null,
    sitemap_url  text not null,
    gsc_site_url text not null,
    created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- url_status — one row per (client, url). Tracks current indexing state and
-- submission history. Composite PK so upserts are cheap.
-- ---------------------------------------------------------------------------
create table if not exists public.url_status (
    client_id       text not null references public.clients(id) on delete cascade,
    url             text not null,
    is_new          boolean not null default false,
    indexed         text,                              -- 'yes' | 'no' | 'unknown' | null
    last_checked    timestamptz,
    submitted       boolean not null default false,
    last_submitted  timestamptz,
    notes           text,
    first_seen      date not null,
    submit_attempts integer not null default 0,
    primary key (client_id, url)
);

create index if not exists idx_url_status_client_indexed
    on public.url_status (client_id, indexed);

-- ---------------------------------------------------------------------------
-- runs — one row per run. Doubles as the live-progress store: while running
-- the same row is UPDATEd on every URL. Dashboard polls the latest row for
-- the client to render the progress bar.
-- ---------------------------------------------------------------------------
create table if not exists public.runs (
    id                uuid primary key default gen_random_uuid(),
    client_id         text not null references public.clients(id) on delete cascade,
    status            text not null default 'running',  -- 'running' | 'done' | 'failed'
    started_at        timestamptz not null default now(),
    finished_at       timestamptz,
    total             integer not null default 0,       -- total URLs in sitemap
    current           integer not null default 0,       -- URLs inspected so far
    pct               numeric not null default 0,       -- 0..100
    error             text,
    log_tail          jsonb not null default '[]'::jsonb,

    -- Summary counts (populated when finished_at is set)
    indexed_count     integer not null default 0,
    not_indexed_count integer not null default 0,
    submitted_count   integer not null default 0
);

create index if not exists idx_runs_client_started
    on public.runs (client_id, started_at desc);

create index if not exists idx_runs_client_status
    on public.runs (client_id, status);

-- ---------------------------------------------------------------------------
-- run_urls — per-URL snapshot of a finished run. Equivalent to a CSV row.
-- Populated at end-of-run so History can show per-run detail + CSV download.
-- ---------------------------------------------------------------------------
create table if not exists public.run_urls (
    run_id          uuid not null references public.runs(id) on delete cascade,
    url             text not null,
    is_new          boolean not null default false,
    indexed         text,
    last_checked    timestamptz,
    submitted       boolean not null default false,
    last_submitted  timestamptz,
    notes           text,
    first_seen      date,
    submit_attempts integer not null default 0,
    primary key (run_id, url)
);

create index if not exists idx_run_urls_run on public.run_urls (run_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- This app always talks to Supabase via the service_role key from server-side
-- code (Vercel functions + GitHub Actions). service_role bypasses RLS so we
-- leave it disabled. Never expose the anon key to the browser for these tables.
-- ---------------------------------------------------------------------------
-- (No RLS policies; service_role bypasses them anyway.)
