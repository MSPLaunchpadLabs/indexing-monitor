import { NextResponse } from "next/server";
import { submitUrlForIndexing } from "@/lib/google-indexing";
import { inspectUrl } from "@/lib/google-search-console";
import { supabase, type ClientRow, type UrlStatusRow } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

type ActionBody = {
  url?: string;
  action?: "submit" | "inspect";
};

type ActionResponse = {
  ok: boolean;
  message: string;
  url: string;
  row: Pick<
    UrlStatusRow,
    | "url"
    | "indexed"
    | "last_checked"
    | "submitted"
    | "last_submitted"
    | "notes"
    | "submit_attempts"
  > | null;
};

/**
 * POST /api/clients/[id]/url-action
 *   body: { url, action: "submit" | "inspect" }
 *
 * Per-row actions for the URL list table:
 *   - "submit"  → calls Indexing API (URL_UPDATED), bumps submit_attempts,
 *                 sets submitted=true and last_submitted=now on success.
 *   - "inspect" → calls URL Inspection API, writes indexed/last_checked/notes
 *                 from the verdict + coverageState.
 *
 * Returns the updated url_status row so the client can patch its local list
 * without refetching the whole panel.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clientId = id.trim();
  if (!clientId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }

  const url = (body.url ?? "").trim();
  const action = body.action;
  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  if (action !== "submit" && action !== "inspect") {
    return NextResponse.json(
      { error: "action must be 'submit' or 'inspect'" },
      { status: 400 },
    );
  }

  const sb = supabase();

  const { data: clientRow, error: clientErr } = await sb
    .from("clients")
    .select("*")
    .eq("id", clientId)
    .returns<ClientRow[]>()
    .maybeSingle();
  if (clientErr) {
    return NextResponse.json(
      { error: `supabase: ${clientErr.message}` },
      { status: 502 },
    );
  }
  if (!clientRow) {
    return NextResponse.json({ error: "client not found" }, { status: 404 });
  }

  const { data: existing, error: existingErr } = await sb
    .from("url_status")
    .select("submit_attempts,first_seen,source")
    .eq("client_id", clientId)
    .eq("url", url)
    .returns<{
      submit_attempts: number | null;
      first_seen: string | null;
      source: "sitemap" | "manual" | null;
    }[]>()
    .maybeSingle();
  if (existingErr) {
    return NextResponse.json(
      { error: `supabase: ${existingErr.message}` },
      { status: 502 },
    );
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const firstSeen = existing?.first_seen ?? today;
  const prevAttempts = existing?.submit_attempts ?? 0;
  const source = existing?.source ?? ("manual" as const);
  const isNew = existing == null;

  if (action === "submit") {
    const outcome = await submitUrlForIndexing(url);
    const ok = outcome.ok;
    const message = ok ? "Submitted to Indexing API" : outcome.message;

    const upsertRow = {
      client_id: clientId,
      url,
      is_new: isNew,
      submitted: ok,
      last_submitted: ok ? nowIso : null,
      notes: message,
      first_seen: firstSeen,
      submit_attempts: prevAttempts + 1,
      source,
    };
    const { data: updated, error: upsertErr } = await sb
      .from("url_status")
      .upsert(upsertRow, { onConflict: "client_id,url" })
      .select(
        "url,indexed,last_checked,submitted,last_submitted,notes,submit_attempts",
      )
      .returns<ActionResponse["row"][]>()
      .single();

    if (upsertErr) {
      return NextResponse.json<ActionResponse>(
        {
          ok: false,
          message: `submit ok=${ok}, db error: ${upsertErr.message}`,
          url,
          row: null,
        },
        { status: 502 },
      );
    }

    return NextResponse.json<ActionResponse>({
      ok,
      message,
      url,
      row: updated,
    });
  }

  // action === "inspect"
  const result = await inspectUrl(url, clientRow.gsc_site_url);
  if (!result.ok) {
    // Persist the failure note so the row reflects the issue, but don't
    // overwrite a previously-known indexed value.
    const upsertRow = {
      client_id: clientId,
      url,
      is_new: isNew,
      last_checked: nowIso,
      notes: `inspect error: ${result.message}`.slice(0, 500),
      first_seen: firstSeen,
      submit_attempts: prevAttempts,
      source,
    };
    const { data: updated, error: upsertErr } = await sb
      .from("url_status")
      .upsert(upsertRow, { onConflict: "client_id,url" })
      .select(
        "url,indexed,last_checked,submitted,last_submitted,notes,submit_attempts",
      )
      .returns<ActionResponse["row"][]>()
      .single();

    if (upsertErr) {
      return NextResponse.json<ActionResponse>(
        {
          ok: false,
          message: `inspect failed: ${result.message}; db error: ${upsertErr.message}`,
          url,
          row: null,
        },
        { status: 502 },
      );
    }
    return NextResponse.json<ActionResponse>({
      ok: false,
      message: result.message,
      url,
      row: updated,
    });
  }

  const upsertRow = {
    client_id: clientId,
    url,
    is_new: isNew,
    indexed: result.indexed,
    last_checked: nowIso,
    notes: result.reason,
    first_seen: firstSeen,
    submit_attempts: prevAttempts,
    source,
  };
  const { data: updated, error: upsertErr } = await sb
    .from("url_status")
    .upsert(upsertRow, { onConflict: "client_id,url" })
    .select(
      "url,indexed,last_checked,submitted,last_submitted,notes,submit_attempts",
    )
    .returns<ActionResponse["row"][]>()
    .single();

  if (upsertErr) {
    return NextResponse.json<ActionResponse>(
      {
        ok: false,
        message: `db error: ${upsertErr.message}`,
        url,
        row: null,
      },
      { status: 502 },
    );
  }

  return NextResponse.json<ActionResponse>({
    ok: true,
    message: result.reason,
    url,
    row: updated,
  });
}
