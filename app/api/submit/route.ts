import { NextResponse } from "next/server";
import { routeUrls } from "@/lib/route-urls";
import { submitUrlForIndexing } from "@/lib/google-indexing";
import { supabase, type ClientRow } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/submit
 *   body: { action: "route", urls: string[] }
 *     → { routed: RoutedUrl[] } — pure string matching, no Google calls.
 *
 *   body: { action: "dispatch", urls_by_client: Record<clientId, string[]> }
 *     → { results: SubmissionOutcome[] } — submits each URL synchronously and
 *       persists the outcome to public.url_status (source='manual').
 */
type RouteBody = { action: "route"; urls: string[] };
type DispatchBody = {
  action: "dispatch";
  urls_by_client: Record<string, string[]>;
};

type SubmissionOutcome = {
  url: string;
  client_id: string;
  ok: boolean;
  message: string;
};

export async function POST(request: Request) {
  let body: RouteBody | DispatchBody;
  try {
    body = (await request.json()) as RouteBody | DispatchBody;
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }

  const sb = supabase();
  const { data: clientRows, error: clientErr } = await sb
    .from("clients")
    .select("*")
    .order("name", { ascending: true });
  if (clientErr) {
    return NextResponse.json(
      { error: `supabase: ${clientErr.message}` },
      { status: 502 },
    );
  }
  const clients = (clientRows ?? []) as ClientRow[];

  if (body.action === "route") {
    const routed = routeUrls(body.urls ?? [], clients);
    return NextResponse.json({ routed });
  }

  if (body.action === "dispatch") {
    const clientById = new Map(clients.map((c) => [c.id, c]));
    const results: SubmissionOutcome[] = [];
    const nowIso = new Date().toISOString();

    for (const [clientId, urls] of Object.entries(body.urls_by_client ?? {})) {
      const client = clientById.get(clientId);
      if (!client) {
        for (const url of urls) {
          results.push({
            url,
            client_id: clientId,
            ok: false,
            message: "Client not found",
          });
        }
        continue;
      }

      for (const url of urls) {
        const outcome = await submitUrlForIndexing(url);
        const ok = outcome.ok;
        const message = ok ? "Submitted to Indexing API" : outcome.message;

        const existing = await sb
          .from("url_status")
          .select("submit_attempts,first_seen")
          .eq("client_id", clientId)
          .eq("url", url)
          .returns<{ submit_attempts: number | null; first_seen: string | null }[]>()
          .maybeSingle();

        const prevAttempts = existing.data?.submit_attempts ?? 0;
        const firstSeen =
          existing.data?.first_seen ?? new Date().toISOString().slice(0, 10);

        const upsertRow = {
          client_id: clientId,
          url,
          is_new: existing.data == null,
          indexed: null,
          last_checked: null,
          submitted: ok,
          last_submitted: ok ? nowIso : null,
          notes: message,
          first_seen: firstSeen,
          submit_attempts: prevAttempts + 1,
          source: "manual" as const,
        };
        const { error: upsertErr } = await sb
          .from("url_status")
          .upsert(upsertRow, { onConflict: "client_id,url" });
        if (upsertErr) {
          results.push({
            url,
            client_id: clientId,
            ok: false,
            message: `submit ok=${ok}, db error: ${upsertErr.message}`,
          });
          continue;
        }

        results.push({ url, client_id: clientId, ok, message });
      }
    }

    return NextResponse.json({ results });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
