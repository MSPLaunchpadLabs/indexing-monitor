"""POST /api/run  { "client_id": "..." }

Creates a new `runs` row in Supabase (status=running, pct=0), then triggers a
GitHub Actions `workflow_dispatch` passing both `client_id` and `run_id` as
inputs. Returns the run_id immediately so the dashboard can start polling
/api/run-status.

Env vars consumed:
    GITHUB_REPO_OWNER      — e.g. "msplaunchpad"
    GITHUB_REPO_NAME       — e.g. "indexing-monitor"
    GITHUB_DISPATCH_TOKEN  — PAT (classic) with `actions:write` + `contents:read`,
                              or a fine-grained PAT scoped to this repo with the
                              Actions (write) + Metadata (read) permissions.
    GITHUB_WORKFLOW        — workflow filename or ID (default: "indexing-monitor.yml")
    GITHUB_REF             — branch to dispatch against (default: "main")
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

from _http import error_response, handle_options, read_json_body, send_json
from _supabase import Supabase, SupabaseError, eq


GITHUB_API = "https://api.github.com"


def _github_env() -> dict:
    owner = os.environ.get("GITHUB_REPO_OWNER", "").strip()
    repo = os.environ.get("GITHUB_REPO_NAME", "").strip()
    token = os.environ.get("GITHUB_DISPATCH_TOKEN", "").strip()
    workflow = os.environ.get("GITHUB_WORKFLOW", "indexing-monitor.yml").strip()
    ref = os.environ.get("GITHUB_REF", "main").strip() or "main"
    missing = [n for n, v in [
        ("GITHUB_REPO_OWNER", owner),
        ("GITHUB_REPO_NAME", repo),
        ("GITHUB_DISPATCH_TOKEN", token),
    ] if not v]
    if missing:
        raise RuntimeError(
            f"Missing GitHub env vars: {', '.join(missing)}. "
            "Add them in the Vercel project settings."
        )
    return {"owner": owner, "repo": repo, "token": token, "workflow": workflow, "ref": ref}


def dispatch_workflow(client_id: str, run_id: str) -> None:
    cfg = _github_env()
    url = (
        f"{GITHUB_API}/repos/{cfg['owner']}/{cfg['repo']}"
        f"/actions/workflows/{cfg['workflow']}/dispatches"
    )
    payload = {
        "ref": cfg["ref"],
        "inputs": {"client_id": client_id, "run_id": run_id},
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {cfg['token']}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub dispatch failed {e.code}: {raw[:400]}") from e


def trigger_run(sb: Supabase, client_id: str) -> tuple[int, dict]:
    clients = sb.select("clients", columns="id", filters={"id": eq(client_id)}, limit=1)
    if not clients:
        return 404, {"error": f"client {client_id!r} not found"}

    existing_running = sb.select(
        "runs",
        columns="id",
        filters={"client_id": eq(client_id), "status": "eq.running"},
        limit=1,
    )
    if existing_running:
        return 409, {
            "error": "a run is already in progress for this client",
            "run_id": existing_running[0]["id"],
        }

    created = sb.insert(
        "runs",
        {
            "client_id": client_id,
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "log_tail": ["queued · waiting for GitHub Actions runner"],
        },
    )
    if not created:
        return 500, {"error": "failed to create run row"}
    run_id = created[0]["id"]

    try:
        dispatch_workflow(client_id, run_id)
    except Exception as exc:
        # Roll back the runs row to 'failed' so the dashboard doesn't spin.
        sb.update(
            "runs",
            filters={"id": eq(run_id)},
            values={
                "status": "failed",
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "error": str(exc)[:2000],
            },
            return_rows=False,
        )
        return 502, {"error": f"dispatch failed: {exc}", "run_id": run_id}

    return 202, {"run_id": run_id, "status": "queued"}


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            body = read_json_body(self)
            client_id = (body.get("client_id") or "").strip()
            if not client_id:
                error_response(self, 400, "body must include 'client_id'")
                return
            sb = Supabase()
            status, payload = trigger_run(sb, client_id)
            send_json(self, status, payload)
        except SupabaseError as e:
            error_response(self, 502, f"supabase: {e}")
        except Exception as e:
            error_response(self, 500, f"server error: {e}")

    def do_OPTIONS(self):
        handle_options(self)

    def log_message(self, format, *args):
        pass
