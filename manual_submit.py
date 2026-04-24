"""Manual URL submissions — paste a list of URLs, auto-route each to the
correct client's GSC property, submit via the Indexing API, and track the
results alongside the sitemap-driven runs.

The sitemap-driven flow lives in main.py / report.py and runs as a
subprocess because it takes minutes. Manual submissions are short (tens of
URLs, a second each), so we run them synchronously in the Streamlit thread.

Design notes
------------
- Shared storage: we reuse each client's `url_status` table and distinguish
  manual rows with a new `source` column ('manual' vs 'sitemap'). That way
  the per-month rollup is one SQL query and doesn't fight with the sitemap
  runner's writes.
- Schema migration is idempotent (safe to run on every app boot).
- URL → client matching is hostname-based, normalised ('www.' stripped,
  lowercased). Unknowns surface in the UI with a manual-assign dropdown so
  nothing is silently dropped.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# Schema migration
# ---------------------------------------------------------------------------
_URL_STATUS_DDL = """
CREATE TABLE IF NOT EXISTS url_status (
    url             TEXT PRIMARY KEY,
    is_new          INTEGER NOT NULL DEFAULT 0,
    indexed         TEXT,
    last_checked    TEXT,
    submitted       INTEGER NOT NULL DEFAULT 0,
    last_submitted  TEXT,
    notes           TEXT,
    first_seen      TEXT NOT NULL,
    submit_attempts INTEGER NOT NULL DEFAULT 0,
    source          TEXT NOT NULL DEFAULT 'sitemap'
)
"""


def ensure_schema(db_path: Path) -> None:
    """Create the url_status table if missing and add the `source` column
    on legacy DBs. Safe to call on every app boot."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(_URL_STATUS_DDL)
        cols = {row[1] for row in conn.execute("PRAGMA table_info(url_status)")}
        if "source" not in cols:
            conn.execute(
                "ALTER TABLE url_status ADD COLUMN source TEXT NOT NULL "
                "DEFAULT 'sitemap'"
            )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# URL → client matching
# ---------------------------------------------------------------------------
def _normalise_host(host: str | None) -> str:
    if not host:
        return ""
    host = host.lower().strip()
    return host[4:] if host.startswith("www.") else host


def _client_hosts(client) -> set[str]:
    """All hostnames that should route to this client, normalised."""
    hosts: set[str] = set()
    for field in ("sitemap_url", "gsc_site_url", "domain"):
        val = getattr(client, field, "") or ""
        if val.startswith("sc-domain:"):
            hosts.add(_normalise_host(val.split(":", 1)[1]))
            continue
        parsed = urlparse(val if "://" in val else "https://" + val)
        host = _normalise_host(parsed.hostname or "")
        if host:
            hosts.add(host)
    return hosts


@dataclass
class RoutedUrl:
    """One input URL, tagged with either a matched client_id or None."""
    url: str
    client_id: str | None   # None = unknown domain
    reason: str             # human-readable explanation


def route_urls(urls: list[str], clients: list) -> list[RoutedUrl]:
    """Tag each URL with the client whose domain it belongs to. Blanks and
    duplicates are dropped; invalid URLs are returned with client_id=None."""
    host_to_client: dict[str, str] = {}
    for c in clients:
        for h in _client_hosts(c):
            host_to_client[h] = c.id

    seen: set[str] = set()
    routed: list[RoutedUrl] = []
    for raw in urls:
        url = (raw or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)

        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            routed.append(RoutedUrl(url, None, "Not a valid URL"))
            continue

        host = _normalise_host(parsed.hostname)
        client_id = host_to_client.get(host)
        if client_id:
            routed.append(RoutedUrl(url, client_id, f"Matched {host}"))
        else:
            routed.append(RoutedUrl(url, None, f"Unknown domain: {host}"))
    return routed


