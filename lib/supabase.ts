import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client.
 *
 * Uses the service_role key (bypasses RLS) — this MUST NEVER be imported into
 * a client component or leaked into the browser bundle. The `import "server-only"`
 * line above makes Next.js fail the build if that ever happens.
 *
 * Cached per-process so Vercel warm invocations reuse the same HTTP keepalive.
 */
let cached: SupabaseClient<Database> | null = null;

export function supabase(): SupabaseClient<Database> {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SECRET must be set. Use the service_role key (server-side only).",
    );
  }

  cached = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-app": "indexing-monitor-web" } },
  });
  return cached;
}

// ----------------------------------------------------------------------------
// Table types — mirrors supabase/migrations/0001_schema.sql
// ----------------------------------------------------------------------------
export type IndexedValue = "yes" | "no" | "unknown" | null;
export type RunStatus = "running" | "done" | "failed";

export type ClientRow = {
  id: string;
  name: string;
  domain: string;
  sitemap_url: string;
  gsc_site_url: string;
  created_at: string;
};

export type UrlSource = "sitemap" | "manual";

export type UrlStatusRow = {
  client_id: string;
  url: string;
  is_new: boolean;
  indexed: IndexedValue;
  last_checked: string | null;
  submitted: boolean;
  last_submitted: string | null;
  notes: string | null;
  first_seen: string;
  submit_attempts: number;
  source: UrlSource;
};

export type RunRow = {
  id: string;
  client_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  total: number;
  current: number;
  pct: number | string;
  error: string | null;
  log_tail: string[];
  indexed_count: number;
  not_indexed_count: number;
  submitted_count: number;
};

export type RunUrlRow = {
  run_id: string;
  url: string;
  is_new: boolean;
  indexed: IndexedValue;
  last_checked: string | null;
  submitted: boolean;
  last_submitted: string | null;
  notes: string | null;
  first_seen: string | null;
  submit_attempts: number;
};

type TableDef<R, I = R, U = Partial<R>> = {
  Row: R;
  Insert: I;
  Update: U;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      clients: TableDef<ClientRow>;
      url_status: TableDef<
        UrlStatusRow,
        Partial<UrlStatusRow> & {
          client_id: string;
          url: string;
          first_seen: string;
        }
      >;
      runs: TableDef<RunRow, Partial<RunRow> & { client_id: string }>;
      run_urls: TableDef<RunUrlRow>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

// ----------------------------------------------------------------------------
// Shared payload shapes returned to the browser
// ----------------------------------------------------------------------------
export type RunStats = {
  total: number;
  indexed: number;
  not_indexed: number;
  submitted: number;
};

export type CurrentRun = {
  id: string;
  status: RunStatus;
  current: number;
  total: number;
  pct: number;
  started_at: string;
};

export type ClientListItem = ClientRow & {
  stats: RunStats | null;
  last_run_at: string | null;
  current_run: CurrentRun | null;
};

export type QuotaBreakdownRow = {
  client_id: string;
  count: number;
  last_submitted: string;
};

export type QuotaPayload = {
  used_today: number;
  per_client: QuotaBreakdownRow[];
};
