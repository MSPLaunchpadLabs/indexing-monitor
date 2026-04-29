import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { dispatchIndexingRun } from "@/lib/github-dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cron/scheduled-run
 *
 * The auto-scheduler. On each tick:
 *
 *   1. Compute today's used quota (since UTC midnight) from `url_status.last_submitted`.
 *   2. If remaining < MIN_PER_DISPATCH, skip — wait for UTC midnight reset.
 *   3. Pick the staleest client that doesn't have a run in flight.
 *   4. Fair-share the remaining quota across clients still due today, so one
 *      client doesn't eat the whole 195/day in tick 1.
 *   5. Insert a `runs` row and dispatch GHA with the computed cap.
 *
 * The engine then submits NEW URLs first, then existing not-indexed URLs,
 * within the cap (see engine/runner.py step 4).
 *
 * Triggered by Vercel Cron at 00/06/12/18 UTC.
 */
const DAILY_QUOTA = 200;
const SAFETY_BUFFER = 5; // leave headroom for manual /submit usage
const MIN_PER_DISPATCH = 10; // skip ticks where there's nothing meaningful to send
const FAIR_SHARE_FLOOR = 20; // never under-allocate a client to a tiny dispatch

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const sb = supabase();

  // ── 1. today's used quota ────────────────────────────────────────────────
  const startOfUtcDay = new Date();
  startOfUtcDay.setUTCHours(0, 0, 0, 0);
  const cutoff = startOfUtcDay.toISOString();

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

  if (remaining < MIN_PER_DISPATCH) {
    return NextResponse.json({
      ok: true,
      action: "skipped",
      reason: "quota-exhausted-or-near-cap",
      used_today: usedToday,
      remaining,
    });
  }

  // ── 2. find candidates ───────────────────────────────────────────────────
  const { data: clients, error: clientsErr } = await sb
    .from("clients")
    .select("id,name")
    .returns<{ id: string; name: string }[]>();
  if (clientsErr) {
    return NextResponse.json(
      { error: `list clients: ${clientsErr.message}` },
      { status: 502 },
    );
  }
  if (!clients || clients.length === 0) {
    return NextResponse.json({
      ok: true,
      action: "skipped",
      reason: "no-clients",
    });
  }

  // Latest run per client — used for both "skip if running" and "pick staleest".
  const { data: runs, error: runsErr } = await sb
    .from("runs")
    .select("client_id,status,started_at,finished_at")
    .order("started_at", { ascending: false })
    .returns<
      {
        client_id: string;
        status: "running" | "done" | "failed";
        started_at: string;
        finished_at: string | null;
      }[]
    >();
  if (runsErr) {
    return NextResponse.json(
      { error: `list runs: ${runsErr.message}` },
      { status: 502 },
    );
  }

  const runningClients = new Set<string>();
  const lastFinishAt = new Map<string, number>();
  for (const r of runs ?? []) {
    if (r.status === "running") runningClients.add(r.client_id);
    if (r.status === "done" && !lastFinishAt.has(r.client_id)) {
      const ts = r.finished_at ?? r.started_at;
      lastFinishAt.set(r.client_id, new Date(ts).getTime());
    }
  }

  const candidates = clients.filter((c) => !runningClients.has(c.id));
  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      action: "skipped",
      reason: "all-clients-have-running-run",
      running: [...runningClients],
    });
  }

  // Staleest first: never-completed clients (no entry → -Infinity) win, then
  // oldest finished_at.
  candidates.sort((a, b) => {
    const ta = lastFinishAt.get(a.id) ?? -Infinity;
    const tb = lastFinishAt.get(b.id) ?? -Infinity;
    return ta - tb;
  });
  const pick = candidates[0];

  // ── 3. fair-share cap ────────────────────────────────────────────────────
  // "Due today" = clients whose latest run finished before today UTC.
  const startOfDayMs = startOfUtcDay.getTime();
  const dueToday = candidates.filter((c) => {
    const finishedAt = lastFinishAt.get(c.id);
    return finishedAt === undefined || finishedAt < startOfDayMs;
  });
  const denom = Math.max(1, dueToday.length);
  const fairShare = Math.floor(remaining / denom);
  const cap = Math.min(remaining, Math.max(FAIR_SHARE_FLOOR, fairShare));

  // ── 4. create runs row + dispatch ────────────────────────────────────────
  const { data: created, error: createErr } = await sb
    .from("runs")
    .insert({
      client_id: pick.id,
      status: "running",
      started_at: new Date().toISOString(),
      log_tail: [
        `queued by scheduler · cap=${cap} · used_today=${usedToday}/${DAILY_QUOTA}`,
      ],
    })
    .select("id")
    .returns<{ id: string }[]>()
    .single();

  if (createErr || !created) {
    return NextResponse.json(
      {
        error: `failed to create run row: ${createErr?.message ?? "unknown"}`,
      },
      { status: 500 },
    );
  }

  try {
    await dispatchIndexingRun(pick.id, created.id, { maxSubmissions: cap });
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
    return NextResponse.json(
      { error: `dispatch failed: ${message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    action: "dispatched",
    client_id: pick.id,
    client_name: pick.name,
    run_id: created.id,
    cap,
    used_today: usedToday,
    remaining,
    due_today: dueToday.length,
    candidates: candidates.length,
  });
}
