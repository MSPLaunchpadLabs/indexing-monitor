import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type UrlSummaryRow = {
  url: string;
  indexed: "yes" | "no" | "unknown" | null;
  last_checked: string | null;
  submitted: boolean;
  last_submitted: string | null;
  notes: string | null;
};

const NO_REASON_LABEL = "(no reason listed)";

/**
 * GET /api/clients/[id]/urls-by-reason?reason=<reason>
 *
 * Returns the not-indexed URLs from the latest completed run whose `notes`
 * field matches the given Google reason. Powers the clickable rows under
 * "Why URLs are not indexed" on the client detail page.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clientId = id.trim();
  if (!clientId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const url = new URL(request.url);
  const reason = url.searchParams.get("reason");
  if (!reason) {
    return NextResponse.json(
      { error: "reason is required" },
      { status: 400 },
    );
  }

  const sb = supabase();

  // Find the most recent completed run for this client — that's the run the
  // reason_breakdown on the detail page is computed from, so we mirror it.
  const { data: latestDone, error: runErr } = await sb
    .from("runs")
    .select("id")
    .eq("client_id", clientId)
    .eq("status", "done")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runErr) {
    return NextResponse.json(
      { error: `supabase: ${runErr.message}` },
      { status: 502 },
    );
  }
  if (!latestDone) {
    return NextResponse.json({ urls: [] });
  }

  let query = sb
    .from("run_urls")
    .select("url,indexed,last_checked,submitted,last_submitted,notes")
    .eq("run_id", latestDone.id)
    .eq("indexed", "no");

  // The reason_breakdown groups null/empty notes under the "(no reason
  // listed)" bucket — match that here so clicking the row shows those URLs.
  if (reason === NO_REASON_LABEL) {
    query = query.or("notes.is.null,notes.eq.");
  } else {
    query = query.eq("notes", reason);
  }

  const { data, error } = await query
    .order("last_checked", { ascending: false, nullsFirst: false })
    .limit(500)
    .returns<UrlSummaryRow[]>();

  if (error) {
    return NextResponse.json(
      { error: `supabase: ${error.message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ urls: data ?? [] });
}
