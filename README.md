# vinted-pulse

Market research for Vinted sellers. Watch a clothing niche — say, *blue Ralph
Lauren shirts* — and for every listing that appears, vinted-pulse records:

- **Final price and time-to-sale** — listings are snapshotted on every poll
  (including price drops) and a `check` pass detects when they sell or close.
- **First-photo quality** — Claude vision classifies how the cover photo was
  shot: flat lay / hanging / worn / mannequin, where it was taken (bed, floor,
  plain backdrop, outdoors…), lighting, clutter, and a 1–5 quality score.
- **Description traits** — length class, whether measurements are mentioned
  (pit-to-pit, cm, chest/längd…), condition words, flavour words
  ("stunning", "klassisk", "timeless"…), hashtags, emoji. English + Swedish.

The `report` command then correlates all of that: sell-through and median
sold price per photo style, and per description trait — so you can see what
actually moves inventory in your niche before you list your own.

## Install

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e .
export ANTHROPIC_API_KEY=sk-ant-...   # only needed for photo analysis
```

## Usage

**1. Create a watch.** The best way is to build the search on vinted.se in
your browser (search text + brand filter + colour filter + category), then
copy the URL — every filter carries over:

```sh
vinted-pulse watch add --name rl-blue-shirts \
  --url "https://www.vinted.se/catalog?search_text=ralph%20lauren%20shirt&brand_ids[]=88&color_ids[]=9"
```

Or just plain text (less precise — no colour/brand filter):

```sh
vinted-pulse watch add --name rl-blue-shirts --text "ralph lauren shirt blue"
```

**2. Poll regularly.** `run` = fetch new listings + check tracked ones for
sales. Put it on cron, e.g. every 2 hours:

```sh
vinted-pulse run
# crontab: 0 */2 * * * cd ~/vinted-pulse && .venv/bin/vinted-pulse run >> pulse.log 2>&1
```

New listings get their description fetched and analyzed immediately (free,
heuristic). When a listing disappears or is flagged sold/closed, the last
seen price is recorded as the final price and time-to-sale is computed from
the listing's photo upload timestamp.

**3. Analyze photos.** Runs Claude vision (`claude-opus-4-8`) on cover photos
that haven't been classified yet. By default only sold/closed items (the data
points that matter most), capped at 25 per run for cost control:

```sh
vinted-pulse analyze            # sold/closed items only
vinted-pulse analyze --all --limit 100   # active listings too
```

**4. Read the report:**

```sh
vinted-pulse report             # all watches
vinted-pulse report --watch 1   # one watch
vinted-pulse report --json      # machine-readable
```

Example output:

```
Report — rl-blue-shirts
=======================
Tracked: 184   active: 121   sold/closed: 55   gone: 8
Final prices (n=51): median 180.0, mean 196.4, range 80.0–450.0
Time to sell (n=51): median 6.2d, fastest 0.3d, slowest 41.8d

By first-photo style:
  flat_lay         18/41 sold (43.9%), median sold 175.0
  worn_on_person   12/19 sold (63.2%), median sold 220.0
  hanging          9/27 sold (33.3%), median sold 160.0

By description trait:
  has_measurements     24/38 sold (63.2%)
  mentions_condition   30/61 sold (49.2%)
  has_flavour_words    19/44 sold (43.2%)
  length_short         21/70 sold (30.0%)
  length_medium        25/52 sold (48.1%)
  length_long          9/14 sold (64.3%)
```

## How it works

- Vinted has no official API; this uses the same public JSON endpoints the
  website itself calls (`/api/v2/catalog/items`, `/api/v2/items/{id}`) with
  an anonymous browser session. Requests are rate-limited (~1 every 2–3.5 s
  with jitter) and back off on 429s.
- "Sold" vs "closed": when a listing has an explicit sold flag we record
  `sold`; if it's closed without one (some domains hide the distinction) we
  record `closed`; a 404 means `gone` (deleted). Reports group sold + closed
  together since for market research both mean "off the market" — the
  separate `gone` bucket excludes deletions from the stats.
- Everything is stored in a local SQLite file (`vinted_pulse.db`, override
  with `--db` or `VINTED_DB`). Price changes are kept as a history per item.

## Caveats

- Run it from a residential IP (your own machine). Vinted's bot protection
  (DataDome) commonly blocks datacenter/cloud IPs, which is why this is a
  cron-on-your-laptop tool rather than a GitHub Actions workflow.
- Polling every 1–2 hours is plenty. Time-to-sale resolution is bounded by
  your check frequency.
- This is for personal market research at low volume. Be polite: don't crank
  the rate limits down, don't run dozens of watches in parallel.

## Tests

```sh
python -m unittest discover tests
```
