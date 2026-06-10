"""Command-line interface.

Typical day-to-day:
    vinted-pulse watch add --name rl-blue --url "https://www.vinted.se/catalog?...&color_ids[]=9"
    vinted-pulse run        # poll for new listings + check for sales (cron this)
    vinted-pulse analyze    # photo analysis (Claude) for sold/closed items
    vinted-pulse report
"""

from __future__ import annotations

import argparse
import json
import sys

from . import db
from .analysis import analyze_description
from .vinted import DEFAULT_DOMAIN, VintedClient, VintedError, domain_from_url, params_from_url


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    conn = db.connect(args.db)
    try:
        return args.func(conn, args)
    except VintedError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="vinted-pulse", description=__doc__)
    p.add_argument("--db", default=db.DEFAULT_PATH, help="path to SQLite database")
    sub = p.add_subparsers(required=True)

    watch = sub.add_parser("watch", help="manage watches").add_subparsers(required=True)

    w_add = watch.add_parser("add", help="add a watch from a search")
    w_add.add_argument("--name", required=True, help="short name, e.g. rl-blue-shirts")
    group = w_add.add_mutually_exclusive_group(required=True)
    group.add_argument("--url", help="full vinted catalog URL copied from the browser (best: includes brand/colour filters)")
    group.add_argument("--text", help="plain search text, e.g. 'ralph lauren shirt blue'")
    w_add.add_argument("--domain", default=DEFAULT_DOMAIN, help=f"vinted domain (default {DEFAULT_DOMAIN})")
    w_add.set_defaults(func=cmd_watch_add)

    w_list = watch.add_parser("list", help="list watches")
    w_list.set_defaults(func=cmd_watch_list)

    w_rm = watch.add_parser("remove", help="deactivate a watch")
    w_rm.add_argument("watch_id", type=int)
    w_rm.set_defaults(func=cmd_watch_remove)

    poll = sub.add_parser("poll", help="fetch new listings for all watches")
    poll.set_defaults(func=cmd_poll)

    check = sub.add_parser("check", help="detect sold/closed listings")
    check.add_argument("--max-items", type=int, default=200, help="cap item lookups per run")
    check.set_defaults(func=cmd_check)

    run = sub.add_parser("run", help="poll + check in one go (use with cron)")
    run.add_argument("--max-items", type=int, default=200)
    run.set_defaults(func=cmd_run)

    analyze = sub.add_parser("analyze", help="photo analysis with Claude vision")
    analyze.add_argument("--all", action="store_true",
                         help="analyze active listings too (default: only sold/closed)")
    analyze.add_argument("--limit", type=int, default=25, help="max photos per run (API cost control)")
    analyze.set_defaults(func=cmd_analyze)

    report = sub.add_parser("report", help="show market stats")
    report.add_argument("--watch", type=int, default=None, help="restrict to one watch id")
    report.add_argument("--json", action="store_true", dest="as_json")
    report.set_defaults(func=cmd_report)

    return p


# -- commands ----------------------------------------------------------------

def cmd_watch_add(conn, args) -> int:
    if args.url:
        params = params_from_url(args.url)
        domain = domain_from_url(args.url) or args.domain
    else:
        params = [("search_text", args.text)]
        domain = args.domain
    watch_id = db.add_watch(conn, args.name, domain, params)
    print(f"watch {watch_id} '{args.name}' added on {domain}")
    print("params: " + ", ".join(f"{k}={v}" for k, v in params))
    return 0


def cmd_watch_list(conn, args) -> int:
    rows = db.list_watches(conn, include_inactive=True)
    if not rows:
        print("no watches yet — add one with: vinted-pulse watch add")
        return 0
    for r in rows:
        state = "active" if r["active"] else "inactive"
        n = conn.execute("SELECT COUNT(*) c FROM items WHERE watch_id=?", (r["id"],)).fetchone()["c"]
        print(f"[{r['id']}] {r['name']:<20} {state:<8} {n} items  ({r['domain']})")
    return 0


