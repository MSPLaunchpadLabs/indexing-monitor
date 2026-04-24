import "server-only";

const GITHUB_API = "https://api.github.com";

type DispatchEnv = {
  owner: string;
  repo: string;
  token: string;
  workflow: string;
  ref: string;
};

function readEnv(): DispatchEnv {
  const owner = (process.env.GITHUB_REPO_OWNER ?? "").trim();
  const repo = (process.env.GITHUB_REPO_NAME ?? "").trim();
  const token = (process.env.GITHUB_DISPATCH_TOKEN ?? "").trim();
  const workflow = (process.env.GITHUB_WORKFLOW ?? "indexing-monitor.yml").trim();
  const ref = (process.env.GITHUB_REF ?? "main").trim() || "main";

  const missing: string[] = [];
  if (!owner) missing.push("GITHUB_REPO_OWNER");
  if (!repo) missing.push("GITHUB_REPO_NAME");
  if (!token) missing.push("GITHUB_DISPATCH_TOKEN");
  if (missing.length) {
    throw new Error(
      `Missing GitHub env vars: ${missing.join(", ")}. Add them in the Vercel project settings.`,
    );
  }
  return { owner, repo, token, workflow, ref };
}

/**
 * Fire a GitHub Actions `workflow_dispatch` event for the indexing engine.
 * The workflow reads `client_id` and `run_id` from `inputs` and runs
 * `python -m engine.runner <client_id> <run_id>`. GitHub returns 204 No Content
 * on success and a JSON error body on failure.
 */
export async function dispatchIndexingRun(
  clientId: string,
  runId: string,
): Promise<void> {
  const cfg = readEnv();
  const url = `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${cfg.workflow}/dispatches`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: cfg.ref,
      inputs: { client_id: clientId, run_id: runId },
    }),
    // GitHub dispatch is fast but not instant; 15s is generous.
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `GitHub dispatch failed ${resp.status}: ${body.slice(0, 400)}`,
    );
  }
}
