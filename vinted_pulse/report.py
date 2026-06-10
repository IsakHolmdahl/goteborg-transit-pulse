"""Aggregate what sold, for how much, how fast — and what the winners had in
common (photo style, description traits)."""

from __future__ import annotations

import json
import statistics
import time
from collections import defaultdict


def build_report(conn, watch_id: int | None = None) -> dict:
    where = "WHERE 1=1"
    args: list = []
    if watch_id is not None:
        where += " AND watch_id = ?"
        args.append(watch_id)

    rows = conn.execute(f"SELECT * FROM items {where}", args).fetchall()
    sold = [r for r in rows if r["status"] in ("sold", "closed")]
    active = [r for r in rows if r["status"] == "active"]

    report = {
        "generated_at": int(time.time()),
        "tracked": len(rows),
        "active": len(active),
        "sold_or_closed": len(sold),
        "gone": sum(1 for r in rows if r["status"] == "gone"),
        "sold_prices": _price_stats(sold),
        "days_to_sell": _speed_stats(sold),
        "photo_presentation": _photo_breakdown(rows),
        "description": _description_breakdown(rows),
    }
    return report


def _price_stats(sold) -> dict:
    prices = [r["final_price"] for r in sold if r["final_price"] is not None]
    if not prices:
        return {"count": 0}
    return {
        "count": len(prices),
        "min": min(prices),
        "median": round(statistics.median(prices), 2),
        "mean": round(statistics.mean(prices), 2),
        "max": max(prices),
    }


def _speed_stats(sold) -> dict:
    days = []
    for r in sold:
        start = r["listed_at"] or r["first_seen"]
        if start and r["closed_at"]:
            days.append((r["closed_at"] - start) / 86400)
    if not days:
        return {"count": 0}
    return {
        "count": len(days),
        "fastest_days": round(min(days), 1),
        "median_days": round(statistics.median(days), 1),
        "slowest_days": round(max(days), 1),
    }


def _photo_breakdown(rows) -> dict:
    """Sell-through and median price per photo presentation style."""
    buckets: dict[str, dict] = defaultdict(lambda: {"total": 0, "sold": 0, "prices": []})
    for r in rows:
        if not r["photo_analysis_json"]:
            continue
        pa = json.loads(r["photo_analysis_json"])
        b = buckets[pa.get("presentation", "unknown")]
        b["total"] += 1
        if r["status"] in ("sold", "closed"):
            b["sold"] += 1
            if r["final_price"] is not None:
                b["prices"].append(r["final_price"])
    out = {}
    for key, b in sorted(buckets.items()):
        out[key] = {
            "tracked": b["total"],
            "sold": b["sold"],
            "sell_through_pct": round(100 * b["sold"] / b["total"], 1),
            "median_sold_price": round(statistics.median(b["prices"]), 2) if b["prices"] else None,
        }
    return out


def _description_breakdown(rows) -> dict:
    """How description traits correlate with selling."""
    traits = {
        "has_measurements": lambda d: d.get("has_measurements"),
        "mentions_condition": lambda d: d.get("mentions_condition"),
        "has_flavour_words": lambda d: d.get("flavour_word_count", 0) > 0,
        "length_short": lambda d: d.get("length_class") == "short",
        "length_medium": lambda d: d.get("length_class") == "medium",
        "length_long": lambda d: d.get("length_class") == "long",
    }
    counts = {name: {"total": 0, "sold": 0} for name in traits}
    for r in rows:
        if not r["desc_analysis_json"]:
            continue
        d = json.loads(r["desc_analysis_json"])
        for name, pred in traits.items():
            if pred(d):
                counts[name]["total"] += 1
                if r["status"] in ("sold", "closed"):
                    counts[name]["sold"] += 1
    out = {}
    for name, c in counts.items():
        if c["total"] == 0:
            continue
        out[name] = {
            "tracked": c["total"],
            "sold": c["sold"],
            "sell_through_pct": round(100 * c["sold"] / c["total"], 1),
        }
    return out


def format_report(report: dict, watch_name: str | None = None) -> str:
    lines = []
    title = f"Report — {watch_name}" if watch_name else "Report — all watches"
    lines.append(title)
    lines.append("=" * len(title))
    lines.append(
        f"Tracked: {report['tracked']}   active: {report['active']}   "
        f"sold/closed: {report['sold_or_closed']}   gone: {report['gone']}"
    )

    p = report["sold_prices"]
    if p.get("count"):
        lines.append(
            f"Final prices (n={p['count']}): median {p['median']}, "
            f"mean {p['mean']}, range {p['min']}–{p['max']}"
        )
    s = report["days_to_sell"]
    if s.get("count"):
        lines.append(
            f"Time to sell (n={s['count']}): median {s['median_days']}d, "
            f"fastest {s['fastest_days']}d, slowest {s['slowest_days']}d"
        )

    if report["photo_presentation"]:
        lines.append("")
        lines.append("By first-photo style:")
        for style, b in report["photo_presentation"].items():
            price = f", median sold {b['median_sold_price']}" if b["median_sold_price"] else ""
            lines.append(
                f"  {style:<16} {b['sold']}/{b['tracked']} sold "
                f"({b['sell_through_pct']}%){price}"
            )

    if report["description"]:
        lines.append("")
        lines.append("By description trait:")
        for trait, b in report["description"].items():
            lines.append(
                f"  {trait:<20} {b['sold']}/{b['tracked']} sold ({b['sell_through_pct']}%)"
            )

    if not report["photo_presentation"]:
        lines.append("")
        lines.append("(no photo analysis yet — run: vinted-pulse analyze)")
    return "\n".join(lines)
