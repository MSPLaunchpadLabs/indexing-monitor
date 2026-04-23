"""
main.py — CLI entry point for indexing-monitor.

Three commands, all at one level (no nested groups):

  python main.py run          full daily check + auto-submit
  python main.py status       print current status (no API calls)
  python main.py check <url>  inspect one URL manually

Env vars it reads — see .env.example for the full list:
  SITEMAP_URL, GSC_SITE_URL, GOOGLE_CREDENTIALS,
  MAX_SUBMISSIONS_PER_RUN (optional), MAX_SUBMIT_ATTEMPTS_PER_URL (optional)
"""

from __future__ import annotations

import os
import sqlite3
import sys
import time
from dataclasses import dataclass

import click
from dotenv import load_dotenv
from rich.console import Console

import db
import report
from gsc import (
    CredentialsMissingError,
    GoogleAuthError,
    GoogleClient,
    GoogleClientError,
    QuotaExceededError,
)
from sitemap import SitemapError, fetch_urls


console = Console()

# Defaults; overridable via env.
DEFAULT_MAX_SUBMISSIONS_PER_RUN = 180
DEFAULT_MAX_ATTEMPTS_PER_URL = 5
# Pacing between URL Inspection calls. Keeps us well under the 600/min cap.
INSPECT_SLEEP_SECONDS = 0.1


# ---------- Shared session ----------

@dataclass
class Session:
    """Shared state passed between command functions. One auth per run."""
    conn: sqlite3.Connection
    gsc: GoogleClient
    site_url: str
    sitemap_url: str
    max_submissions_per_run: int
    max_attempts_per_url: int


def build_session() -> Session:
    """
    Load .env, connect to the DB, authenticate with Google.
    Raises click.ClickException with a friendly message on any config problem.
    """
    load_dotenv()     # reads .env from the current working directory

    sitemap_url = os.getenv("SITEMAP_URL", "").strip()
    site_url = os.getenv("GSC_SITE_URL", "").strip()
    creds = os.getenv("GOOGLE_CREDENTIALS", "").strip()

    missing = [
        name for name, val in [
            ("SITEMAP_URL", sitemap_url),
            ("GSC_SITE_URL", site_url),
            ("GOOGLE_CREDENTIALS", creds),
        ] if not val
    ]
    if missing:
        raise click.ClickException(
            f"Missing required env vars: {', '.join(missing)}. "
            "Copy .env.example to .env and fill in the values."
        )

    max_submit_per_run = _int_env("MAX_SUBMISSIONS_PER_RUN", DEFAULT_MAX_SUBMISSIONS_PER_RUN)
    max_attempts = _int_env("MAX_SUBMIT_ATTEMPTS_PER_URL", DEFAULT_MAX_ATTEMPTS_PER_URL)

    conn = db.connect()
    db.ensure_schema(conn)

    try:
        gsc = GoogleClient(creds, site_url)
    except (CredentialsMissingError, GoogleAuthError) as e:
        raise click.ClickException(str(e))

    return Session(
        conn=conn,
        gsc=gsc,
        site_url=site_url,
        sitemap_url=sitemap_url,
        max_submissions_per_run=max_submit_per_run,
        max_attempts_per_url=max_attempts,
    )


def _int_env(name: str, default: int) -> int:
    """Read an integer env var, falling back to `default` on missing/malformed."""
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        console.print(
            f"[yellow]Warning:[/yellow] {name}={raw!r} isn't a valid integer — "
            f"using default {default}"
        )
        return default


# ---------- CLI ----------

@click.group()
def cli():
    """indexing-monitor — daily Google indexing check and auto-submit."""


