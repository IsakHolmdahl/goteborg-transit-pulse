"""SQLite storage for watches, tracked listings, and price history."""

from __future__ import annotations

import json
import os
import sqlite3
import time

DEFAULT_PATH = os.environ.get("VINTED_DB", "vinted_pulse.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS watches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    domain      TEXT NOT NULL,
    params_json TEXT NOT NULL,           -- [(key, value), ...] catalog query
    created_at  INTEGER NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY,   -- Vinted item id
    watch_id      INTEGER NOT NULL REFERENCES watches(id),
    title         TEXT,
    brand         TEXT,
    size          TEXT,
    url           TEXT,
    image_url     TEXT,                  -- first photo, full resolution
    currency      TEXT,
    listed_at     INTEGER,               -- unix ts (photo upload time)
    first_seen    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',  -- active | sold | closed | gone
    closed_at     INTEGER,               -- when we detected sold/closed/gone
    final_price   REAL,                  -- last price seen before closing
    description   TEXT,
    desc_analysis_json  TEXT,            -- heuristics, computed at insert
    photo_analysis_json TEXT,            -- Claude vision, computed on demand
    photo_analyzed_at   INTEGER
);

CREATE TABLE IF NOT EXISTS price_history (
    item_id INTEGER NOT NULL REFERENCES items(id),
    ts      INTEGER NOT NULL,
    price   REAL NOT NULL,
    PRIMARY KEY (item_id, ts)
);
"""


def connect(path: str = DEFAULT_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


# -- watches ---------------------------------------------------------------

def add_watch(conn, name: str, domain: str, params: list[tuple[str, str]]) -> int:
    cur = conn.execute(
        "INSERT INTO watches (name, domain, params_json, created_at) VALUES (?,?,?,?)",
        (name, domain, json.dumps(params), int(time.time())),
    )
    conn.commit()
    return cur.lastrowid


def list_watches(conn, include_inactive: bool = False) -> list[sqlite3.Row]:
    q = "SELECT * FROM watches" + ("" if include_inactive else " WHERE active = 1")
    return conn.execute(q + " ORDER BY id").fetchall()


def deactivate_watch(conn, watch_id: int) -> None:
    conn.execute("UPDATE watches SET active = 0 WHERE id = ?", (watch_id,))
    conn.commit()


# -- items -----------------------------------------------------------------

def upsert_item(conn, watch_id: int, item: dict, description: str | None,
                desc_analysis: dict | None) -> bool:
    """Insert a newly discovered listing, or refresh last_seen + price for a
    known one. Returns True if the item was new."""
    now = int(time.time())
    item_id = item["id"]
    price = _price_of(item)

    row = conn.execute("SELECT id FROM items WHERE id = ?", (item_id,)).fetchone()
    if row:
        conn.execute("UPDATE items SET last_seen = ? WHERE id = ?", (now, item_id))
        _record_price(conn, item_id, now, price)
        conn.commit()
        return False

    photo = item.get("photo") or {}
    listed_at = (photo.get("high_resolution") or {}).get("timestamp")
    conn.execute(
        """INSERT INTO items (id, watch_id, title, brand, size, url, image_url,
                              currency, listed_at, first_seen, last_seen, status,
                              description, desc_analysis_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?)""",
        (
            item_id,
            watch_id,
            item.get("title"),
            item.get("brand_title"),
            item.get("size_title"),
            item.get("url"),
            photo.get("full_size_url") or photo.get("url"),
            _currency_of(item),
            listed_at,
            now,
            now,
            description,
            json.dumps(desc_analysis) if desc_analysis else None,
        ),
    )
    _record_price(conn, item_id, now, price)
    conn.commit()
    return True


def active_items(conn) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM items WHERE status = 'active' ORDER BY id").fetchall()


def close_item(conn, item_id: int, status: str) -> None:
    """Mark a listing sold/closed/gone, recording the last known price as final."""
    now = int(time.time())
    last = conn.execute(
        "SELECT price FROM price_history WHERE item_id = ? ORDER BY ts DESC LIMIT 1",
        (item_id,),
    ).fetchone()
    conn.execute(
        "UPDATE items SET status = ?, closed_at = ?, final_price = ? WHERE id = ?",
        (status, now, last["price"] if last else None, item_id),
    )
    conn.commit()


def items_missing_photo_analysis(conn, only_closed: bool = False, limit: int | None = None):
    # 'gone' items are excluded from report stats, so never spend API calls on them
    q = ("SELECT * FROM items WHERE photo_analysis_json IS NULL "
         "AND image_url IS NOT NULL AND status != 'gone'")
    if only_closed:
        q += " AND status IN ('sold','closed')"
    q += " ORDER BY closed_at DESC NULLS LAST, first_seen DESC"
    if limit:
        q += f" LIMIT {int(limit)}"
    return conn.execute(q).fetchall()


def save_photo_analysis(conn, item_id: int, analysis: dict) -> None:
    conn.execute(
        "UPDATE items SET photo_analysis_json = ?, photo_analyzed_at = ? WHERE id = ?",
        (json.dumps(analysis), int(time.time()), item_id),
    )
    conn.commit()


def _record_price(conn, item_id: int, ts: int, price: float | None) -> None:
    if price is None:
        return
    last = conn.execute(
        "SELECT price FROM price_history WHERE item_id = ? ORDER BY ts DESC LIMIT 1",
        (item_id,),
    ).fetchone()
    if last is None or abs(last["price"] - price) > 1e-9:
        # OR REPLACE: two observations in the same second keep the newest price
        conn.execute(
            "INSERT OR REPLACE INTO price_history (item_id, ts, price) VALUES (?,?,?)",
            (item_id, ts, price),
        )


def _price_of(item: dict) -> float | None:
    price = item.get("price")
    if isinstance(price, dict):
        try:
            return float(price.get("amount"))
        except (TypeError, ValueError):
            return None
    try:
        return float(price)
    except (TypeError, ValueError):
        return None


def _currency_of(item: dict) -> str | None:
    price = item.get("price")
    if isinstance(price, dict):
        return price.get("currency_code")
    return item.get("currency")
