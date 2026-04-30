import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { dispatchIndexingRun } from "@/lib/github-dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cron/scheduled-run
 *
 * Hourly scheduler with a daily fan-out model:
 *
 *   1. Compute today's used quota (since UTC midnight) from
 *      `url_status.last_submitted`.
 *   2. Find every client that hasn't successfully completed today AND
 *      isn't currently running AND isn't inside the failure cooldown.
 *   3. Split the day's remaining Indexing API quota evenly across them
 *      so every client gets a submit budget — no single client eats all
 *      200 in one tick.
 *   4. Insert one `runs` row per client and dispatch GHA in parallel.
 *
 * The runner inspects every URL (free) and submits new sitemap URLs
 * first within its assigned cap (engine/runner.py step 4). If a client
 * has fewer eligible URLs than its cap, leftover quota stays unused —
 * we accept the slack rather than over-allocate to busy clients.
 *
 * Hourly ticks after the first successful fan-out are mostly no-ops:
 * everyone already ran today, so candidates is empty. Failed clients
 * become eligible again after FAIL_COOLDOWN_HOURS.
 *
 * Triggered by Vercel Cron at `0 * * * *`.
 */
const DAILY_QUOTA = 200;
const SAFETY_BUFFER = 5; // leave headroom for manual /submit usage
const MIN_CAP_PER_CLIENT = 1; // never dispatch with cap=0 — engine yml treats it as "use default"
const FAIL_COOLDOWN_HOURS = 12;

type RunRow = {
  client_id: string;
  status: "running" | "done" | "failed";
  started_at: string;
  finished_at: string | null;
};

type DispatchResult = {
  client_id: string;
  client_name: string;
  status: "dispatched" | "dispatch-failed";
  run_id?: string;
  cap?: number;
  error?: string;
};

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const sb = supabase();

  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const startOfDayMs = startOfUtcDay.getTime();
  const cutoff = startOfUtcDay.toISOString();

  // ── 1. today's used quota ────────────────────────────────────────────────
  const { data: subRows, error: subErr } = await sb
    .from("url_status")
    .select("client_id,last_submitted")
    .gte("last_submitted", cutoff)
    .returns<{ client_id: string; last_submitted: string | null }[]>();
  if (subErr) {
    return NextResponse.json(
      { error: `count submissions: ${subErr.message}` },
      { status: 502 },
    );
  }
  const usedToday = (subRows ?? []).filter((r) => r.last_submitted).length;
  const remaining = Math.max(0, DAILY_QUOTA - usedToday - SAFETY_BUFFER);

  // ── 2. clients + run history ─────────────────────────────────────────────
  const [clientsRes, runsRes] = await Promise.all([
    sb
      .from("clients")
      .select("id,name")
      .returns<{ id: string; name: string }[]>(),
    sb
      .from("runs")
      .select("client_id,status,started_at,finished_at")
      .order("started_at", { ascending: false })
      .returns<RunRow[]>(),
  ]);

  if (clientsRes.error) {
    return NextResponse.json(
      { error: `list clients: ${clientsRes.error.message}` },
      { status: 502 },
    );
  }
  if (runsRes.error) {
    return NextResponse.json(
      { error: `list runs: ${runsRes.error.message}` },
      { status: 502 },
    );
  }

  const clients = clientsRes.data ?? [];
  if (clients.length === 0) {
    return NextResponse.json({
      ok: true,
      action: "skipped",
      reason: "no-clients",
    });
  }

  const runs = runsRes.data ?? [];
  const runningClients = new Set<string>();
  const succeededToday = new Set<string>();
  const lastTerminal = new Map<
    string,
    { status: "done" | "failed"; ts: number }
  >();
  for (const r of runs) {
    if (r.status === "running") runningClients.add(r.client_id);
    if (r.status === "done") {
      const ts = new Date(r.finished_at ?? r.started_at).getTime();
      if (ts >= startOfDayMs) succeededToday.add(r.client_id);
    }
    if (
      (r.status === "done" || r.status === "failed") &&
      !lastTerminal.has(r.client_id)
    ) {
      lastTerminal.set(r.client_id, {
        status: r.status,
        ts: new Date(r.finished_at ?? r.started_at).getTime(),
      });
    }
  }

  const cooldownCutoff = Date.now() - FAIL_COOLDOWN_HOURS * 60 * 60 * 1000;
  const cooledDown = new Set<string>();
  for (const [clientId, last] of lastTerminal) {
    if (last.status === "failed" && last.ts >= cooldownCutoff) {
      cooledDown.add(clientId);
    }
  }

  const candidates = clients.filter(
    (c) =>
      !runningClients.has(c.id) &&
      !succeededToday.has(c.id) &&
      !cooledDown.has(c.id),
  );

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      action: "skipped",
      reason: "all-clients-handled-today",
      running: runningClients.size,
      succeeded_today: succeededToday.size,
      cooled_down: cooledDown.size,
    });
  }

  // ── 3. split remaining quota across all candidates ──────────────────────
  // Equal share. If a client has fewer eligible URLs than its cap, the
  // leftover stays unspent — that's preferable to handing it to a busy
  // client and starving the small ones.
  const capPerClient = Math.max(
    MIN_CAP_PER_CLIENT,
    Math.floor(remaining / candidates.length),
  );

  // ── 4. fan out: create runs row + dispatch GHA per client ────────────────
  const results = await Promise.all(
    candidates.map(async (client): Promise<DispatchResult> => {
      const { data: created, error: createErr } = await sb
        .from("runs")
        .insert({
          client_id: client.id,
          status: "running",
          started_at: new Date().toISOString(),
          log_tail: [
            `queued by scheduler · cap=${capPerClient} · used_today=${usedToday}/${DAILY_QUOTA} · fan_out=${candidates.length}`,
          ],
        })
        .select("id")
        .returns<{ id: string }[]>()
        .single();

      if (createErr || !created) {
        return {
          client_id: client.id,
          client_name: client.name,
          status: "dispatch-failed",
          error: `create runs row: ${createErr?.message ?? "unknown"}`,
        };
      }

      try {
        await dispatchIndexingRun(client.id, created.id, {
          maxSubmissions: capPerClient,
        });
        return {
          client_id: client.id,
          client_name: client.name,
          status: "dispatched",
          run_id: created.id,
          cap: capPerClient,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sb
          .from("runs")
          .update({
            status: "failed",
            finished_at: new Date().toISOString(),
            error: `scheduler dispatch failed: ${message}`.slice(0, 2000),
          })
          .eq("id", created.id);
        return {
          client_id: client.id,
          client_name: client.name,
          status: "dispatch-failed",
          run_id: created.id,
          error: message,
        };
      }
    }),
  );

  const dispatched = results.filter((r) => r.status === "dispatched");
  const failed = results.filter((r) => r.status === "dispatch-failed");

  return NextResponse.json({
    ok: true,
    action: "fanned-out",
    used_today: usedToday,
    remaining,
    cap_per_client: capPerClient,
    dispatched: dispatched.length,
    dispatch_failed: failed.length,
    succeeded_today: succeededToday.size,
    cooled_down: cooledDown.size,
    results,
  });
}
