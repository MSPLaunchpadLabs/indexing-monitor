"""engine.runner — Supabase-backed indexing run orchestrator.

Invoked from GitHub Actions as:

    python -m engine.runner <client_id> <run_id>

``client_id`` selects which client to process. ``run_id`` is the UUID of the
``runs`` row that the Vercel ``api/run.py`` endpoint pre-created (in status
=running); we update it as we go and mark it done/failed at the end.

Reuses sitemap.py and gsc.py from the repo root — only the storage + progress
layer is different from the legacy CLI flow in main.py.
"""
from __future__ import annotations

import os
import sys
import time
import traceback
from datetime import datetime, timezone

# repo root is the working directory when invoked with `python -m engine.runner`
from api._supabase import Supabase, SupabaseError, eq
from engine import supabase_db as db
from gsc import (
    CredentialsMissingError,
    GoogleAuthError,
    GoogleClient,
    QuotaExceededError,
)
from sitemap import SitemapError, fetch_urls


# Pacing between URL Inspection calls (URL Inspection quota: 600/min).
INSPECT_SLEEP_SECONDS = 0.1
LOG_TAIL_LINES = 40


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


class RunContext:
    """Accumulates log tail + progress; flushes to Supabase on demand."""

    def __init__(self, sb: Supabase, run_id: str):
        self.sb = sb
        self.run_id = run_id
        self.log: list[str] = []
        self.current = 0
        self.total = 0

    def log_line(self, line: str) -> None:
        print(line, flush=True)
        self.log.append(line)
        if len(self.log) > LOG_TAIL_LINES:
            self.log = self.log[-LOG_TAIL_LINES:]

    def update_progress(self, current: int, total: int, *, flush_log: bool = True) -> None:
        self.current = current
        self.total = total
        pct = (current / total * 100.0) if total else 0.0
        values = {
            "current": current,
            "total": total,
            "pct": round(pct, 2),
        }
        if flush_log:
            values["log_tail"] = self.log
        try:
            self.sb.update(
                "runs",
                filters={"id": eq(self.run_id)},
                values=values,
                return_rows=False,
            )
        except SupabaseError as exc:
            # A transient Supabase blip shouldn't kill the run. Log and continue;
            # the next progress tick will try again.
            print(f"[warn] progress update failed: {exc}", flush=True)

    def finish(
        self,
        *,
        status: str,
        error: str | None = None,
        indexed_count: int = 0,
        not_indexed_count: int = 0,
        submitted_count: int = 0,
    ) -> None:
        values = {
            "status": status,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "pct": 100.0 if status == "done" else self._pct(),
            "log_tail": self.log,
            "indexed_count": indexed_count,
            "not_indexed_count": not_indexed_count,
            "submitted_count": submitted_count,
        }
        if error:
            values["error"] = error[:2000]
        self.sb.update(
            "runs",
            filters={"id": eq(self.run_id)},
            values=values,
            return_rows=False,
        )

    def _pct(self) -> float:
        return (self.current / self.total * 100.0) if self.total else 0.0


