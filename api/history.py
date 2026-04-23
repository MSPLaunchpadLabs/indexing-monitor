"""GET /api/history?client_id=<client_id>

Returns every past run for a client, most-recent first. Powers the History tab.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler

from _http import error_response, handle_options, query_params, send_json
from _supabase import Supabase, SupabaseError, eq


def fetch_history(sb: Supabase, client_id: str, limit: int = 50) -> dict:
    runs = sb.select(
        "runs",
        columns=(
            "id,status,started_at,finished_at,total,current,pct,error,"
            "indexed_count,not_indexed_count,submitted_count"
        ),
        filters={"client_id": eq(client_id)},
        order="started_at.desc",
        limit=limit,
    )

    out = []
    for r in runs:
        total = (r.get("indexed_count", 0) or 0) + (r.get("not_indexed_count", 0) or 0)
        out.append({
            "id": r["id"],
            "status": r["status"],
            "started_at": r.get("started_at"),
            "finished_at": r.get("finished_at"),
            "error": r.get("error"),
            "stats": {
                "total": total,
                "indexed": r.get("indexed_count", 0) or 0,
                "not_indexed": r.get("not_indexed_count", 0) or 0,
                "submitted": r.get("submitted_count", 0) or 0,
            },
        })
    return {"runs": out}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            params = query_params(self)
            client_id = params.get("client_id", "").strip()
            if not client_id:
                error_response(self, 400, "query param 'client_id' is required")
                return
            sb = Supabase()
            send_json(self, 200, fetch_history(sb, client_id))
        except SupabaseError as e:
            error_response(self, 502, f"supabase: {e}")
        except Exception as e:
            error_response(self, 500, f"server error: {e}")

    def do_OPTIONS(self):
        handle_options(self)

    def log_message(self, format, *args):
        pass
