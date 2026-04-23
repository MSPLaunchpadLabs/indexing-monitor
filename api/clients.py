"""GET /api/clients  — list every client + aggregate stats for the dashboard.
POST /api/clients — create a new client.

Shape matches the original Streamlit list view so the front-end can render
the stats strip and client cards without extra round trips.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

from _http import (
    error_response,
    handle_options,
    read_json_body,
    send_json,
)
from _supabase import Supabase, SupabaseError, eq


SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(name: str) -> str:
    slug = SLUG_RE.sub("-", name.lower()).strip("-")
    return slug or "client"


def normalize_website(raw: str) -> str:
    website = raw.strip()
    if not website.startswith(("http://", "https://")):
        website = "https://" + website
    return website


def domain_of(website: str) -> str:
    parsed = urlparse(website)
    return parsed.netloc or website


# ---------------------------------------------------------------------------
# GET — list with stats
# ---------------------------------------------------------------------------
def list_clients(sb: Supabase) -> dict:
    clients = sb.select("clients", order="name.asc")
    if not clients:
        return {
            "clients": [],
            "dashboard": {
                "total_clients": 0,
                "urls_tracked": 0,
                "indexed": 0,
                "active_runs": 0,
            },
        }

    # Pull every run for these clients — at 4 clients × ~5 runs each this
    # stays well under a kilobyte. If run history ever exceeds a few dozen
    # per client, switch to per-client .limit(1) calls in parallel.
    client_ids = [c["id"] for c in clients]
    runs = sb.select(
        "runs",
        columns=(
            "id,client_id,status,started_at,finished_at,total,current,pct,"
            "indexed_count,not_indexed_count,submitted_count,error"
        ),
        filters={"client_id": f"in.({','.join(client_ids)})"},
        order="started_at.desc",
    )

    # Group by client, keeping the most recent done run and any in-flight run.
    latest_done: dict[str, dict] = {}
    current_run: dict[str, dict] = {}
    for r in runs:
        cid = r["client_id"]
        if r["status"] == "running" and cid not in current_run:
            current_run[cid] = r
        if r["status"] == "done" and cid not in latest_done:
            latest_done[cid] = r

    out_clients = []
    urls_total = 0
    indexed_total = 0

    for c in clients:
        cid = c["id"]
        done = latest_done.get(cid)
        running = current_run.get(cid)

        stats = None
        last_run_at = None
        if done:
            total = (done.get("indexed_count", 0) or 0) + (done.get("not_indexed_count", 0) or 0)
            stats = {
                "total": total,
                "indexed": done.get("indexed_count", 0) or 0,
                "not_indexed": done.get("not_indexed_count", 0) or 0,
                "submitted": done.get("submitted_count", 0) or 0,
            }
            urls_total += stats["total"]
            indexed_total += stats["indexed"]
            last_run_at = done.get("finished_at") or done.get("started_at")

        out_clients.append({
            "id": cid,
            "name": c["name"],
            "domain": c["domain"],
            "sitemap_url": c["sitemap_url"],
            "gsc_site_url": c["gsc_site_url"],
            "created_at": c.get("created_at"),
            "stats": stats,
            "last_run_at": last_run_at,
            "current_run": (
                {
                    "id": running["id"],
                    "status": running["status"],
                    "current": running.get("current", 0) or 0,
                    "total": running.get("total", 0) or 0,
                    "pct": float(running.get("pct") or 0),
                    "started_at": running.get("started_at"),
                }
                if running
                else None
            ),
        })

    return {
        "clients": out_clients,
        "dashboard": {
            "total_clients": len(clients),
            "urls_tracked": urls_total,
            "indexed": indexed_total,
            "active_runs": len(current_run),
        },
    }


# ---------------------------------------------------------------------------
# POST — create client
# ---------------------------------------------------------------------------
def create_client(sb: Supabase, body: dict) -> tuple[int, dict]:
    name = (body.get("name") or "").strip()
    website_raw = (body.get("website") or body.get("domain") or "").strip()
    sitemap_url = (body.get("sitemap_url") or "").strip()
    gsc_site_url = (body.get("gsc_site_url") or "").strip()

    if not name or not website_raw:
        return 400, {"error": "name and website are required"}

    website = normalize_website(website_raw)
    domain = domain_of(website)

    if not sitemap_url:
        sitemap_url = website.rstrip("/") + "/sitemap.xml"
    if not gsc_site_url:
        gsc_site_url = website if website.endswith("/") else website + "/"

    existing = sb.select("clients", columns="id", order="id.asc")
    taken = {c["id"] for c in existing}
    base = slugify(name)
    new_id = base
    n = 1
    while new_id in taken:
        n += 1
        new_id = f"{base}-{n}"

    row = {
        "id": new_id,
        "name": name,
        "domain": domain,
        "sitemap_url": sitemap_url,
        "gsc_site_url": gsc_site_url,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    sb.insert("clients", row, return_rows=False)
    return 201, {"client": row}


# ---------------------------------------------------------------------------
# Vercel handler
# ---------------------------------------------------------------------------
class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            sb = Supabase()
            send_json(self, 200, list_clients(sb))
        except SupabaseError as e:
            error_response(self, 502, f"supabase: {e}")
        except Exception as e:
            error_response(self, 500, f"server error: {e}")

    def do_POST(self):
        try:
            body = read_json_body(self)
            sb = Supabase()
            status, payload = create_client(sb, body)
            send_json(self, status, payload)
        except SupabaseError as e:
            error_response(self, 502, f"supabase: {e}")
        except Exception as e:
            error_response(self, 500, f"server error: {e}")

    def do_OPTIONS(self):
        handle_options(self)

    # Silence default access-log; Vercel captures stdout separately.
    def log_message(self, format, *args):
        pass
