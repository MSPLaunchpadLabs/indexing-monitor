"""
gsc.py — thin wrapper around the two Google APIs indexing-monitor needs.

  * Search Console v1 — URL Inspection + sitemap submission
  * Indexing API v3   — URL submission (urlNotifications.publish)

One service account JSON covers both. We ask for two scopes at auth time
and build two separate service clients.
"""

from __future__ import annotations

import json
from pathlib import Path

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


# Scopes requested at auth time. `webmasters` is the full read+write scope —
# required for sitemaps.submit (read-only won't work). `indexing` is for
# the separate Indexing API.
SCOPES = [
    "https://www.googleapis.com/auth/webmasters",
    "https://www.googleapis.com/auth/indexing",
]


# ---------- Exceptions ----------
# These are deliberately specific so main.py can decide what's recoverable.

class GoogleClientError(Exception):
    """Base class for every GoogleClient problem."""


class CredentialsMissingError(GoogleClientError):
    """GOOGLE_CREDENTIALS env value is empty, unreadable, or not valid JSON."""


class GoogleAuthError(GoogleClientError):
    """Google rejected the request — bad key, missing scope, or no GSC permission."""


class QuotaExceededError(GoogleClientError):
    """Hit today's API quota. Main loop should stop and try again tomorrow."""


# ---------- Credential loading ----------

def _load_credentials(env_value: str) -> service_account.Credentials:
    """
    Build service account credentials from one of two formats:

      1. A filesystem path to the service account JSON file.
      2. The raw JSON itself, passed as a single string.

    Detection: if the first non-whitespace character is `{`, treat as inline
    JSON; otherwise treat as a file path. This lets the same env variable
    work both locally (path) and in GitHub Actions (paste the JSON into a
    secret).
    """
    value = (env_value or "").strip()
    if not value:
        raise CredentialsMissingError(
            "GOOGLE_CREDENTIALS is empty. Set it to either a path to the "
            "service account JSON file, or the JSON itself as a string."
        )

    try:
        if value.startswith("{"):
            info = json.loads(value)
            return service_account.Credentials.from_service_account_info(
                info, scopes=SCOPES
            )

        path = Path(value).expanduser()
        if not path.exists():
            raise CredentialsMissingError(
                f"GOOGLE_CREDENTIALS points to {path}, but that file doesn't "
                "exist. Check the path, or paste the JSON directly as the "
                "env value."
            )
        return service_account.Credentials.from_service_account_file(
            str(path), scopes=SCOPES
        )

    except json.JSONDecodeError as e:
        raise CredentialsMissingError(
            "GOOGLE_CREDENTIALS starts with `{` but isn't valid JSON. "
            f"Parse error: {e}"
        ) from e
    except ValueError as e:   # raised by google-auth if the JSON is malformed
        raise GoogleAuthError(
            f"service account credentials look malformed: {e}"
        ) from e


# ---------- Client ----------

