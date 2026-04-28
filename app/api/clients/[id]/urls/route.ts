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

const VALID_STATUSES = new Set(["all", "indexed", "not_indexed", "submitted"]);

/**
 * GET /api/clients/[id]/urls?status=all|indexed|not_indexed|submitted
 *
 * Returns the rows from `url_status` matching the given filter for this
 * client. Used by the detail page to render the per-status URL list under
 * the clickable stat cards. `all` returns every URL regardless of status.
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
  const status = url.searchParams.get("status") ?? "";
  if (!VALID_STATUSES.has(status)) {
    return NextResponse.json(
      { error: "status must be one of: all, indexed, not_indexed, submitted" },
      { status: 400 },
    );
  }

  const sb = supabase();
  let query = sb
    .from("url_status")
    .select("url,indexed,last_checked,submitted,last_submitted,notes")
    .eq("client_id", clientId);

  if (status === "indexed") query = query.eq("indexed", "yes");
  else if (status === "not_indexed") query = query.eq("indexed", "no");
  else if (status === "submitted") query = query.eq("submitted", true);
  // status === "all" → no extra filter

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
