import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { dispatchIndexingRun } from "@/lib/github-dispatch";
import {
  canRunLocalFallback,
  hasGithubDispatchCreds,
  spawnLocalRun,
} from "@/lib/local-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/clients/[id]/run
 *
 * Creates a new `runs` row (status=running), then triggers the GitHub Actions
 * workflow that invokes `engine.runner`. Returns the run_id immediately so the
 * UI can start polling /run-status.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clientId = id.trim();
  if (!clientId) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const sb = supabase();

  const { data: client, error: clientErr } = await sb
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .returns<{ id: string }[]>()
    .maybeSingle();

  if (clientErr) {
    return NextResponse.json(
      { error: `supabase: ${clientErr.message}` },
      { status: 502 },
    );
  }
  if (!client) {
    return NextResponse.json(
      { error: `client "${clientId}" not found` },
      { status: 404 },
    );
  }

  const { data: existingRunning } = await sb
    .from("runs")
    .select("id")
    .eq("client_id", clientId)
    .eq("status", "running")
    .limit(1)
    .returns<{ id: string }[]>();

  if (existingRunning && existingRunning.length > 0) {
    return NextResponse.json(
      {
        error: "a run is already in progress for this client",
        run_id: existingRunning[0].id,
      },
      { status: 409 },
    );
  }

  const { data: created, error: createErr } = await sb
    .from("runs")
    .insert({
      client_id: clientId,
      status: "running",
      started_at: new Date().toISOString(),
      log_tail: ["queued · waiting for GitHub Actions runner"],
    })
    .select("id")
    .returns<{ id: string }[]>()
    .single();

  if (createErr || !created) {
    return NextResponse.json(
      { error: `failed to create run row: ${createErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  const runId = created.id;
  const useGithub = hasGithubDispatchCreds();
  const useLocal = !useGithub && canRunLocalFallback();

  try {
    if (useGithub) {
      await dispatchIndexingRun(clientId, runId);
    } else if (useLocal) {
      spawnLocalRun(clientId, runId);
      await sb
        .from("runs")
        .update({
          log_tail: ["queued · running locally (python -m engine.runner)"],
        })
        .eq("id", runId);
    } else {
      throw new Error(
        "No way to run: set GITHUB_* env vars for Actions dispatch, or run " +
          "from a checkout that has engine/runner.py for the local fallback.",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sb
      .from("runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: message.slice(0, 2000),
      })
      .eq("id", runId);
    return NextResponse.json(
      { error: `dispatch failed: ${message}`, run_id: runId },
      { status: 502 },
    );
  }

  return NextResponse.json(
    { run_id: runId, status: "queued", runner: useGithub ? "github" : "local" },
    { status: 202 },
  );
}