def run(client_id: str, run_id: str) -> int:
    """Full run flow. Returns process exit code (0 = success)."""
    sb = Supabase()
    ctx = RunContext(sb, run_id)

    try:
        client = db.get_client(sb, client_id)
        if client is None:
            ctx.log_line(f"client not found: {client_id}")
            ctx.finish(status="failed", error=f"client {client_id!r} not found in Supabase")
            return 2

        ctx.log_line(f"client: {client['name']} ({client['domain']})")
        ctx.log_line(f"sitemap: {client['sitemap_url']}")

        creds_env = os.environ.get("GOOGLE_CREDENTIALS", "").strip()
        if not creds_env:
            ctx.log_line("GOOGLE_CREDENTIALS is empty")
            ctx.finish(status="failed", error="GOOGLE_CREDENTIALS env var is empty")
            return 2

        try:
            gsc = GoogleClient(creds_env, client["gsc_site_url"])
        except (CredentialsMissingError, GoogleAuthError) as e:
            ctx.log_line(f"credentials/auth error: {e}")
            ctx.finish(status="failed", error=str(e))
            return 2

        # --- Step 1: sitemap ----------------------------------------------
        ctx.log_line("1. fetching sitemap")
        try:
            sitemap_urls = fetch_urls(client["sitemap_url"])
        except SitemapError as e:
            ctx.log_line(f"sitemap error: {e}")
            ctx.finish(status="failed", error=str(e))
            return 1
        ctx.log_line(f"   found {len(sitemap_urls)} URLs in sitemap")

        # --- Step 2: diff + upsert ----------------------------------------
        today = db.today_iso()
        new_count = db.reset_is_new_and_upsert_urls(sb, client_id, sitemap_urls, today)
        ctx.log_line(f"2. diff: {new_count} new URL(s)")
        ctx.update_progress(0, len(sitemap_urls))

        # --- Step 3: inspect ---------------------------------------------
        ctx.log_line("3. inspecting URLs")
        quota_hit = False
        for i, url in enumerate(sitemap_urls, start=1):
            try:
                indexed, reason = gsc.inspect(url)
            except QuotaExceededError as e:
                ctx.log_line(f"[{i}/{len(sitemap_urls)}] quota hit — stopping inspection ({e})")
                quota_hit = True
                break
            except GoogleAuthError as e:
                ctx.log_line(f"auth error during inspect: {e}")
                ctx.finish(status="failed", error=str(e))
                return 1
            except Exception as e:
                db.record_inspection(sb, client_id, url, None, f"inspect error: {e}"[:500])
                ctx.log_line(f"[{i}/{len(sitemap_urls)}] {url} — error ({e})")
                ctx.update_progress(i, len(sitemap_urls))
                continue

            db.record_inspection(sb, client_id, url, indexed, reason)
            status_cell = "yes" if indexed else "no"
            ctx.log_line(f"[{i}/{len(sitemap_urls)}] {url} — {status_cell} ({reason})")
            ctx.update_progress(i, len(sitemap_urls))
            time.sleep(INSPECT_SLEEP_SECONDS)

        # --- Step 4: submit not-indexed ----------------------------------
        ctx.log_line("4. submitting not-indexed URLs")
        submitted = 0
        max_submissions = _env_int("MAX_SUBMISSIONS_PER_RUN", 180)
        max_attempts = _env_int("MAX_SUBMIT_ATTEMPTS_PER_URL", 5)

        if quota_hit:
            ctx.log_line("   skipped — inspection quota was exhausted")
        else:
            for url in sitemap_urls:
                if submitted >= max_submissions:
                    db.set_note(sb, client_id, url, "deferred: daily quota")
                    continue

                eligible, reason = db.should_submit(
                    sb, client_id, url, max_attempts=max_attempts
                )
                if not eligible:
                    continue

                try:
                    gsc.submit_url(url)
                except QuotaExceededError as e:
                    ctx.log_line(f"   submit quota hit — stopping ({e})")
                    break
                except GoogleAuthError as e:
                    ctx.log_line(f"   auth error: {e}")
                    ctx.finish(status="failed", error=str(e))
                    return 1
                except RuntimeError as e:
                    db.set_note(sb, client_id, url, f"submit error: {e}"[:500])
                    continue

                db.record_submission(sb, client_id, url)
                submitted += 1
                ctx.log_line(f"   submitted: {url}")

            if submitted > 0:
                try:
                    gsc.submit_sitemap(client["sitemap_url"])
                    ctx.log_line(f"   resubmitted sitemap: {client['sitemap_url']}")
                except QuotaExceededError as e:
                    ctx.log_line(f"   sitemap resubmit: quota hit ({e})")
                except GoogleAuthError as e:
                    ctx.log_line(f"   auth error on sitemap resubmit: {e}")
                    ctx.finish(status="failed", error=str(e))
                    return 1
                except RuntimeError as e:
                    ctx.log_line(f"   sitemap resubmit error: {e}")

        # --- Step 5: snapshot + summary ----------------------------------
        ctx.log_line("5. snapshotting run")
        db.snapshot_run(sb, run_id, client_id)

        rows = db.read_all(sb, client_id)
        indexed_n = sum(1 for r in rows if r.get("indexed") == "yes")
        not_indexed_n = sum(1 for r in rows if r.get("indexed") == "no")

        ctx.log_line(
            f"done · total={len(rows)} indexed={indexed_n} "
            f"not_indexed={not_indexed_n} submitted_this_run={submitted}"
        )
        ctx.finish(
            status="done",
            indexed_count=indexed_n,
            not_indexed_count=not_indexed_n,
            submitted_count=submitted,
        )
        return 0

    except Exception as exc:
        tb = traceback.format_exc()
        print(tb, flush=True)
        ctx.log_line(f"[fatal] {exc}")
        try:
            ctx.finish(status="failed", error=f"{exc}\n{tb}"[:1800])
        except Exception:
            pass
        return 1


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: python -m engine.runner <client_id> <run_id>", file=sys.stderr)
        sys.exit(64)
    client_id = sys.argv[1].strip()
    run_id = sys.argv[2].strip()
    if not client_id or not run_id:
        print("client_id and run_id are required", file=sys.stderr)
        sys.exit(64)
    sys.exit(run(client_id, run_id))


if __name__ == "__main__":
    main()
