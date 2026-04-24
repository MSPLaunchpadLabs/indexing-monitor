import { NextResponse } from "next/server";
import { supabase, type RunRow } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/clients/[id]/history — the History tab data. */
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
      "id,status,started_at,finished_at,total,current,pct,error,indexed_count,not_indexed_count,submitted_count",
    )
    .eq("client_id", clientId)
    .order("started_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json(
      { error: `supabase: ${error.message}` },
      { status: 502 },
    );
  }

  const runs = (data ?? []) as RunRow[];
  return NextResponse.json({
    runs: runs.map((r) => {
      const total = (r.indexed_count ?? 0) + (r.not_indexed_count ?? 0);
      return {
        id: r.id,
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        error: r.error,
        stats: {
          total,
          indexed: r.indexed_count ?? 0,
          not_indexed: r.not_indexed_count ?? 0,
          submitted: r.submitted_count ?? 0,
        },
      };
    }),
  });
}
