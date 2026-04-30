import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cron/daily-report
 *
 * Posts one summary embed to DISCORD_WEBHOOK_URL covering every run that
 * started in the prior UTC calendar day. Triggered by Vercel Cron at
 * 04:00 UTC (= 08:00 Dubai) so the operator sees yesterday's recap with
 * morning coffee.
 *
 * Per-client breakdown + day totals. Clients with no activity show as `—`
 * so a silent client is still visible (helps catch broken setups). Runs
 * starting yesterday are counted entirely toward yesterday — runs that
 * span midnight thus belong to the day they began, which keeps the math
 * simple and avoids double-counting.
 */

const DAILY_QUOTA = 200;
const DASHBOARD_BASE = "https://indexing-monitor.vercel.app";
const COLOR_OK = 0x22c55e;       // emerald-500
const COLOR_WARN = 0xfacc15;     // amber-400 — some failures
const COLOR_FAIL = 0xef4444;     // red-500   — every run failed

type RunRow = {
  client_id: string;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at: string | null;
  total: number | null;
  current: number | null;
  indexed_count: number | null;
  not_indexed_count: number | null;
  submitted_count: number | null;
  error: string | null;
};

type ClientRow = { id: string; name: string };
type UrlStatusRow = {
  client_id: string;
  indexed: "yes" | "no" | "unknown" | null;
};

