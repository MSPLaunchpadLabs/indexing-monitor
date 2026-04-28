import { NextResponse } from "next/server";
import {
  supabase,
  type ClientListItem,
  type ClientRow,
  type CurrentRun,
  type QuotaBreakdownRow,
  type QuotaPayload,
  type RunRow,
  type RunStats,
} from "@/lib/supabase";
import { domainOf, normalizeWebsite, slugify } from "@/lib/slug";

// This route touches the database — never prerender.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/clients — list clients with aggregated stats for the dashboard. */
export async function GET() {
  const sb = supabase();

  const { data: clientRows, error: clientsError } = await sb
    .from("clients")
    .select("*")
    .order("name", { ascending: true });

  if (clientsError) {
    return jsonError(502, `supabase: ${clientsError.message}`);
  }

  const clients: ClientRow[] = clientRows ?? [];
  if (clients.length === 0) {
    return NextResponse.json({
      clients: [],
      dashboard: {
        total_clients: 0,
        urls_tracked: 0,
        indexed: 0,
        active_runs: 0,
      },
      quota: { used_today: 0, per_client: [] } satisfies QuotaPayload,
    });
  }

  const clientIds = clients.map((c) => c.id);
  const { data: runRows, error: runsError } = await sb
    .from("runs")
    .select(
      "id,client_id,status,started_at,finished_at,total,current,pct,indexed_count,not_indexed_count,submitted_count,error",
    )
    .in("client_id", clientIds)
    .order("started_at", { ascending: false });

  if (runsError) {
    return jsonError(502, `supabase: ${runsError.message}`);
  }

  const runs = (runRows ?? []) as RunRow[];
  const latestDone: Record<string, RunRow> = {};
  const currentRun: Record<string, RunRow> = {};
  for (const r of runs) {
    if (r.status === "running" && !currentRun[r.client_id]) {
      currentRun[r.client_id] = r;
    }
    if (r.status === "done" && !latestDone[r.client_id]) {
      latestDone[r.client_id] = r;
    }
  }

  let urlsTotal = 0;
  let indexedTotal = 0;
  const out: ClientListItem[] = clients.map((c) => {
    const done = latestDone[c.id];
    const running = currentRun[c.id];

    let stats: RunStats | null = null;
    let lastRunAt: string | null = null;
    if (done) {
      const total = (done.indexed_count ?? 0) + (done.not_indexed_count ?? 0);
      stats = {
        total,
        indexed: done.indexed_count ?? 0,
        not_indexed: done.not_indexed_count ?? 0,
        submitted: done.submitted_count ?? 0,
      };
      urlsTotal += total;
      indexedTotal += stats.indexed;
      lastRunAt = done.finished_at ?? done.started_at;
    }

    const currentPayload: CurrentRun | null = running
      ? {
          id: running.id,
          status: running.status,
          current: running.current ?? 0,
          total: running.total ?? 0,
          pct: Number(running.pct ?? 0),
          started_at: running.started_at,
        }
      : null;

    return {
      ...c,
      stats,
      last_run_at: lastRunAt,
      current_run: currentPayload,
    };
  });

  // Real 24h submission window — counts every URL submitted to the Indexing
  // API in the last 24h, regardless of whether it came from a sitemap run or
  // the manual /submit flow. Source of truth is `url_status.last_submitted`.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentSubs } = await sb
    .from("url_status")
    .select("client_id,last_submitted")
    .gte("last_submitted", cutoff)
    .returns<{ client_id: string; last_submitted: string | null }[]>();

  const perClient = new Map<string, { count: number; latest: string }>();
  for (const row of recentSubs ?? []) {
    if (!row.last_submitted) continue;
    const cur = perClient.get(row.client_id);
    if (cur) {
      cur.count += 1;
      if (row.last_submitted > cur.latest) cur.latest = row.last_submitted;
    } else {
      perClient.set(row.client_id, { count: 1, latest: row.last_submitted });
    }
  }
  const breakdown: QuotaBreakdownRow[] = [...perClient.entries()]
    .map(([client_id, { count, latest }]) => ({
      client_id,
      count,
      last_submitted: latest,
    }))
    .sort((a, b) => b.count - a.count);
  const usedToday = breakdown.reduce((sum, r) => sum + r.count, 0);

  return NextResponse.json({
    clients: out,
    dashboard: {
      total_clients: clients.length,
      urls_tracked: urlsTotal,
      indexed: indexedTotal,
      active_runs: Object.keys(currentRun).length,
    },
    quota: {
      used_today: usedToday,
      per_client: breakdown,
    } satisfies QuotaPayload,
  });
}

/** POST /api/clients — create a new client. */
export async function POST(request: Request) {
  const sb = supabase();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "body must be valid JSON");
  }

  const name = String(body.name ?? "").trim();
  const websiteRaw = String(body.website ?? body.domain ?? "").trim();
  let sitemap = String(body.sitemap_url ?? "").trim();
  let gsc = String(body.gsc_site_url ?? "").trim();

  if (!name || !websiteRaw) {
    return jsonError(400, "name and website are required");
  }

  const website = normalizeWebsite(websiteRaw);
  const domain = domainOf(website);
  if (!sitemap) sitemap = website.replace(/\/$/, "") + "/sitemap.xml";
  if (!gsc) gsc = website.endsWith("/") ? website : website + "/";

  const { data: existing } = await sb
    .from("clients")
    .select("id")
    .returns<{ id: string }[]>();
  const taken = new Set((existing ?? []).map((r) => r.id));
  const base = slugify(name);
  let id = base;
  let n = 1;
  while (taken.has(id)) {
    n += 1;
    id = `${base}-${n}`;
  }

  const row: ClientRow = {
    id,
    name,
    domain,
    sitemap_url: sitemap,
    gsc_site_url: gsc,
    created_at: new Date().toISOString(),
  };

  const { error } = await sb.from("clients").insert(row);
  if (error) return jsonError(502, `supabase: ${error.message}`);

  return NextResponse.json({ client: row }, { status: 201 });
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}
