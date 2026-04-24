import { NextResponse } from "next/server";
import { supabase, type UrlStatusRow } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/clients/[id]/monthly?year=YYYY&month=MM
 *   → { summary: {submitted, indexed, pending, failed}, rows: [...] }
 *
 * Manual submissions (source='manual') whose `first_seen` lands inside the
 * requested calendar month. `first_seen` is stored as a string, so we filter
 * with lexicographic range bounds — both YYYY-MM-DD and full ISO sort the
 * same way inside a single month.
 */
type Row = Pick<
  UrlStatusRow,
  | "url"
  | "submitted"
  | "last_submitted"
  | "indexed"
  | "last_checked"
  | "notes"
  | "submit_attempts"
  | "first_seen"
>;

function monthBounds(year: number, month: number): { start: string; end: string } {
  const mm = String(month).padStart(2, "0");
  const start = `${year}-${mm}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  return { start, end };
}

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
  const now = new Date();
  const year = Number.parseInt(
    url.searchParams.get("year") ?? String(now.getUTCFullYear()),
    10,
  );
  const month = Number.parseInt(
    url.searchParams.get("month") ?? String(now.getUTCMonth() + 1),
    10,
  );
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    month < 1 ||
    month > 12
  ) {
    return NextResponse.json(
      { error: "year and month must be valid integers (month 1-12)" },
      { status: 400 },
    );
  }

  const { start, end } = monthBounds(year, month);

  const sb = supabase();
  const { data, error } = await sb
    .from("url_status")
    .select(
      "url,submitted,last_submitted,indexed,last_checked,notes,submit_attempts,first_seen",
    )
    .eq("client_id", clientId)
    .eq("source", "manual")
    .gte("first_seen", start)
    .lt("first_seen", end)
    .order("last_submitted", { ascending: false, nullsFirst: false })
    .order("first_seen", { ascending: false })
    .returns<Row[]>();

  if (error) {
    return NextResponse.json(
      { error: `supabase: ${error.message}` },
      { status: 502 },
    );
  }

  const rows = data ?? [];

  let submitted = 0;
  let indexed = 0;
  let pending = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.submitted) {
      submitted += 1;
      if (r.indexed === "yes") indexed += 1;
      else pending += 1;
    } else {
      failed += 1;
    }
  }

  return NextResponse.json({
    summary: { submitted, indexed, pending, failed },
    rows: rows.map((r) => ({
      url: r.url,
      submitted: r.submitted,
      submitted_at: r.last_submitted,
      indexed: r.indexed,
      last_checked: r.last_checked,
      notes: r.notes ?? "",
      attempts: r.submit_attempts ?? 0,
    })),
  });
}