type Aggregate = {
  runs: number;
  inspected: number;
  submitted: number;
  failures: number;
  indexedSnapshot: number;
};

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return NextResponse.json(
      { error: "DISCORD_WEBHOOK_URL not configured" },
      { status: 500 },
    );
  }

  const sb = supabase();

  // Yesterday in UTC: [yesterdayStart, todayStart).
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);

  const [runsRes, clientsRes, urlStatusRes] = await Promise.all([
    sb
      .from("runs")
      .select(
        "client_id,status,started_at,finished_at,total,current,indexed_count,not_indexed_count,submitted_count,error",
      )
      .gte("started_at", yesterdayStart.toISOString())
      .lt("started_at", todayStart.toISOString())
      .returns<RunRow[]>(),
    sb.from("clients").select("id,name").returns<ClientRow[]>(),
    sb.from("url_status").select("client_id,indexed").returns<UrlStatusRow[]>(),
  ]);

  if (runsRes.error) {
    return NextResponse.json(
      { error: `runs fetch failed: ${runsRes.error.message}` },
      { status: 502 },
    );
  }
  if (clientsRes.error) {
    return NextResponse.json(
      { error: `clients fetch failed: ${clientsRes.error.message}` },
      { status: 502 },
    );
  }
  if (urlStatusRes.error) {
    return NextResponse.json(
      { error: `url_status fetch failed: ${urlStatusRes.error.message}` },
      { status: 502 },
    );
  }

  const runs = runsRes.data ?? [];
  const clients = clientsRes.data ?? [];
  const urlStatuses = urlStatusRes.data ?? [];

  // Skip silent days — no runs at all means nothing meaningful to celebrate.
  // Keeps the ops channel quiet on the rare day the scheduler had nothing to
  // dispatch (e.g. all clients in failure cooldown).
  if (runs.length === 0) {
    return NextResponse.json({
      ok: true,
      posted: false,
      reason: "no-runs-yesterday",
      day: yesterdayStart.toISOString().slice(0, 10),
    });
  }

  // ── per-client aggregates ───────────────────────────────────────────────
  const blank = (): Aggregate => ({
    runs: 0,
    inspected: 0,
    submitted: 0,
    failures: 0,
    indexedSnapshot: 0,
  });
  const byClient = new Map<string, Aggregate>();
  for (const c of clients) byClient.set(c.id, blank());

  for (const r of runs) {
    const a = byClient.get(r.client_id) ?? blank();
    a.runs += 1;
    a.inspected += r.current ?? 0;
    a.submitted += r.submitted_count ?? 0;
    if (r.status === "failed") a.failures += 1;
    byClient.set(r.client_id, a);
  }

  for (const u of urlStatuses) {
    if (u.indexed !== "yes") continue;
    const a = byClient.get(u.client_id);
    if (a) a.indexedSnapshot += 1;
  }

  // ── totals ──────────────────────────────────────────────────────────────
  const clientsCovered = new Set(runs.map((r) => r.client_id)).size;
  const totals = {
    runs: runs.length,
    clients_covered: clientsCovered,
    done: runs.filter((r) => r.status === "done").length,
    failed: runs.filter((r) => r.status === "failed").length,
    inspected: runs.reduce((s, r) => s + (r.current ?? 0), 0),
    submitted: runs.reduce((s, r) => s + (r.submitted_count ?? 0), 0),
    indexed: urlStatuses.filter((u) => u.indexed === "yes").length,
  };

  // ── format embed ────────────────────────────────────────────────────────
  const dayLabel = yesterdayStart.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  const tableRows = clients
    .map((c) => ({ name: c.name, ...(byClient.get(c.id) ?? blank()) }))
    .sort(
      (a, b) =>
        b.submitted - a.submitted ||
        b.runs - a.runs ||
        a.name.localeCompare(b.name),
    );

  const NAME_W = 18;
  const RUNS_W = 5;
  const INSPECT_W = 9;
  const SUBMIT_W = 8;
  const INDEX_W = 9;
  const FAIL_W = 8;

  const fmt = (n: number, w: number) => String(n).padStart(w);
  const fmtOrDash = (n: number, w: number) =>
    n === 0 ? "—".padStart(w) : fmt(n, w);

  const header =
    "Client".padEnd(NAME_W) +
    "Runs".padStart(RUNS_W) +
    "Inspect".padStart(INSPECT_W) +
    "Submit".padStart(SUBMIT_W) +
    "Indexed".padStart(INDEX_W) +
    "Failed".padStart(FAIL_W);
  const sep = "─".repeat(header.length);

  const lines = tableRows.map(
    (r) =>
      truncate(r.name, NAME_W).padEnd(NAME_W) +
      fmt(r.runs, RUNS_W) +
      fmtOrDash(r.inspected, INSPECT_W) +
      fmtOrDash(r.submitted, SUBMIT_W) +
      fmt(r.indexedSnapshot, INDEX_W) +
      fmtOrDash(r.failures, FAIL_W),
  );

  const totalLine =
    "TOTAL".padEnd(NAME_W) +
    fmt(totals.runs, RUNS_W) +
    fmt(totals.inspected, INSPECT_W) +
    fmt(totals.submitted, SUBMIT_W) +
    fmt(totals.indexed, INDEX_W) +
    fmt(totals.failed, FAIL_W);

  const table = [header, sep, ...lines, sep, totalLine].join("\n");

  const quotaPct = Math.round((totals.submitted / DAILY_QUOTA) * 100);
  const description =
    `**${totals.clients_covered}** client${totals.clients_covered === 1 ? "" : "s"} ran · ` +
    `**${totals.inspected.toLocaleString("en-US")}** URLs inspected · ` +
    `**${totals.submitted}** submitted for indexing (${quotaPct}% of ${DAILY_QUOTA}/day quota)\n` +
    `**${totals.indexed.toLocaleString("en-US")}** URLs are currently indexed by Google across all sites\n\n` +
    "```\n" +
    table +
    "\n```";

  const color =
    totals.runs > 0 && totals.failed === totals.runs
      ? COLOR_FAIL
      : totals.failed > 0
        ? COLOR_WARN
        : COLOR_OK;

  const embed = {
    title: `Daily report · ${dayLabel}`,
    color,
    url: DASHBOARD_BASE,
    description,
    timestamp: new Date().toISOString(),
  };

  // ── post to Discord ─────────────────────────────────────────────────────
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Indexing Monitor", embeds: [embed] }),
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        {
          error: `discord post failed: HTTP ${res.status} ${body.slice(0, 200)}`,
        },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: `discord post threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    posted: true,
    day: yesterdayStart.toISOString().slice(0, 10),
    totals,
    clients: tableRows.length,
  });
}

function truncate(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, Math.max(1, w - 1)) + "…";
}
