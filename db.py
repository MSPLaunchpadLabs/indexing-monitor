"""
db.py — SQLite storage layer for indexing-monitor.

One row per URL, with its current indexing status and submission history.
No Google API code lives in this file — keeps it easy to test in isolation.
"""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

# ---------- Module-level config ----------

# Default DB path, overridable via INDEXING_DB_PATH env var for multi-client runs.
DB_FILENAME = os.getenv("INDEXING_DB_PATH", "indexing.db")
DEFAULT_COOLDOWN_HOURS = 48           # don't resubmit the same URL within this window
DEFAULT_MAX_ATTEMPTS = 5              # give up on a URL after this many submissions


# ---------- Timestamp helpers ----------
# All timestamps in the DB are ISO 8601 UTC strings. One format, one timezone.

def now_iso() -> str:
    """Current time as an ISO 8601 UTC string."""
    return datetime.now(timezone.utc).isoformat()


def today_iso() -> str:
    """Current date as 'YYYY-MM-DD' (UTC)."""
    return datetime.now(timezone.utc).date().isoformat()


# ---------- Schema ----------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS url_status (
    url             TEXT PRIMARY KEY,
    is_new          INTEGER NOT NULL DEFAULT 0,
    indexed         TEXT,
    last_checked    TEXT,
    submitted       INTEGER NOT NULL DEFAULT 0,
    last_submitted  TEXT,
    notes           TEXT,
    first_seen      TEXT NOT NULL,
    submit_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_url_status_indexed ON url_status (indexed);
"""


# ---------- Connection ----------

def connect(db_path: str | Path = DB_FILENAME) -> sqlite3.Connection:
    """
    Open a SQLite connection with sensible defaults:
      - row_factory = sqlite3.Row so we can access columns by name
      - busy_timeout = 30s so overlapping runs wait instead of crashing
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the table + index if they don't already exist. Idempotent."""
    conn.executescript(SCHEMA_SQL)
    conn.commit()


# ---------- Writes ----------

def reset_is_new_and_upsert_urls(
    conn: sqlite3.Connection,
    sitemap_urls: Iterable[str],
    today: str | None = None,
) -> int:
    """
    Start-of-run bookkeeping, done as a single transaction:
      1. Reset every row's `is_new` to 0.
      2. Insert any sitemap URLs we haven't seen before, with `is_new=1`
         and `first_seen=today`.
      3. Leave existing URLs alone — they keep their status and history.

    Returns the number of brand-new URLs discovered this run.

    The whole thing is one transaction so a crash mid-run can't leave
    every row at `is_new=0` with no new inserts.
    """
    if today is None:
        today = today_iso()

    # De-duplicate + trim whitespace defensively.
    urls = sorted({u.strip() for u in sitemap_urls if u and u.strip()})
    new_count = 0

    with conn:  # implicit BEGIN / COMMIT (ROLLBACK on exception)
        conn.execute("UPDATE url_status SET is_new = 0")
        for url in urls:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO url_status (url, is_new, first_seen)
                VALUES (?, 1, ?)
                """,
                (url, today),
            )
            if cursor.rowcount == 1:
                new_count += 1

    return new_count


def upsert_url(
    conn: sqlite3.Connection,
    url: str,
    today: str | None = None,
) -> bool:
    """
    Make sure a single URL has a row in the table. Used by the `check` command
    (which operates on one URL at a time and must NOT touch other rows' is_new).

    Returns True if the URL was brand new, False if it was already tracked.
    """
    if today is None:
        today = today_iso()
    with conn:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO url_status (url, is_new, first_seen) VALUES (?, 0, ?)",
            (url, today),
        )
        return cursor.rowcount == 1


def record_inspection(
    conn: sqlite3.Connection,
    url: str,
    indexed: bool | None,
    notes: str | None = None,
) -> None:
    """
    Save the result of a URL Inspection API call.
      indexed=True  -> 'yes'
      indexed=False -> 'no'
      indexed=None  -> 'unknown' (e.g. API errored on this URL)
    """
    indexed_str = (
        "yes" if indexed is True
        else "no" if indexed is False
        else "unknown"
    )
    with conn:
        conn.execute(
            """
            UPDATE url_status
               SET indexed = ?, last_checked = ?, notes = ?
             WHERE url = ?
            """,
            (indexed_str, now_iso(), notes, url),
        )


def record_submission(conn: sqlite3.Connection, url: str) -> None:
    """
    Record that we just submitted this URL to the Indexing API.
    Bumps submit_attempts so the attempts cap actually bites.
    """
    with conn:
        conn.execute(
            """
            UPDATE url_status
               SET submitted = 1,
                   last_submitted = ?,
                   submit_attempts = submit_attempts + 1
             WHERE url = ?
            """,
            (now_iso(), url),
        )


def set_note(conn: sqlite3.Connection, url: str, note: str) -> None:
    """Replace the `notes` field for a URL (e.g. 'deferred: daily quota')."""
    with conn:
        conn.execute(
            "UPDATE url_status SET notes = ? WHERE url = ?",
            (note, url),
        )


# ---------- Reads ----------

def should_submit(
    conn: sqlite3.Connection,
    url: str,
    cooldown_hours: int = DEFAULT_COOLDOWN_HOURS,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> tuple[bool, str]:
    """
    Decide whether a URL is eligible for submission right now.
    Returns (eligible, reason). `reason` is human-readable when eligible=False.
    """
    row = conn.execute(
        "SELECT indexed, last_submitted, submit_attempts FROM url_status WHERE url = ?",
        (url,),
    ).fetchone()

    if row is None:
        return False, "URL not tracked in DB"

    if row["indexed"] == "yes":
        return False, "already indexed"

    if row["submit_attempts"] >= max_attempts:
        return False, f"hit max attempts ({max_attempts})"

    last = row["last_submitted"]
    if last:
        try:
            last_dt = datetime.fromisoformat(last)
            age = datetime.now(timezone.utc) - last_dt
            if age < timedelta(hours=cooldown_hours):
                remaining = timedelta(hours=cooldown_hours) - age
                hrs_left = int(remaining.total_seconds() / 3600)
                return False, f"in cooldown (~{hrs_left}h left)"
        except ValueError:
            # Malformed stored timestamp — treat as eligible rather than blocking.
            pass

    return True, ""


def read_all(conn: sqlite3.Connection) -> list[dict]:
    """Return every row in url_status as plain dicts, sorted by URL."""
    rows = conn.execute("SELECT * FROM url_status ORDER BY url").fetchall()
    return [dict(r) for r in rows]
