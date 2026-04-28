import { NextResponse } from "next/server";
import { supabase, type RunRow, type RunStats } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ReasonRow = { reason: string; count: number };

/** GET /api/clients/[id] — detail payload for the client detail page. */
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

  const { data: client, error: clientError } = await sb
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .maybeSingle();

  if (clientError) {
    return NextResponse.json({ error: `supabase: ${clientError.message}` }, { status: 502 });
  }
  if (!client) {
    return NextResponse.json(
      { error: `client "${clientId}" not found` },
      { status: 404 },
    );
  }

  const { data: recentRuns } = await sb
    .from("runs")
    .select(
      "id,status,started_at,finished_at,total,current,pct,error,indexed_count,not_indexed_count,submitted_count",
    )
    .eq("client_id", clientId)
    .order("started_at", { ascending: false })
    .limit(5);

  const runs = (recentRuns ?? []) as RunRow[];
  const latestDone = runs.find((r) => r.status === "done") ?? null;
  const current = runs.find((r) => r.status === "running") ?? null;

  let stats: RunStats | null = null;
  let reasonBreakdown: ReasonRow[] = [];
  if (latestDone) {
    const total = (latestDone.indexed_count ?? 0) + (latestDone.not_indexed_count ?? 0);
    stats = {
      total,
      indexed: latestDone.indexed_count ?? 0,
      not_indexed: latestDone.not_indexed_count ?? 0,
      submitted: latestDone.submitted_count ?? 0,
    };

    if (stats.not_indexed > 0) {
      const { data: notIndexedUrls } = await sb
        .from("run_urls")
        .select("notes")
        .eq("run_id", latestDone.id)
        .eq("indexed", "no")
        .returns<{ notes: string | null }[]>();
      const counter = new Map<string, number>();
      for (const r of notIndexedUrls ?? []) {
        const reason = r.notes?.trim() || "(no reason listed)";
        counter.set(reason, (counter.get(reason) ?? 0) + 1);
      }
      reasonBreakdown = [...counter.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count }));
    }
  }

  return NextResponse.json({
    client,
    stats,
    last_run_at: latestDone?.finished_at ?? latestDone?.started_at ?? null,
    reason_breakdown: reasonBreakdown,
    current_run: current
      ? {
          id: current.id,
          status: current.status,
          current: current.current ?? 0,
          total: current.total ?? 0,
          pct: Number(current.pct ?? 0),
          started_at: current.started_at,
        }
      : null,
  });
}

/**
 * DELETE /api/clients/[id] — removes the client and all related rows.
 *
 * Cascade rules in the schema (`url_status`, `runs`, `run_urls`) drop the
 * dependent records automatically, so this is a single delete against the
 * clients table.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clientId = id.trim();
  if (!clientId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const sb = supabase();

  const { error } = await sb.from("clients").delete().eq("id", clientId);
  if (error) {
    return NextResponse.json(
      { error: `supabase: ${error.message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, id: clientId });
}