class GoogleClient:
    """
    Wraps both the Search Console and Indexing API clients behind three
    methods: `inspect`, `submit_url`, `submit_sitemap`.

    Args:
        credentials_env_value: Whatever was in the GOOGLE_CREDENTIALS env var
            (a file path OR raw JSON as a string).
        site_url: The GSC property, e.g. "https://example.com/" (URL-prefix
            property) or "sc-domain:example.com" (domain property).
    """

    def __init__(self, credentials_env_value: str, site_url: str):
        self.site_url = site_url
        self._creds = _load_credentials(credentials_env_value)
        # Fail fast on bad creds. If the SA key was rotated in GCP without
        # updating GOOGLE_CREDENTIALS, every API call would die later with
        # "invalid_grant: Invalid JWT Signature" — usually after we'd already
        # spent minutes inspecting URLs. Catch it here in 1s with a clear msg.
        try:
            self._creds.refresh(GoogleAuthRequest())
        except RefreshError as e:
            raise GoogleAuthError(
                f"service account auth failed at startup ({e}). Most likely "
                "the key in GOOGLE_CREDENTIALS was rotated or revoked in GCP "
                "IAM. Generate a fresh JSON key for the service account and "
                "update the GOOGLE_CREDENTIALS secret in GitHub Actions."
            ) from e
        # cache_discovery=False silences a harmless warning on newer versions.
        self._search_console = build(
            "searchconsole", "v1", credentials=self._creds, cache_discovery=False
        )
        self._indexing = build(
            "indexing", "v3", credentials=self._creds, cache_discovery=False
        )

    # ---------- URL Inspection ----------

    def inspect(self, url: str) -> tuple[bool | None, str]:
        """
        Run the URL Inspection API against `url`.

        Returns (indexed, reason):
          indexed=True  → Google says it's indexed ("PASS" verdict)
          indexed=False → Google says it's not indexed
          indexed=None  → transient error; caller records 'unknown'

        Raises GoogleAuthError or QuotaExceededError on fatal errors (the
        main loop should stop on those).
        """
        body = {"inspectionUrl": url, "siteUrl": self.site_url}
        try:
            resp = (
                self._search_console.urlInspection()
                .index()
                .inspect(body=body)
                .execute()
            )
        except HttpError as e:
            self._reraise_fatal(e)
            return None, _http_error_summary(e)

        result = resp.get("inspectionResult", {}).get("indexStatusResult", {})
        verdict = result.get("verdict", "UNKNOWN")
        coverage = result.get("coverageState", "")

        indexed = (verdict == "PASS")
        # Prefer the human-readable coverage state as the reason; fall back to verdict.
        reason = coverage if coverage else verdict
        return indexed, reason

    # ---------- Indexing API ----------

    def submit_url(self, url: str) -> None:
        """
        Submit a single URL to the Indexing API as URL_UPDATED.

        Raises GoogleAuthError or QuotaExceededError on fatal errors.
        Raises RuntimeError (with a short summary) on non-fatal errors —
        main.py catches those and records a note, then continues.
        """
        body = {"url": url, "type": "URL_UPDATED"}
        try:
            self._indexing.urlNotifications().publish(body=body).execute()
        except RefreshError as e:
            # Token went stale between phases (we've seen this fire on the
            # first submit after a long inspect pass). Force one fresh JWT
            # and retry; if it still fails, the key is genuinely bad.
            try:
                self._creds.refresh(GoogleAuthRequest())
                self._indexing.urlNotifications().publish(body=body).execute()
            except RefreshError as e2:
                raise GoogleAuthError(
                    f"Indexing API auth refused after refresh-and-retry ({e2}). "
                    "The service account key was likely rotated. Update the "
                    "GOOGLE_CREDENTIALS secret with a fresh JSON key."
                ) from e2
        except HttpError as e:
            self._reraise_fatal(e)
            raise RuntimeError(_http_error_summary(e)) from e

    # ---------- Sitemap submission ----------

    def submit_sitemap(self, sitemap_url: str) -> None:
        """
        Ask Google to re-crawl the sitemap. Idempotent — safe to call daily.

        Raises GoogleAuthError or QuotaExceededError on fatal errors,
        RuntimeError on non-fatal ones.
        """
        try:
            self._search_console.sitemaps().submit(
                siteUrl=self.site_url, feedpath=sitemap_url
            ).execute()
        except HttpError as e:
            self._reraise_fatal(e)
            raise RuntimeError(_http_error_summary(e)) from e

    # ---------- Error mapping ----------

    @staticmethod
    def _reraise_fatal(e: HttpError) -> None:
        """
        Translate fatal HTTP errors into our own exception types.
        Does nothing for non-fatal errors — caller handles those itself.
        """
        status = getattr(e.resp, "status", None)
        if status in (401, 403):
            raise GoogleAuthError(
                f"Google denied the request (HTTP {status}). Most common "
                "cause: the service account isn't added as an Owner in "
                "Google Search Console, or the Search Console / Indexing "
                "API isn't enabled in your GCP project. See README steps "
                f"2–4. Details: {_http_error_summary(e)}"
            ) from e
        if status == 429:
            raise QuotaExceededError(
                "Google returned HTTP 429 — you've hit today's quota. "
                "Stopping this run; remaining URLs will be retried tomorrow."
            ) from e


def _http_error_summary(e: HttpError) -> str:
    """Pull a short, readable message out of an HttpError for logs and notes."""
    try:
        content = e.content.decode("utf-8", errors="replace") if e.content else ""
        parsed = json.loads(content) if content else {}
        msg = parsed.get("error", {}).get("message") or content or str(e)
        status = getattr(e.resp, "status", "?")
        return f"HTTP {status}: {msg[:200]}"
    except Exception:
        return str(e)[:300]
