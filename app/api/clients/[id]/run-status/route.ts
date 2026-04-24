import { NextResponse } from "next/server";
import { supabase, type RunRow } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/clients/[id]/run-status
 *
 * Tiny endpoint polled every ~2s while a run is active. Returns the latest
 * run (running or done) with log_tail + progress + stats.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clientId = id.trim();
  if (!clientId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const sb = supabase();
  const { data, error } = await sb
    .from("runs")
    .select(
      "id,status,started_at,finished_at,total,current,pct,error,log_tail,indexed_count,not_indexed_count,submitted_count",
    )
    .eq("client_id", clientId)
    .order("started_at", { ascending: false })
    .limit(1);

  if (error) {
    return NextResponse.json(
      { error: `supabase: ${error.message}` },
      { status: 502 },
    );
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ run: null });
  }

  const r = data[0] as RunRow;
  const total = (r.indexed_count ?? 0) + (r.not_indexed_count ?? 0);
  return NextResponse.json({
    run: {
      id: r.id,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at,
      total: r.total ?? 0,
      current: r.current ?? 0,
      pct: Number(r.pct ?? 0),
      error: r.error,
      log_tail: r.log_tail ?? [],
      stats: {
        total,
        indexed: r.indexed_count ?? 0,
        not_indexed: r.not_indexed_count ?? 0,
        submitted: r.submitted_count ?? 0,
      },
    },
  });
}
