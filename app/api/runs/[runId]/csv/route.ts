import { NextResponse } from "next/server";
import { supabase, type RunUrlRow } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Column order must stay compatible with the old Streamlit CSV export so
// existing downstream tooling (or people pasting rows into a spreadsheet)
// keeps working.
const CSV_COLUMNS = [
  "url",
  "is_new",
  "indexed",
  "last_checked",
  "submitted",
  "last_submitted",
  "notes",
  "first_seen",
  "submit_attempts",
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** GET /api/runs/[runId]/csv — download the per-URL snapshot of a finished run. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const id = runId.trim();
  if (!id) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }

  const sb = supabase();

  const { data: runs, error: runErr } = await sb
    .from("runs")
    .select("id,client_id,started_at")
    .eq("id", id)
    .limit(1)
    .returns<{ id: string; client_id: string; started_at: string }[]>();

  if (runErr) {
    return NextResponse.json(
      { error: `supabase: ${runErr.message}` },
      { status: 502 },
    );
  }
  if (!runs || runs.length === 0) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  const run = runs[0];

  const { data: rowData, error: rowsErr } = await sb
    .from("run_urls")
    .select("*")
    .eq("run_id", id)
    .order("url", { ascending: true });

  if (rowsErr) {
    return NextResponse.json(
      { error: `supabase: ${rowsErr.message}` },
      { status: 502 },
    );
  }

  const rows = (rowData ?? []) as RunUrlRow[];

  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.url),
        csvEscape(r.is_new ? 1 : 0),
        csvEscape(r.indexed ?? ""),
        csvEscape(r.last_checked ?? ""),
        csvEscape(r.submitted ? 1 : 0),
        csvEscape(r.last_submitted ?? ""),
        csvEscape(r.notes ?? ""),
        csvEscape(r.first_seen ?? ""),
        csvEscape(r.submit_attempts ?? 0),
      ].join(","),
    );
  }
  const body = lines.join("\r\n") + "\r\n";

  const started = (run.started_at ?? "").split("T")[0] || "run";
  const filename = `${run.client_id}-${started}.csv`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
