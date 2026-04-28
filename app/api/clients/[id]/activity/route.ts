import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ActivityRow = {
  url: string;
  last_submitted: string | null;
  notes: string | null;
  submit_attempts: number;
  source: "sitemap" | "manual";
};

/**
 * GET /api/clients/[id]/activity?limit=100
 *
 * Recent submission events for the client, derived from url_status. Powers
 * the Activity Log on the Run tab — refreshed by the client every 15s.
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
  const limitParam = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(limitParam)
    ? Math.max(1, Math.min(500, Math.floor(limitParam)))
    : 100;

  const sb = supabase();
  const { data, error } = await sb
    .from("url_status")
    .select("url,last_submitted,notes,submit_attempts,source")
    .eq("client_id", clientId)
    .not("last_submitted", "is", null)
    .order("last_submitted", { ascending: false, nullsFirst: false })
    .limit(limit)
    .returns<ActivityRow[]>();

  if (error) {
    return NextResponse.json(
      { error: `supabase: ${error.message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    events: data ?? [],
    server_time: new Date().toISOString(),
  });
}
