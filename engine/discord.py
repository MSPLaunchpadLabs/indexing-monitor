"""Run-completion notifications to Discord via webhook.

Called from RunContext.finish() so every completion path (success or
failure) emits exactly one message. Two routes:

  · DISCORD_WEBHOOK_URL          — the "ops" channel; success messages
                                   AND the daily roll-up post here.
  · DISCORD_ERROR_WEBHOOK_URL    — the "alerts" channel; failures only.
                                   Falls back to the main webhook when
                                   unset, so you can opt-in incrementally.

Best-effort: a webhook failure logs a warning but never breaks the run.

Why urllib instead of requests: matches engine/_supabase.py — keeps the
GHA install footprint small and avoids one more transitive dep.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DASHBOARD_BASE = "https://indexing-monitor.vercel.app"
COLOR_SUCCESS = 0x22C55E  # tailwind emerald-500 — matches our success pill
COLOR_FAILURE = 0xEF4444  # tailwind red-500 — matches our danger pill
WEBHOOK_TIMEOUT_SECONDS = 10


def notify_run_complete(
    *,
    client_id: str,
    client_name: str,
    status: str,
    total: int,
    indexed: int,
    not_indexed: int,
    submitted: int,
    duration_seconds: float,
    error: str | None = None,
    webhook_url: str | None = None,
) -> None:
    """POST one Discord embed describing the finished run.

    Never raises. If neither webhook is configured, returns silently —
    that's the documented way to opt out. Failures route to
    DISCORD_ERROR_WEBHOOK_URL when set, otherwise fall back to the main
    webhook so an unconfigured error channel doesn't lose the alert.
    """
    is_success = status == "done"

    success_url = (
        webhook_url or os.environ.get("DISCORD_WEBHOOK_URL", "")
    ).strip()
    error_url = os.environ.get("DISCORD_ERROR_WEBHOOK_URL", "").strip()
    target_url = success_url if is_success else (error_url or success_url)
    if not target_url:
        return

    title_text = "complete" if is_success else "FAILED"
    fields = [
        {"name": "Status", "value": status, "inline": True},
        {
            "name": "Duration",
            "value": _fmt_duration(duration_seconds),
            "inline": True,
        },
        {"name": "Total tracked", "value": str(total), "inline": True},
        {"name": "Indexed", "value": str(indexed), "inline": True},
        {"name": "Not Indexed", "value": str(not_indexed), "inline": True},
        {
            "name": "Submitted to Indexing API",
            "value": str(submitted),
            "inline": True,
        },
    ]

    embed: dict = {
        "title": f"Indexing run {title_text} · {client_name}",
        "color": COLOR_SUCCESS if is_success else COLOR_FAILURE,
        "url": f"{DASHBOARD_BASE}/clients/{client_id}",
        "fields": fields,
    }
    if error and not is_success:
        # Discord embed.description has a 4096-char cap; we keep it short to
        # surface the headline without flooding the channel.
        embed["description"] = f"```\n{error[:500]}\n```"

    payload = {"username": "Indexing Monitor", "embeds": [embed]}

    try:
        req = urllib.request.Request(
            target_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=WEBHOOK_TIMEOUT_SECONDS) as resp:
            resp.read()
    except (urllib.error.URLError, OSError) as exc:
        print(f"[warn] discord notify failed: {exc}", flush=True)


def _fmt_duration(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m"
