"""
report.py — CSV export and terminal summary for indexing-monitor.

Stdlib `csv` + rich for pretty terminal output. No DB or Google code here.
"""

from __future__ import annotations

import csv
import os
from pathlib import Path

from rich.console import Console
from rich.table import Table

# Default reports directory, overridable via REPORTS_DIR env var for multi-client runs.
REPORTS_DIR = Path(os.getenv("REPORTS_DIR", "reports"))

# CSV column order (matches the spec + includes the two extra columns we added).
CSV_COLUMNS = [
    "url",
    "is_new",
    "indexed",
    "last_checked",
    "submitted",
    "last_submitted",
    "notes",
    "first_seen",
    "submit_attempts",
]


def export_csv(
    rows: list[dict],
    today: str,
    reports_dir: Path = REPORTS_DIR,
) -> Path:
    """
    Write every row to reports/<today>.csv (creating the folder if needed)
    and return the file path.
    """
    reports_dir.mkdir(parents=True, exist_ok=True)
    out_path = reports_dir / f"{today}.csv"
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    return out_path


def print_summary(
    rows: list[dict],
    submitted_this_run: int,
    console: Console | None = None,
) -> None:
    """
    Print the 5-line summary the spec asks for, followed by a colored table
    of URLs that currently aren't indexed (so the user can see what needs
    attention at a glance).
    """
    if console is None:
        console = Console()

    total = len(rows)
    new_today = sum(1 for r in rows if r.get("is_new") == 1)
    indexed = sum(1 for r in rows if r.get("indexed") == "yes")
    not_indexed = sum(1 for r in rows if r.get("indexed") == "no")

    console.print()
    console.print("[bold]Indexing monitor summary[/bold]")
    console.print(f"  Total URLs:             {total}")
    console.print(f"  New today:              {new_today}")
    console.print(f"  Indexed:                {indexed}")
    console.print(f"  Not indexed:            {not_indexed}")
    console.print(f"  Submitted for indexing: {submitted_this_run}")

    not_indexed_rows = [r for r in rows if r.get("indexed") == "no"]
    if not not_indexed_rows:
        return

    table = Table(title="\nNot indexed", show_lines=False, title_justify="left")
    table.add_column("URL", overflow="fold", max_width=60)
    table.add_column("Reason / notes", overflow="fold")
    table.add_column("Submitted?", justify="center")
    table.add_column("Attempts", justify="right")

    for r in sorted(not_indexed_rows, key=lambda x: x.get("url", "")):
        submitted_cell = (
            "[green]yes[/green]" if r.get("submitted") == 1 else "[yellow]no[/yellow]"
        )
        table.add_row(
            r.get("url", ""),
            r.get("notes") or "",
            submitted_cell,
            str(r.get("submit_attempts") or 0),
        )
    console.print(table)
