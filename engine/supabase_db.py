"""Supabase-backed storage layer.

Mirrors the surface of the original ``db.py`` but talks to Postgres via
PostgREST instead of a local SQLite file. Used by ``engine.runner`` in GitHub
Actions — the legacy ``db.py`` stays untouched for local CLI use.

All queries are scoped by ``client_id`` so multi-tenant writes never cross
over. The caller holds a ``Supabase`` instance and passes it into every
function; that's the unit under test as well.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable

from api._supabase import Supabase, eq


DEFAULT_COOLDOWN_HOURS = 48
DEFAULT_MAX_ATTEMPTS = 5


# ---------- Timestamps ----------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today_iso() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# ---------- Client ----------

def get_client(sb: Supabase, client_id: str) -> dict | None:
    rows = sb.select("clients", filters={"id": eq(client_id)}, limit=1)
    return rows[0] if rows else None


# ---------- Writes ----------

def reset_is_new_and_upsert_urls(
    sb: Supabase,
    client_id: str,
    sitemap_urls: Iterable[str],
    today: str | None = None,
) -> list[str]:
    """Mirror of db.reset_is_new_and_upsert_urls for the Supabase backend.

    1. Flip is_new=false for every existing row in this client's url_status.
    2. Upsert every sitemap URL. Existing rows preserve their data; new rows
       get is_new=true and first_seen=today.

    Returns the list of newly inserted URLs (sorted) so the caller can
    prioritize them when submitting to the Indexing API.

    PostgREST doesn't give us a direct "insert-or-ignore + count new" in one
    request, so we do: (1) fetch existing URL set, (2) update is_new=false,
    (3) upsert all current URLs (existing stay unchanged on conflict where we
    merge only new fields, new rows carry is_new=true).
    """
    if today is None:
        today = today_iso()

    urls = sorted({u.strip() for u in sitemap_urls if u and u.strip()})
    if not urls:
        return []

    # (1) What URLs do we already have tracked for this client?
    existing_rows = sb.select(
        "url_status",
        columns="url",
        filters={"client_id": eq(client_id)},
    )
    existing = {r["url"] for r in existing_rows}
    new_urls = [u for u in urls if u not in existing]

    # (2) Reset is_new for every existing row. Done even if no new URLs so a
    #     URL that was "new" last run flips back to "seen before".
    if existing:
        sb.update(
            "url_status",
            filters={"client_id": eq(client_id)},
            values={"is_new": False},
            return_rows=False,
        )

    # (3) Insert the brand-new URLs. We use insert (not upsert) because we
    #     already know these don't exist; upsert would require us to enumerate
    #     full row values for the conflict path.
    if new_urls:
        sb.insert(
            "url_status",
            [
                {
                    "client_id": client_id,
                    "url": u,
                    "is_new": True,
                    "first_seen": today,
                }
                for u in new_urls
            ],
            return_rows=False,
        )

    return new_urls


def record_inspection(
    sb: Supabase,
    client_id: str,
    url: str,
    indexed: bool | None,
    notes: str | None = None,
) -> None:
    """Save the result of a URL Inspection API call. Matches db.record_inspection."""
    indexed_str = (
        "yes" if indexed is True
        else "no" if indexed is False
        else "unknown"
    )
    sb.update(
        "url_status",
        filters={"client_id": eq(client_id), "url": eq(url)},
        values={
            "indexed": indexed_str,
            "last_checked": now_iso(),
            "notes": notes,
        },
        return_rows=False,
    )


def record_submission(sb: Supabase, client_id: str, url: str) -> None:
    """Bump attempts + mark submitted. Matches db.record_submission.

    PostgREST doesn't support `col = col + 1` in PATCH, so we do a read-then-
    write. Race-safe enough for our use case: a single runner per client.
    """
    rows = sb.select(
        "url_status",
        columns="submit_attempts",
        filters={"client_id": eq(client_id), "url": eq(url)},
        limit=1,
    )
    attempts = (rows[0]["submit_attempts"] if rows else 0) + 1
    sb.update(
        "url_status",
        filters={"client_id": eq(client_id), "url": eq(url)},
        values={
            "submitted": True,
            "last_submitted": now_iso(),
            "submit_attempts": attempts,
        },
        return_rows=False,
    )


def set_note(sb: Supabase, client_id: str, url: str, note: str) -> None:
    sb.update(
        "url_status",
        filters={"client_id": eq(client_id), "url": eq(url)},
        values={"notes": note},
        return_rows=False,
    )


# ---------- Reads ----------

def should_submit(
    sb: Supabase,
    client_id: str,
    url: str,
    *,
    cooldown_hours: int = DEFAULT_COOLDOWN_HOURS,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> tuple[bool, str]:
    """Decide whether a URL is eligible for submission. Mirrors db.should_submit."""
    rows = sb.select(
        "url_status",
        columns="indexed,last_submitted,submit_attempts",
        filters={"client_id": eq(client_id), "url": eq(url)},
        limit=1,
    )
    if not rows:
        return False, "URL not tracked in DB"
    row = rows[0]

    if row.get("indexed") == "yes":
        return False, "already indexed"

    if (row.get("submit_attempts") or 0) >= max_attempts:
        return False, f"hit max attempts ({max_attempts})"

    last = row.get("last_submitted")
    if last:
        try:
            # Postgres returns timestamptz like "2026-04-22T06:00:00+00:00"
            last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
            age = datetime.now(timezone.utc) - last_dt
            if age < timedelta(hours=cooldown_hours):
                remaining = timedelta(hours=cooldown_hours) - age
                hrs_left = int(remaining.total_seconds() / 3600)
                return False, f"in cooldown (~{hrs_left}h left)"
        except ValueError:
            pass

    return True, ""


def read_all(sb: Supabase, client_id: str) -> list[dict]:
    """Return every url_status row for this client, sorted by URL."""
    return sb.select(
        "url_status",
        filters={"client_id": eq(client_id)},
        order="url.asc",
    )


# ---------- Run snapshot ----------

def snapshot_run(sb: Supabase, run_id: str, client_id: str) -> None:
    """After a run finishes, copy every current url_status row into run_urls
    so History can show per-run detail and CSV download. Idempotent — delete
    any existing rows for this run first."""
    sb.delete("run_urls", filters={"run_id": eq(run_id)})

    rows = read_all(sb, client_id)
    if not rows:
        return

    snapshot = [
        {
            "run_id": run_id,
            "url": r["url"],
            "is_new": r.get("is_new", False),
            "indexed": r.get("indexed"),
            "last_checked": r.get("last_checked"),
            "submitted": r.get("submitted", False),
            "last_submitted": r.get("last_submitted"),
            "notes": r.get("notes"),
            "first_seen": r.get("first_seen"),
            "submit_attempts": r.get("submit_attempts", 0),
        }
        for r in rows
    ]
    sb.chunked_upsert("run_urls", snapshot, on_conflict="run_id,url", chunk_size=500)
