"""
sitemap.py — fetch and parse sitemaps for indexing-monitor.

Handles:
  * plain XML sitemaps (<urlset>...)
  * sitemap index files (<sitemapindex>...)   — recurses into each child
  * gzip-compressed sitemaps (.xml.gz)        — sniffs magic bytes, server-independent

No DB code and no Google code lives here — this is pure HTTP + XML.
"""

from __future__ import annotations

import gzip
import requests
from lxml import etree

# ---------- Tunables ----------

MAX_URLS_PER_SITEMAP = 50_000         # sitemaps.org spec limit for a single sitemap
DEFAULT_MAX_DEPTH = 3                 # safety cap for nested sitemap indexes
REQUEST_TIMEOUT_SECONDS = 30
USER_AGENT = "indexing-monitor/1.0"


# ---------- Exceptions ----------

class SitemapError(Exception):
    """Base class for every sitemap-related failure."""


class SitemapUnreachableError(SitemapError):
    """HTTP request failed or returned a non-200 status."""


class SitemapParseError(SitemapError):
    """The sitemap content wasn't valid XML, or had an unexpected root element."""


class SitemapTooLargeError(SitemapError):
    """A single sitemap exceeded the 50k-URL limit."""


# ---------- Public API ----------

def fetch_urls(
    sitemap_url: str,
    max_depth: int = DEFAULT_MAX_DEPTH,
) -> list[str]:
    """
    Return every page URL reachable from `sitemap_url`. Transparently handles
    gzip compression and sitemap-index recursion.

    Raises:
        SitemapUnreachableError — sitemap couldn't be fetched.
        SitemapParseError — sitemap was not valid XML or had an unexpected root.
        SitemapTooLargeError — a single sitemap exceeded 50k URLs.
    """
    urls: list[str] = []
    visited: set[str] = set()
    _walk(sitemap_url, urls, visited, depth=0, max_depth=max_depth)
    return urls


# ---------- Internals ----------

def _walk(
    url: str,
    out: list[str],
    visited: set[str],
    depth: int,
    max_depth: int,
) -> None:
    """Recursively collect URLs, descending into sitemap indexes as needed."""
    if url in visited:
        return                        # cycle guard — some indexes point back at themselves
    visited.add(url)

    if depth > max_depth:
        raise SitemapParseError(
            f"sitemap recursion exceeded max depth {max_depth} — "
            "possible loop in sitemap index files"
        )

    raw = _fetch(url)
    xml_bytes = _maybe_decompress(raw, url)
    root = _parse(xml_bytes, url)
    root_tag = etree.QName(root.tag).localname      # strip namespace for comparison

    if root_tag == "urlset":
        page_urls = _locs_in(root, "url")
        if len(page_urls) > MAX_URLS_PER_SITEMAP:
            raise SitemapTooLargeError(
                f"sitemap {url} has {len(page_urls)} URLs — exceeds the "
                f"sitemaps.org limit of {MAX_URLS_PER_SITEMAP}. Split it "
                "into multiple sitemaps + a sitemap index."
            )
        out.extend(page_urls)

    elif root_tag == "sitemapindex":
        for child_url in _locs_in(root, "sitemap"):
            _walk(child_url, out, visited, depth + 1, max_depth)

    else:
        raise SitemapParseError(
            f"sitemap {url} has unexpected root element <{root_tag}> — "
            "expected <urlset> or <sitemapindex>"
        )


def _fetch(url: str) -> bytes:
    """HTTP GET the sitemap. Returns raw bytes (we need them for gzip sniffing)."""
    try:
        resp = requests.get(
            url,
            timeout=REQUEST_TIMEOUT_SECONDS,
            headers={"User-Agent": USER_AGENT},
            allow_redirects=True,
        )
    except requests.exceptions.RequestException as e:
        raise SitemapUnreachableError(
            f"could not reach sitemap at {url}: {e}"
        ) from e

    if resp.status_code != 200:
        raise SitemapUnreachableError(
            f"sitemap at {url} returned HTTP {resp.status_code}"
        )
    return resp.content


def _maybe_decompress(raw: bytes, url: str) -> bytes:
    """
    Decompress gzip-encoded sitemaps. Detection uses the gzip magic bytes
    (`1f 8b`) — more reliable than Content-Type, which is often wrong for
    static `.xml.gz` files. Transport-level gzip has already been decoded
    by `requests`, so anything still starting with `1f 8b` is file-level.
    """
    if raw.startswith(b"\x1f\x8b"):
        try:
            return gzip.decompress(raw)
        except OSError as e:
            raise SitemapParseError(
                f"sitemap {url} looked gzipped but failed to decompress: {e}"
            ) from e
    return raw


def _parse(xml_bytes: bytes, url: str) -> etree._Element:
    """
    Parse XML safely. The parser is configured to block external entity
    resolution and network access (XXE-safe), and to fail loudly on malformed
    input rather than silently recovering.
    """
    parser = etree.XMLParser(
        resolve_entities=False,   # block XXE — no external entity expansion
        no_network=True,          # block external DTD / entity fetches
        dtd_validation=False,
        load_dtd=False,
        recover=False,
    )
    try:
        return etree.fromstring(xml_bytes, parser=parser)
    except etree.XMLSyntaxError as e:
        raise SitemapParseError(
            f"sitemap {url} is not valid XML: {e}"
        ) from e


def _locs_in(root: etree._Element, parent_name: str) -> list[str]:
    """
    Return the text of every <loc> child of every <parent_name> element in
    the tree, regardless of XML namespace. Works for both <url><loc> (pages)
    and <sitemap><loc> (sitemap-index children).
    """
    result: list[str] = []
    for parent in root.iter():
        if etree.QName(parent.tag).localname != parent_name:
            continue
        for child in parent:
            if etree.QName(child.tag).localname == "loc":
                text = (child.text or "").strip()
                if text:
                    result.append(text)
    return result