def cmd_watch_remove(conn, args) -> int:
    db.deactivate_watch(conn, args.watch_id)
    print(f"watch {args.watch_id} deactivated (its items stay in the database)")
    return 0


def cmd_poll(conn, args) -> int:
    clients: dict[str, VintedClient] = {}
    total_new = 0
    for watch in db.list_watches(conn):
        client = clients.setdefault(watch["domain"], VintedClient(watch["domain"]))
        params = json.loads(watch["params_json"])
        items = client.search(params)
        new = 0
        for item in items:
            if conn.execute("SELECT 1 FROM items WHERE id=?", (item["id"],)).fetchone():
                db.upsert_item(conn, watch["id"], item, None, None)
                continue
            # new listing: fetch detail once for the description
            description = None
            state, detail = client.item(item["id"])
            if detail:
                description = detail.get("description")
            db.upsert_item(conn, watch["id"], item, description,
                           analyze_description(description))
            if state in ("sold", "closed", "gone"):
                db.close_item(conn, item["id"], state if state != "gone" else "gone")
            new += 1
        total_new += new
        print(f"watch '{watch['name']}': {len(items)} results, {new} new")
    print(f"poll done — {total_new} new listings tracked")
    return 0


def cmd_check(conn, args) -> int:
    clients: dict[str, VintedClient] = {}
    items = db.active_items(conn)[: args.max_items]
    sold = closed = gone = 0
    for row in items:
        watch = conn.execute("SELECT domain FROM watches WHERE id=?", (row["watch_id"],)).fetchone()
        client = clients.setdefault(watch["domain"], VintedClient(watch["domain"]))
        state, _ = client.item(row["id"])
        if state == "active":
            continue
        db.close_item(conn, row["id"], state)
        if state == "sold":
            sold += 1
        elif state == "closed":
            closed += 1
        else:
            gone += 1
        print(f"  {state}: {row['title']} ({row['url']})")
    print(f"check done — {len(items)} checked, {sold} sold, {closed} closed, {gone} gone")
    return 0


def cmd_run(conn, args) -> int:
    rc = cmd_poll(conn, args)
    return rc or cmd_check(conn, args)


def cmd_analyze(conn, args) -> int:
    import os
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("error: set ANTHROPIC_API_KEY to use photo analysis", file=sys.stderr)
        return 1
    from .analysis import analyze_photo

    rows = db.items_missing_photo_analysis(conn, only_closed=not args.all, limit=args.limit)
    if not rows:
        print("nothing to analyze")
        return 0
    clients: dict[str, VintedClient] = {}
    done = 0
    for row in rows:
        watch = conn.execute("SELECT domain FROM watches WHERE id=?", (row["watch_id"],)).fetchone()
        client = clients.setdefault(watch["domain"], VintedClient(watch["domain"]))
        try:
            image, media_type = client.fetch_image(row["image_url"])
            result = analyze_photo(image, media_type)
        except Exception as e:  # keep going; one bad image shouldn't stop the batch
            print(f"  skip {row['id']}: {e}", file=sys.stderr)
            continue
        db.save_photo_analysis(conn, row["id"], result)
        done += 1
        print(f"  {row['id']}: {result['presentation']} / {result['location']} "
              f"(score {result['quality_score']}) — {result['summary']}")
    print(f"analyze done — {done}/{len(rows)} photos classified")
    return 0


def cmd_report(conn, args) -> int:
    from .report import build_report, format_report

    report = build_report(conn, args.watch)
    if args.as_json:
        print(json.dumps(report, indent=2))
        return 0
    name = None
    if args.watch is not None:
        row = conn.execute("SELECT name FROM watches WHERE id=?", (args.watch,)).fetchone()
        name = row["name"] if row else f"watch {args.watch}"
    print(format_report(report, name))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
