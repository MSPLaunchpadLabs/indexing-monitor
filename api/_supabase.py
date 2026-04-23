"""Thin Supabase PostgREST client used by both Vercel API functions and the
GitHub Actions engine runner.

Why not supabase-py: that SDK pulls in gotrue, realtime, storage3 and
postgrest-py (~15MB total). We only need CRUD against public schema tables,
which is a plain HTTP call. Keeping this light keeps Vercel cold starts fast
and avoids surprising transitive deps.

Auth: service_role key (bypasses RLS). Never ship this key to the browser.
"""
from __future__ import annotations

import json
import os
from typing import Any, Iterable
from urllib.parse import quote, urlencode

import urllib.request
import urllib.error


class SupabaseError(RuntimeError):
    """PostgREST returned a non-2xx status. `.status` + `.body` for debugging."""

    def __init__(self, status: int, body: str):
        super().__init__(f"Supabase {status}: {body[:400]}")
        self.status = status
        self.body = body


class Supabase:
    """Minimal PostgREST client. One instance per process is fine."""

    def __init__(self, url: str | None = None, key: str | None = None, timeout: int = 20):
        base = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        self.key = key or os.environ.get("SUPABASE_SECRET", "")
        if not base or not self.key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SECRET must be set. "
                "Use the service_role key (server-side only)."
            )
        self.rest = f"{base}/rest/v1"
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Core request helper
    # ------------------------------------------------------------------
    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        body: Any = None,
        prefer: str | None = None,
    ) -> Any:
        url = f"{self.rest}/{path}"
        if params:
            # PostgREST needs filter values URL-encoded exactly as written;
            # urlencode handles that. Multi-value keys (rare here) aren't needed.
            url = f"{url}?{urlencode(params, safe='().,*:')}"

        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer

        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise SupabaseError(e.code, raw) from e

        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------
    def select(
        self,
        table: str,
        *,
        columns: str = "*",
        filters: dict[str, str] | None = None,
        order: str | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        """SELECT rows. Filter values must be in PostgREST format, e.g.
        `{"client_id": "eq.msplaunchpad"}`. Returns a list (possibly empty)."""
        params: dict = {"select": columns}
        if filters:
            params.update(filters)
        if order:
            params["order"] = order
        if limit is not None:
            params["limit"] = str(limit)
        result = self._request("GET", table, params=params)
        return result or []

    def insert(self, table: str, rows: dict | list[dict], *, return_rows: bool = True) -> list[dict]:
        """INSERT one or many rows. Returns the inserted rows by default."""
        if isinstance(rows, dict):
            rows = [rows]
        prefer = "return=representation" if return_rows else "return=minimal"
        return self._request("POST", table, body=rows, prefer=prefer) or []

    def upsert(
        self,
        table: str,
        rows: dict | list[dict],
        *,
        on_conflict: str,
        return_rows: bool = True,
    ) -> list[dict]:
        """INSERT ... ON CONFLICT UPDATE. `on_conflict` is a comma-separated list
        of PK columns (e.g. "client_id,url")."""
        if isinstance(rows, dict):
            rows = [rows]
        parts = ["resolution=merge-duplicates"]
        parts.append("return=representation" if return_rows else "return=minimal")
        prefer = ",".join(parts)
        params = {"on_conflict": on_conflict}
        return self._request("POST", table, body=rows, prefer=prefer, params=params) or []

    def update(
        self,
        table: str,
        *,
        filters: dict[str, str],
        values: dict,
        return_rows: bool = True,
    ) -> list[dict]:
        """UPDATE rows matching `filters`. `filters` uses PostgREST syntax, same
        as select(). Requires at least one filter to avoid accidental full-table
        updates."""
        if not filters:
            raise ValueError("update() requires filters — refusing full-table update")
        prefer = "return=representation" if return_rows else "return=minimal"
        return self._request("PATCH", table, params=filters, body=values, prefer=prefer) or []

    def delete(self, table: str, *, filters: dict[str, str]) -> None:
        """DELETE rows matching `filters`. Same safety guard as update()."""
        if not filters:
            raise ValueError("delete() requires filters — refusing full-table delete")
        self._request("DELETE", table, params=filters, prefer="return=minimal")

    # ------------------------------------------------------------------
    # Bulk helpers used by the runner
    # ------------------------------------------------------------------
    def chunked_upsert(
        self,
        table: str,
        rows: Iterable[dict],
        *,
        on_conflict: str,
        chunk_size: int = 500,
    ) -> int:
        """Upsert rows in batches. Returns total rows sent."""
        batch: list[dict] = []
        count = 0
        for row in rows:
            batch.append(row)
            if len(batch) >= chunk_size:
                self.upsert(table, batch, on_conflict=on_conflict, return_rows=False)
                count += len(batch)
                batch = []
        if batch:
            self.upsert(table, batch, on_conflict=on_conflict, return_rows=False)
            count += len(batch)
        return count


# ---------------------------------------------------------------------------
# PostgREST filter helpers — keep call sites readable
# ---------------------------------------------------------------------------
def eq(value: str | int) -> str:
    return f"eq.{value}"


def in_(values: list[str | int]) -> str:
    # PostgREST in filter: in.(a,b,c). Strings with commas need quoting which
    # our caller avoids by only passing identifiers.
    joined = ",".join(str(v) for v in values)
    return f"in.({joined})"
