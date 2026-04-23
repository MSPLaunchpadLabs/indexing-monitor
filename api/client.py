"""GET /api/client?id=<client_id>

Detail-view payload: the client record, the latest completed run's summary
(metrics strip), and the "why URLs are not indexed" reason breakdown pulled
from that run's snapshot.
"""
from __future__ import annotations

from collections import Counter
from http.server import BaseHTTPRequestHandler

from _http import error_response, handle_options, query_params, send_json
from _supabase import Supabase, SupabaseError, eq


def fetch_detail(sb: Supabase, client_id: str) -> tuple[int, dict]:
    clients = sb.select("clients", filters={"id": eq(client_id)}, limit=1)
    if not clients:
        return 404, {"error": f"client {client_id!r} not found"}
    client = clients[0]

    runs = sb.select(
        "runs",
        columns=(
            "id,status,started_at,finished_at,total,current,pct,error,"
            "indexed_count,not_indexed_count,submitted_count"
        ),
        filters={"client_id": eq(client_id)},
        order="started_at.desc",
        limit=5,
    )

    latest_done = next((r for r in runs if r["status"] == "done"), None)
    current = next((r for r in runs if r["status"] == "running"), None)

    stats = None
    reason_breakdown: list[dict] = []
    if latest_done:
        total = (latest_done.get("indexed_count", 0) or 0) + (
            latest_done.get("not_indexed_count", 0) or 0
        )
        stats = {
            "total": total,
            "indexed": latest_done.get("indexed_count", 0) or 0,
            "not_indexed": latest_done.get("not_indexed_count", 0) or 0,
            "submitted": latest_done.get("submitted_count", 0) or 0,
        }

        if stats["not_indexed"] > 0:
            not_indexed_urls = sb.select(
                "run_urls",
                columns="notes",
                filters={
                    "run_id": eq(latest_done["id"]),
                    "indexed": "eq.no",
                },
            )
            counter = Counter(
                (r.get("notes") or "(no reason listed)") for r in not_indexed_urls
            )
            reason_breakdown = [
                {"reason": r, "count": c}
                for r, c in counter.most_common()
            ]

    return 200, {
        "client": client,
        "stats": stats,
        "last_run_at": (latest_done or {}).get("finished_at")
            or (latest_done or {}).get("started_at"),
        "reason_breakdown": reason_breakdown,
        "current_run": (
            {
                "id": current["id"],
                "status": current["status"],
                "current": current.get("current", 0) or 0,
                "total": current.get("total", 0) or 0,
                "pct": float(current.get("pct") or 0),
                "started_at": current.get("started_at"),
            }
            if current
            else None
        ),
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            params = query_params(self)
            client_id = params.get("id", "").strip()
            if not client_id:
                error_response(self, 400, "query param 'id' is required")
                return
            sb = Supabase()
            status, payload = fetch_detail(sb, client_id)
            send_json(self, status, payload)
        except SupabaseError as e:
            error_response(self, 502, f"supabase: {e}")
        except Exception as e:
            error_response(self, 500, f"server error: {e}")

    def do_OPTIONS(self):
        handle_options(self)

    def log_message(self, format, *args):
        pass
