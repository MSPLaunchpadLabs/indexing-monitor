import "server-only";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Local-dev fallback for the "Start a new check" flow. In production we
 * dispatch a GitHub Actions workflow (see lib/github-dispatch.ts) because
 * the indexing check routinely takes 5–15 minutes — well past Vercel's 300s
 * function limit. Locally we want the button to "just work" without a PAT,
 * so we spawn `python -m engine.runner <clientId> <runId>` detached.
 *
 * The engine writes progress back to Supabase; the Next.js UI polls
 * /api/clients/[id]/run-status and never has to wait on this child.
 *
 * Not usable on Vercel (no Python runtime, no long-running background
 * processes). Callers should only fall back to this when GitHub dispatch
 * env vars are missing AND we're running locally.
 */

type SpawnedRun = { pid: number | null };

function pythonCommand(): string {
  const override = (process.env.PYTHON_CMD ?? "").trim();
  if (override) return override;
  // `py` is the Windows launcher; `python` works on Windows+mac+linux in most
  // dev envs. We prefer `python` because `py` isn't always present.
  return process.platform === "win32" ? "python" : "python3";
}

export function hasGithubDispatchCreds(): boolean {
  return Boolean(
    (process.env.GITHUB_REPO_OWNER ?? "").trim() &&
      (process.env.GITHUB_REPO_NAME ?? "").trim() &&
      (process.env.GITHUB_DISPATCH_TOKEN ?? "").trim(),
  );
}

export function canRunLocalFallback(): boolean {
  const cwd = process.cwd();
  return existsSync(path.join(cwd, "engine", "runner.py"));
}

export function spawnLocalRun(
  clientId: string,
  runId: string,
): SpawnedRun {
  const cmd = pythonCommand();
  const child = spawn(cmd, ["-m", "engine.runner", clientId, runId], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  // Let the parent Node process exit independently of the child. Without
  // unref() Next.js dev will wait on the child when it reloads.
  child.unref();
  return { pid: child.pid ?? null };
}