# ---------------------------------------------------------------------------
# Submission
# ---------------------------------------------------------------------------
@dataclass
class SubmissionResult:
    url: str
    client_id: str
    ok: bool
    message: str


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def record_submission(
    db_path: Path,
    url: str,
    ok: bool,
    message: str,
) -> None:
    """Insert or update the url_status row for a manual submission."""
    ensure_schema(db_path)
    now = _now_iso()
    conn = sqlite3.connect(str(db_path))
    try:
        existing = conn.execute(
            "SELECT first_seen, submit_attempts FROM url_status WHERE url = ?",
            (url,),
        ).fetchone()

        if existing is None:
            conn.execute(
                """INSERT INTO url_status
                   (url, is_new, indexed, last_checked, submitted,
                    last_submitted, notes, first_seen, submit_attempts, source)
                   VALUES (?, 1, NULL, NULL, ?, ?, ?, ?, 1, 'manual')""",
                (url, 1 if ok else 0, now if ok else None, message, now),
            )
        else:
            first_seen, attempts = existing
            conn.execute(
                """UPDATE url_status
                   SET submitted       = CASE WHEN ? THEN 1 ELSE submitted END,
                       last_submitted  = CASE WHEN ? THEN ? ELSE last_submitted END,
                       notes           = ?,
                       submit_attempts = ?,
                       source          = 'manual'
                   WHERE url = ?""",
                (1 if ok else 0, 1 if ok else 0, now, message,
                 (attempts or 0) + 1, url),
            )
        conn.commit()
    finally:
        conn.close()


def update_index_status(
    db_path: Path,
    url: str,
    indexed: bool | None,
    reason: str,
) -> None:
    """Called by the Recheck button to refresh a URL's indexed state."""
    ensure_schema(db_path)
    conn = sqlite3.connect(str(db_path))
    try:
        indexed_str = (
            "true" if indexed is True
            else "false" if indexed is False
            else "unknown"
        )
        conn.execute(
            """UPDATE url_status
               SET indexed = ?, last_checked = ?, notes = ?
               WHERE url = ?""",
            (indexed_str, _now_iso(), reason, url),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Queries for the dashboard
# ---------------------------------------------------------------------------
def month_bounds(year: int, month: int) -> tuple[str, str]:
    """Return (start_iso, end_iso) for the given calendar month, UTC."""
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    return start.isoformat(), end.isoformat()


def monthly_summary(db_path: Path, year: int, month: int) -> dict:
    """Counts for the 'This Month' card: submitted, indexed, pending, failed."""
    if not db_path.exists():
        return {"submitted": 0, "indexed": 0, "pending": 0, "failed": 0}
    ensure_schema(db_path)
    start, end = month_bounds(year, month)
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.execute(
            """SELECT
                 SUM(CASE WHEN submitted = 1 THEN 1 ELSE 0 END),
                 SUM(CASE WHEN LOWER(COALESCE(indexed,'')) = 'true' THEN 1 ELSE 0 END),
                 SUM(CASE WHEN submitted = 1
                          AND LOWER(COALESCE(indexed,'')) NOT IN ('true','false')
                          THEN 1 ELSE 0 END),
                 SUM(CASE WHEN submitted = 0 THEN 1 ELSE 0 END)
               FROM url_status
               WHERE source = 'manual'
                 AND first_seen >= ? AND first_seen < ?""",
            (start, end),
        )
        s, i, p, f = cur.fetchone()
        return {
            "submitted": int(s or 0),
            "indexed": int(i or 0),
            "pending": int(p or 0),
            "failed": int(f or 0),
        }
    finally:
        conn.close()


def monthly_submissions(db_path: Path, year: int, month: int) -> list[dict]:
    """Detailed rows for the 'This Month' expandable table."""
    if not db_path.exists():
        return []
    ensure_schema(db_path)
    start, end = month_bounds(year, month)
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.execute(
            """SELECT url, submitted, last_submitted, indexed, last_checked,
                      notes, submit_attempts
               FROM url_status
               WHERE source = 'manual'
                 AND first_seen >= ? AND first_seen < ?
               ORDER BY last_submitted DESC, first_seen DESC""",
            (start, end),
        )
        rows = []
        for url, submitted, last_sub, indexed, last_chk, notes, attempts in cur:
            rows.append({
                "url": url,
                "submitted": bool(submitted),
                "submitted_at": last_sub or "",
                "indexed": (indexed or "").lower(),
                "last_checked": last_chk or "",
                "notes": notes or "",
                "attempts": attempts or 0,
            })
        return rows
    finally:
        conn.close()


def pending_urls(db_path: Path) -> list[str]:
    """All manual URLs whose indexed state hasn't been confirmed yet.
    Used by the Recheck button."""
    if not db_path.exists():
        return []
    ensure_schema(db_path)
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.execute(
            """SELECT url FROM url_status
               WHERE source = 'manual'
                 AND LOWER(COALESCE(indexed,'')) != 'true'"""
        )
        return [row[0] for row in cur]
    finally:
        conn.close()
