"""Tiny HTTP helpers shared by every api/*.py endpoint.

Vercel's Python runtime expects each endpoint to expose a class named
``handler`` that inherits ``http.server.BaseHTTPRequestHandler``. These helpers
cut the boilerplate without introducing a framework layer.
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.parse import parse_qs, urlparse


def send_json(h: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    """Serialize `payload` as JSON and write it as the response."""
    body = json.dumps(payload, default=_json_default).encode("utf-8")
    h.send_response(status)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(body)))
    h.send_header("Cache-Control", "no-store")
    h.send_header("Access-Control-Allow-Origin", "*")
    h.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "Content-Type")
    h.end_headers()
    h.wfile.write(body)


def send_text(h: BaseHTTPRequestHandler, status: int, body: str, content_type: str = "text/plain") -> None:
    raw = body.encode("utf-8")
    h.send_response(status)
    h.send_header("Content-Type", f"{content_type}; charset=utf-8")
    h.send_header("Content-Length", str(len(raw)))
    h.send_header("Access-Control-Allow-Origin", "*")
    h.end_headers()
    h.wfile.write(raw)


def send_csv(h: BaseHTTPRequestHandler, body: str, filename: str) -> None:
    raw = body.encode("utf-8")
    h.send_response(200)
    h.send_header("Content-Type", "text/csv; charset=utf-8")
    h.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    h.send_header("Content-Length", str(len(raw)))
    h.send_header("Access-Control-Allow-Origin", "*")
    h.end_headers()
    h.wfile.write(raw)


def read_json_body(h: BaseHTTPRequestHandler) -> dict:
    """Parse the JSON request body. Returns {} if no body."""
    length = int(h.headers.get("content-length") or 0)
    if not length:
        return {}
    raw = h.rfile.read(length).decode("utf-8")
    if not raw.strip():
        return {}
    return json.loads(raw)


def query_params(h: BaseHTTPRequestHandler) -> dict[str, str]:
    """Return the query string as a single-value dict (last wins)."""
    q = parse_qs(urlparse(h.path).query, keep_blank_values=True)
    return {k: (v[-1] if v else "") for k, v in q.items()}


def handle_options(h: BaseHTTPRequestHandler) -> None:
    """Preflight CORS response."""
    h.send_response(204)
    h.send_header("Access-Control-Allow-Origin", "*")
    h.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "Content-Type")
    h.end_headers()


def error_response(h: BaseHTTPRequestHandler, status: int, message: str) -> None:
    send_json(h, status, {"error": message})


def _json_default(value: Any) -> str:
    """Serialize datetime-ish values from Postgres/jsonb automatically."""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)
