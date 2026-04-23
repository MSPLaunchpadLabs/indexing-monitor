"""
One-shot migration: SQLite (data/*.db + clients.json) -> Supabase.

Usage:
    # from the indexing-monitor/ folder, after setting env vars:
    #   SUPABASE_URL, SUPABASE_SECRET
    python -m scripts.migrate_sqlite_to_supabase

What it does:
    1. Reads clients.json and upserts each client into public.clients.
    2. For each client, opens data/<id>.db and copies every row of
       url_status into public.url_status with client_id attached.
    3. Timestamps already stored as ISO-8601 UTC strings in SQLite pass
       straight through — Postgres' timestamptz parses them as-is.
       `first_seen` (a date in Supabase) is truncated to YYYY-MM-DD.

Safe to re-run: uses upsert on (id) for clients and (client_id, url) for
url_status, so repeat runs are idempotent.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

# Make the sibling api/ package importable when run as `python -m scripts.*`.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api._supabase import Supabase  # noqa: E402


CLIENTS_JSON = ROOT / "clients.json"
DATA_DIR = ROOT / "data"


def load_clients() -> list[dict]:
    with CLIENTS_JSON.open("r", encoding="utf-8") as f:
        return json.load(f)["clients"]


def migrate_clients(sb: Supabase, clients: list[dict]) -> None:
    rows = [
        {
            "id":           c["id"],
            "name":         c["name"],
            "domain":       c["domain"],
            "sitemap_url":  c["sitemap_url"],
            "gsc_site_url": c["gsc_site_url"],
            # created_at: let Supabase default fire when present, else pass through.
            **({"created_at": c["created_at"]} if c.get("created_at") else {}),
        }
        for c in clients
    ]
    sb.upsert("clients", rows, on_conflict="id")
    print(f"  clients: upserted {len(rows)}")


def migrate_url_status_for(sb: Supabase, client_id: str) -> None:
    db_path = DATA_DIR / f"{client_id}.db"
    if not db_path.exists():
        print(f"  {client_id}: no DB at {db_path}, skipping")
        return

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("SELECT * FROM url_status").fetchall()
    except sqlite3.OperationalError as e:
        print(f"  {client_id}: could not read url_status ({e}), skipping")
        conn.close()
        return
    conn.close()

    out: list[dict] = []
    for r in rows:
        first_seen = r["first_seen"] or ""
        # first_seen may be either 'YYYY-MM-DD' or an ISO timestamp; slice to date.
        first_seen_date = first_seen[:10] if first_seen else None
        out.append({
            "client_id":       client_id,
            "url":             r["url"],
            "is_new":          bool(r["is_new"]),
            "indexed":         r["indexed"],
            "last_checked":    r["last_checked"],
            "submitted":       bool(r["submitted"]),
            "last_submitted":  r["last_submitted"],
            "notes":           r["notes"],
            "first_seen":      first_seen_date,
            "submit_attempts": int(r["submit_attempts"] or 0),
        })

    if not out:
        print(f"  {client_id}: 0 rows")
        return

    sb.chunked_upsert("url_status", out, on_conflict="client_id,url", chunk_size=500)
    print(f"  {client_id}: upserted {len(out)} url_status rows")


def main() -> int:
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SECRET"):
        print("ERROR: set SUPABASE_URL and SUPABASE_SECRET before running.")
        return 1

    sb = Supabase()
    clients = load_clients()

    print(f"Migrating {len(clients)} client(s) from {CLIENTS_JSON.name} ...")
    migrate_clients(sb, clients)

    print("\nMigrating url_status tables ...")
    for c in clients:
        migrate_url_status_for(sb, c["id"])

    print("\nDone. Verify in Supabase dashboard:")
    print("  select count(*) from clients;")
    print("  select client_id, count(*) from url_status group by client_id;")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
