"""GET /api/run-csv?run_id=<uuid>

Streams the per-URL snapshot of a finished run as a CSV download. Column order
matches the original report.py so files are drop-in compatible.
"""
from __future__ import annotations

import csv
import io
from http.server import BaseHTTPRequestHandler

from _http import error_response, handle_options, query_params, send_csv
from _supabase import Supabase, SupabaseError, eq


CSV_COLUMNS = [
    "url",
    "is_new",
    "indexed",
    "last_checked",
    "submitted",
    "last_submitted",
    "notes",
    "first_seen",
    "submit_attempts",
]


def build_csv(sb: Supabase, run_id: str) -> tuple[int, str, str]:
    runs = sb.select(
        "runs",
        columns="id,client_id,started_at",
        filters={"id": eq(run_id)},
        limit=1,
    )
    if not runs:
        return 404, "", ""

    rows = sb.select(
        "run_urls",
        filters={"run_id": eq(run_id)},
        order="url.asc",
    )

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow({
            "url": r.get("url", ""),
            "is_new": 1 if r.get("is_new") else 0,
            "indexed": r.get("indexed") or "",
            "last_checked": r.get("last_checked") or "",
            "submitted": 1 if r.get("submitted") else 0,
            "last_submitted": r.get("last_submitted") or "",
            "notes": r.get("notes") or "",
            "first_seen": r.get("first_seen") or "",
            "submit_attempts": r.get("submit_attempts") or 0,
        })

    started = (runs[0].get("started_at") or "").split("T")[0] or "run"
    filename = f"{runs[0]['client_id']}-{started}.csv"
    return 200, buf.getvalue(), filename


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            params = query_params(self)
            run_id = params.get("run_id", "").strip()
            if not run_id:
                error_response(self, 400, "query param 'run_id' is required")
                return
            sb = Supabase()
            status, body, filename = build_csv(sb, run_id)
            if status != 200:
                error_response(self, status, "run not found")
                return
            send_csv(self, body, filename)
        except SupabaseError as e:
            error_response(self, 502, f"supabase: {e}")
        except Exception as e:
            error_response(self, 500, f"server error: {e}")

    def do_OPTIONS(self):
        handle_options(self)

    def log_message(self, format, *args):
        pass
