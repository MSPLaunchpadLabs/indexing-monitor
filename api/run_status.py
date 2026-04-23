"""GET /api/run-status?client_id=<client_id>

Lightweight endpoint polled by the dashboard every ~2 seconds while a run is
active. Returns the live progress for the most recent run (running or done).
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler

from _http import error_response, handle_options, query_params, send_json
from _supabase import Supabase, SupabaseError, eq


def fetch_status(sb: Supabase, client_id: str) -> dict:
    runs = sb.select(
        "runs",
        columns=(
            "id,status,started_at,finished_at,total,current,pct,error,"
            "log_tail,indexed_count,not_indexed_count,submitted_count"
        ),
        filters={"client_id": eq(client_id)},
        order="started_at.desc",
        limit=1,
    )
    if not runs:
        return {"run": None}
    r = runs[0]
    total = (r.get("indexed_count", 0) or 0) + (r.get("not_indexed_count", 0) or 0)
    return {
        "run": {
            "id": r["id"],
            "status": r["status"],
            "started_at": r.get("started_at"),
            "finished_at": r.get("finished_at"),
            "total": r.get("total", 0) or 0,
            "current": r.get("current", 0) or 0,
            "pct": float(r.get("pct") or 0),
            "error": r.get("error"),
            "log_tail": r.get("log_tail") or [],
            "stats": {
                "total": total,
                "indexed": r.get("indexed_count", 0) or 0,
                "not_indexed": r.get("not_indexed_count", 0) or 0,
                "submitted": r.get("submitted_count", 0) or 0,
            },
        }
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            params = query_params(self)
            client_id = params.get("client_id", "").strip()
            if not client_id:
                error_response(self, 400, "query param 'client_id' is required")
                return
            sb = Supabase()
            send_json(self, 200, fetch_status(sb, client_id))
        except SupabaseError as e:
            error_response(self, 502, f"supabase: {e}")
        except Exception as e:
            error_response(self, 500, f"server error: {e}")

    def do_OPTIONS(self):
        handle_options(self)

    def log_message(self, format, *args):
        pass
