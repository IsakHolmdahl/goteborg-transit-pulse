"""Minimal client for Vinted's public web JSON API.

Vinted has no official public API. The website itself fetches everything from
JSON endpoints under /api/v2/, which are readable with a normal anonymous
browser session (cookies obtained by visiting the homepage). This client
mimics that, with polite rate limiting and automatic session refresh.

Endpoints used (read-only):
  GET /api/v2/catalog/items   — search results, same params as the website URL
  GET /api/v2/items/{id}      — single listing detail (description, photos,
                                is_closed / is_sold flags)
"""

from __future__ import annotations

import random
import time
from urllib.parse import parse_qsl, urlsplit

import requests

DEFAULT_DOMAIN = "www.vinted.se"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Minimum seconds between requests, plus random jitter. Keep this generous:
# we are a guest on their infrastructure and DataDome bans impolite clients.
MIN_DELAY = 2.0
JITTER = 1.5


class VintedError(RuntimeError):
    pass


class VintedClient:
    def __init__(self, domain: str = DEFAULT_DOMAIN):
        self.base = f"https://{domain}"
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": _UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
                "Referer": self.base + "/",
            }
        )
        self._has_cookies = False
        self._last_request = 0.0

    # -- plumbing ----------------------------------------------------------

    def _throttle(self) -> None:
        wait = self._last_request + MIN_DELAY + random.uniform(0, JITTER) - time.time()
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.time()

    def _bootstrap(self) -> None:
        """Visit the homepage to obtain anonymous session cookies."""
        self._throttle()
        resp = self.session.get(self.base + "/", timeout=30)
        if resp.status_code >= 400:
            raise VintedError(
                f"Could not open {self.base} (HTTP {resp.status_code}). "
                "Vinted may be blocking this network — try from a residential IP."
            )
        self._has_cookies = True

    def _get(self, path: str, params: list[tuple[str, str]] | None = None) -> requests.Response:
        if not self._has_cookies:
            self._bootstrap()
        for attempt in range(4):
            self._throttle()
            resp = self.session.get(self.base + path, params=params, timeout=30)
            if resp.status_code in (401, 403):
                # session expired or bot-check — refresh cookies and retry
                self._has_cookies = False
                self._bootstrap()
                continue
            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", "0") or 0)
                time.sleep(max(retry_after, 15) + random.uniform(0, 5))
                continue
            return resp
        raise VintedError(f"Giving up on GET {path} after repeated 401/403/429 responses.")

    # -- public API --------------------------------------------------------

    def search(self, params: list[tuple[str, str]], per_page: int = 96) -> list[dict]:
        """Run a catalog search. `params` are (key, value) pairs exactly as they
        appear in a vinted.xx/catalog URL (search_text, brand_ids[], color_ids[], ...).
        Returns the raw item dicts, newest first."""
        query = [(k, v) for k, v in params if k not in ("order", "per_page", "page", "time")]
        query += [("order", "newest_first"), ("per_page", str(per_page)), ("page", "1")]
        resp = self._get("/api/v2/catalog/items", params=query)
        if resp.status_code != 200:
            raise VintedError(f"Search failed: HTTP {resp.status_code}: {resp.text[:200]}")
        return resp.json().get("items", [])

    def item(self, item_id: int) -> tuple[str, dict | None]:
        """Fetch one listing. Returns (state, item_dict) where state is one of
        'active', 'sold', 'closed', 'gone'."""
        resp = self._get(f"/api/v2/items/{item_id}")
        if resp.status_code == 404:
            return "gone", None
        if resp.status_code != 200:
            raise VintedError(f"Item {item_id}: HTTP {resp.status_code}: {resp.text[:200]}")
        item = resp.json().get("item", {}) or {}
        if item.get("is_sold") or (item.get("status") == "sold"):
            return "sold", item
        if item.get("is_closed"):
            # closed without a sold flag: withdrawn by seller, or sold —
            # Vinted hides the distinction on some domains. Treat as closed.
            return "closed", item
        return "active", item

    def fetch_image(self, url: str) -> tuple[bytes, str]:
        """Download a listing photo. Returns (bytes, media_type)."""
        self._throttle()
        resp = self.session.get(url, timeout=30)
        resp.raise_for_status()
        media_type = resp.headers.get("Content-Type", "image/jpeg").split(";")[0].strip()
        if media_type not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
            media_type = "image/jpeg"
        return resp.content, media_type


def params_from_url(url: str) -> list[tuple[str, str]]:
    """Turn a copied vinted catalog URL into API search params.

    Build your search on the website (text, brand, colour, size, price filters),
    copy the address bar URL, and pass it here — the query string keys map 1:1
    onto the catalog API (search_text, brand_ids[], color_ids[], catalog[],
    price_from, price_to, size_ids[], status_ids[], currency).
    """
    qs = urlsplit(url).query
    if not qs:
        raise ValueError("That URL has no query string — copy the full catalog search URL.")
    return [(k, v) for k, v in parse_qsl(qs, keep_blank_values=False)]


def domain_from_url(url: str) -> str | None:
    host = urlsplit(url).hostname
    return host if host and "vinted" in host else None
