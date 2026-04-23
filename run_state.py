"""Background run state — lets indexing runs execute without blocking the UI.

Each run writes progress to ``data/<client_id>.status.json`` from a daemon
thread. Any Streamlit view can read the status file to show live progress,
so the dashboard and detail view both stay responsive while a run is in
flight.
"""

from __future__ import annotations

import json
import re
import subprocess
import threading
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path

PROGRESS_RE = re.compile(r"\[(\d+)/(\d+)\]")
STATUS_DIR = Path(__file__).parent / "data"
LOG_TAIL_LINES = 40
# If a status file says running=True but hasn't been touched in this many
# seconds, treat it as orphaned (server restart, thread crash, etc.) so a
# new run can start.
STALE_AFTER_SECONDS = 300

# Per-client locks so the reader thread (Streamlit main) and writer thread
# (background runner) can't touch the same file simultaneously. Windows is
# strict about rename/open overlap and will raise WinError 5 (Access Denied)
# if two threads hit the file at the exact same instant.
_locks: dict[str, threading.Lock] = {}
_locks_lock = threading.Lock()


def _get_lock(client_id: str) -> threading.Lock:
    with _locks_lock:
        lock = _locks.get(client_id)
        if lock is None:
            lock = threading.Lock()
            _locks[client_id] = lock
        return lock


@dataclass
class RunStatus:
    running: bool = False
    current: int = 0
    total: int = 0
    pct: float = 0.0
    started_at: str = ""
    finished_at: str = ""
    last_log_line: str = ""
    error: str = ""
    log_tail: list = field(default_factory=list)


def _status_path(client_id: str) -> Path:
    return STATUS_DIR / f"{client_id}.status.json"


def get_status(client_id: str) -> RunStatus:
    p = _status_path(client_id)
    if not p.exists():
        return RunStatus()
    with _get_lock(client_id):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            return RunStatus(**data)
        except Exception:
            return RunStatus()


def _write_status(client_id: str, status: RunStatus) -> None:
    p = _status_path(client_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(asdict(status))
    with _get_lock(client_id):
        p.write_text(payload, encoding="utf-8")


def is_running(client_id: str) -> bool:
    """True only if the status file says running AND it's been updated
    recently. Stale files (orphaned from a crash or restart) return False."""
    p = _status_path(client_id)
    if not p.exists():
        return False
    status = get_status(client_id)
    if not status.running:
        return False
    try:
        age = datetime.now().timestamp() - p.stat().st_mtime
        if age > STALE_AFTER_SECONDS:
            return False
    except Exception:
        pass
    return True


def clear_status(client_id: str) -> None:
    p = _status_path(client_id)
    if p.exists():
        p.unlink()


def start_background_run(
    client_id: str,
    cmd: list[str],
    cwd: str | Path,
    env: dict[str, str],
) -> bool:
    """Launch the indexing subprocess in a daemon thread.

    Returns False if a run is already active for this client, True if a new
    run was started.
    """
    if is_running(client_id):
        return False

    initial = RunStatus(
        running=True,
        started_at=datetime.now().isoformat(timespec="seconds"),
    )
    _write_status(client_id, initial)

    def runner() -> None:
        status = initial
        log_tail: list[str] = []
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(cwd),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                encoding="utf-8",
                errors="replace",
                env=env,
            )
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                line = raw_line.rstrip()
                log_tail.append(line)
                if len(log_tail) > LOG_TAIL_LINES:
                    log_tail = log_tail[-LOG_TAIL_LINES:]
                match = PROGRESS_RE.search(line)
                if match:
                    cur, tot = int(match.group(1)), int(match.group(2))
                    status.current = cur
                    status.total = tot
                    status.pct = (cur / tot * 100.0) if tot else 0.0
                status.last_log_line = line
                status.log_tail = list(log_tail)
                _write_status(client_id, status)
            proc.wait()
            status.running = False
            status.finished_at = datetime.now().isoformat(timespec="seconds")
            if proc.returncode != 0:
                status.error = f"Exit code {proc.returncode}"
            else:
                status.pct = 100.0
            _write_status(client_id, status)
        except Exception as exc:
            status.running = False
            status.error = str(exc)
            status.finished_at = datetime.now().isoformat(timespec="seconds")
            _write_status(client_id, status)

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    return True
