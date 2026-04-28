import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cron/sweep-stale-runs
 *
 * Marks any `runs` row stuck in `status='running'` for longer than the GHA
 * workflow timeout as failed. The engine UPDATEs the same row throughout the
 * run, so if GitHub Actions cancels (timeout, runner crash, manual cancel)
 * before the engine flips status to `done`, the row hangs in `running`
 * forever and the dashboard shows a phantom progress bar.
 *
 * Triggered by Vercel Cron every 5 minutes.
 *
 * Threshold = 65 min (GHA workflow timeout is 60 min — give it a 5-min grace
 * window for late status updates from a workflow that finished normally).
 */
const STALE_AFTER_MIN = 65;

export async function GET(request: Request) {
  // Vercel cron requests carry an Authorization header signed with CRON_SECRET.
  // In dev there's no header — allow that so you can hit the endpoint manually.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const sb = supabase();
  const cutoff = new Date(Date.now() - STALE_AFTER_MIN * 60_000).toISOString();

  const { data: stale, error: selectErr } = await sb
    .from("runs")
    .select("id,client_id,started_at,current,total")
    .eq("status", "running")
    .lt("started_at", cutoff);

  if (selectErr) {
    return NextResponse.json(
      { error: `select failed: ${selectErr.message}` },
      { status: 502 },
    );
  }

  if (!stale || stale.length === 0) {
    return NextResponse.json({ ok: true, swept: 0, runs: [] });
  }

  const finishedAt = new Date().toISOString();
  const ids = stale.map((r) => r.id);

  const { error: updateErr } = await sb
    .from("runs")
    .update({
      status: "failed",
      finished_at: finishedAt,
      error: `Run exceeded ${STALE_AFTER_MIN}min — GitHub Actions workflow likely cancelled or crashed before it could mark the run done. Marked failed by stale-run sweeper.`,
    })
    .in("id", ids);

  if (updateErr) {
    return NextResponse.json(
      { error: `update failed: ${updateErr.message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    swept: stale.length,
    runs: stale.map((r) => ({
      id: r.id,
      client_id: r.client_id,
      started_at: r.started_at,
      progress: `${r.current ?? 0}/${r.total ?? 0}`,
    })),
  });
}