@cli.command()
def run():
    """Run the full daily check-and-submit flow."""
    session = build_session()

    # Non-official-use notice (printed every run so it's impossible to miss).
    console.print(
        "[dim]Note: the Indexing API is officially for JobPosting and "
        "BroadcastEvent pages. Using it for general URLs works in practice "
        "but is a grey area — see README for details.[/dim]"
    )

    # --- Step 1: Fetch sitemap -------------------------------------------
    console.print(f"\n[bold]1. Fetching sitemap[/bold] — {session.sitemap_url}")
    try:
        sitemap_urls = fetch_urls(session.sitemap_url)
    except SitemapError as e:
        raise click.ClickException(str(e))
    console.print(f"   Found {len(sitemap_urls)} URLs in sitemap")

    # --- Step 2: Upsert + flag new URLs ----------------------------------
    today = db.today_iso()
    new_count = db.reset_is_new_and_upsert_urls(session.conn, sitemap_urls, today)
    console.print(f"[bold]2. Diffing against DB[/bold] — {new_count} new URL(s)")

    # --- Step 3: Inspect every URL ---------------------------------------
    console.print(f"[bold]3. Inspecting URLs[/bold]")
    quota_hit = False
    for i, url in enumerate(sitemap_urls, start=1):
        try:
            indexed, reason = session.gsc.inspect(url)
        except QuotaExceededError as e:
            console.print(f"[yellow]{e}[/yellow]")
            quota_hit = True
            break
        except GoogleAuthError as e:
            raise click.ClickException(str(e))
        except Exception as e:
            # Anything else (network blip, unexpected API response) — record
            # as unknown and keep going. One flaky URL shouldn't fail the run.
            db.record_inspection(session.conn, url, None, f"inspect error: {e}"[:500])
            console.print(f"   [{i}/{len(sitemap_urls)}] {url} — [yellow]error[/yellow] ({e})")
            continue

        db.record_inspection(session.conn, url, indexed, reason)
        status_cell = "[green]yes[/green]" if indexed else "[yellow]no[/yellow]"
        console.print(f"   [{i}/{len(sitemap_urls)}] {url} — {status_cell} ({reason})")
        time.sleep(INSPECT_SLEEP_SECONDS)

    # --- Step 4: Submit not-indexed URLs ---------------------------------
    console.print(f"\n[bold]4. Submitting not-indexed URLs[/bold]")
    submitted = 0
    if quota_hit:
        console.print("   skipped — inspection quota was exhausted")
    else:
        for url in sitemap_urls:
            # Honor the per-run cap: everything past it is marked "deferred".
            if submitted >= session.max_submissions_per_run:
                db.set_note(session.conn, url, "deferred: daily quota")
                continue

            eligible, reason = db.should_submit(
                session.conn,
                url,
                max_attempts=session.max_attempts_per_url,
            )
            if not eligible:
                continue

            try:
                session.gsc.submit_url(url)
            except QuotaExceededError as e:
                console.print(f"[yellow]{e}[/yellow]")
                break
            except GoogleAuthError as e:
                raise click.ClickException(str(e))
            except RuntimeError as e:
                # Non-fatal — note it and continue with the next URL.
                db.set_note(session.conn, url, f"submit error: {e}"[:500])
                continue

            db.record_submission(session.conn, url)
            submitted += 1
            console.print(f"   submitted: {url}")

        # Resubmit the full sitemap once at the end, only if we actually
        # submitted anything (avoid pointless calls on clean days).
        if submitted > 0:
            try:
                session.gsc.submit_sitemap(session.sitemap_url)
                console.print(f"   resubmitted sitemap: {session.sitemap_url}")
            except QuotaExceededError as e:
                console.print(f"[yellow]{e}[/yellow]")
            except GoogleAuthError as e:
                raise click.ClickException(str(e))
            except RuntimeError as e:
                console.print(f"[yellow]sitemap resubmit error: {e}[/yellow]")

    # --- Step 5 & 6: Write CSV + print summary ---------------------------
    console.print("\n[bold]5. Writing report[/bold]")
    rows = db.read_all(session.conn)
    csv_path = report.export_csv(rows, today)
    console.print(f"   wrote {csv_path}")

    report.print_summary(rows, submitted, console=console)


@cli.command()
def status():
    """Print the current status table without hitting Google APIs."""
    load_dotenv()
    conn = db.connect()
    db.ensure_schema(conn)
    rows = db.read_all(conn)

    if not rows:
        console.print(
            "[yellow]No URLs tracked yet — run `python main.py run` first.[/yellow]"
        )
        return

    # "Submitted this run" isn't meaningful in status mode, so show 0.
    report.print_summary(rows, submitted_this_run=0, console=console)


@cli.command()
@click.argument("url")
def check(url):
    """Inspect one URL manually. Records the result in the DB."""
    session = build_session()
    db.upsert_url(session.conn, url)

    try:
        indexed, reason = session.gsc.inspect(url)
    except (QuotaExceededError, GoogleAuthError) as e:
        raise click.ClickException(str(e))
    except Exception as e:
        raise click.ClickException(f"inspect failed: {e}")

    db.record_inspection(session.conn, url, indexed, reason)

    if indexed is True:
        console.print(f"[green]indexed: yes[/green] — {reason}")
    elif indexed is False:
        console.print(f"[yellow]indexed: no[/yellow] — {reason}")
    else:
        console.print(f"[yellow]indexed: unknown[/yellow] — {reason}")


def main():
    """Top-level entry with safety net for any un-translated GoogleClientError."""
    try:
        cli()
    except GoogleClientError as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
