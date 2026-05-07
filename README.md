# Göteborg Transit Pulse

Live dashboard of Gothenburg public transit (Västtrafik) — punctuality analytics, live departure boards at the city's major hubs, and active service disruptions. Hosted free on GitHub Pages, data refreshed every 10 minutes by GitHub Actions, live API calls proxied through a free Cloudflare Worker.

**Live:** https://isakholmdahl.github.io/goteborg-transit-pulse/
**API proxy:** https://goteborg-transit-pulse-api.\<your-cf-account>.workers.dev

## How it's wired

```
┌───────────────────┐
│  GitHub Pages     │   ← static dashboard (index.html, app.js, styles.css)
│  this repo, root  │     reads /data/rollups/*.json + calls Worker
└────────┬──────────┘
         │
         │ live API calls       static reads
         ▼                              ▼
┌───────────────────┐          ┌──────────────────────┐
│ Cloudflare Worker │          │ /data/snapshots/*.json│
│  (worker/)        │          │ /data/rollups/*.json  │
│  OAuth token mgmt │          │ committed by Actions  │
│  proxies to VT    │          └──────────▲────────────┘
└────────┬──────────┘                     │
         │                                │ commits
         ▼                                │
┌──────────────────────────┐    ┌────────┴──────────────┐
│ Västtrafik Planera Resa  │    │  GitHub Actions       │
│ ext-api.vasttrafik.se    │◄───┤  cron */10 * * * *    │
└──────────────────────────┘    │  scripts/snapshot.mjs │
                                └───────────────────────┘
```

## Repo layout

```
.
├── index.html              # dashboard entry (served by GH Pages)
├── styles.css
├── app.js                  # ← edit WORKER_URL after first deploy
├── data/
│   ├── snapshots/          # daily JSON, written by Actions
│   ├── rollups/            # pre-computed analytics, written by daily Actions
│   └── latest.json         # most recent snapshot (also written by Actions)
├── scripts/
│   ├── snapshot.mjs        # GH Actions: every 10 min
│   ├── rollup.mjs          # GH Actions: daily 03:00
│   ├── resolve-stops.mjs   # one-shot: stop name → GID
│   ├── stops.json          # stops we sample (Brunnsparken, etc.)
│   └── lib.mjs             # OAuth + retry helpers
├── .github/workflows/
│   ├── snapshot.yml
│   └── rollup.yml
└── worker/
    ├── src/index.ts        # Cloudflare Worker (TypeScript)
    ├── wrangler.toml
    ├── package.json
    └── tsconfig.json
```

## First-time deploy (≈15 min)

You need a Västtrafik Planera Resa v4 subscription (Client ID + Secret), a free Cloudflare account, and this GitHub repo.

### 1. Push the code

```bash
cd "Västtrafik Data/repo"
git init
git remote add origin https://github.com/IsakHolmdahl/goteborg-transit-pulse.git
git add .
git commit -m "Initial commit"
git push -u origin main
```

### 2. Add the GitHub Actions secrets

In the repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**

| Name              | Value                                  |
|-------------------|----------------------------------------|
| `VT_CLIENT_ID`    | Västtrafik Planera Resa Client ID      |
| `VT_CLIENT_SECRET`| Västtrafik Planera Resa Client Secret  |

> ⚠️ If these credentials were ever pasted in a chat (including with me), **rotate them on developer.vasttrafik.se first** — open your subscription → Regenerate keys.

### 3. Deploy the Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login           # opens a browser to your Cloudflare account
npx wrangler deploy          # publishes the Worker, prints the public URL
```

Set the same two secrets on the Worker:

```bash
npx wrangler secret put VT_CLIENT_ID
npx wrangler secret put VT_CLIENT_SECRET
```

(or use the Cloudflare dashboard → your Worker → Settings → Variables and Secrets)

### 4. Wire the dashboard to the Worker

Open `app.js` and replace this line near the top:

```js
const WORKER_URL = "https://goteborg-transit-pulse-api.YOUR-CF-ACCOUNT.workers.dev";
```

with the URL `wrangler deploy` printed in step 3. Commit + push.

### 5. Turn on GitHub Pages

In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch → main / / (root) → Save**

After ~1 min the dashboard is live at `https://isakholmdahl.github.io/goteborg-transit-pulse/`.

### 6. Watch the first scheduled run

The snapshot Action runs at `*/10 * * * *` UTC. If you don't want to wait, trigger one manually:

In the repo → **Actions → Snapshot Västtrafik data → Run workflow → main → Run**.

## Verifying credentials before deploy (optional)

This single command on your Mac will tell you whether your credentials work, without committing them anywhere:

```bash
curl -sS -u "$VT_CLIENT_ID:$VT_CLIENT_SECRET" \
  -d 'grant_type=client_credentials' \
  https://ext-api.vasttrafik.se/token
```

You should see a JSON body with `"access_token": "..."` and `"expires_in": 3600`. If you see `{ "error": "invalid_client" }`, the credentials are wrong (or rotated). If you get a 200 with a token, you're good.

## How to verify the Worker after deploy

```bash
curl -sS https://goteborg-transit-pulse-api.<your-acc>.workers.dev/api/health
# → {"ok":true,"tokenCached":false,...}

curl -sS https://goteborg-transit-pulse-api.<your-acc>.workers.dev/api/locations?q=Brunnsparken
# → JSON with results
```

## Cost

| Component                  | Tier      | Monthly cost |
|----------------------------|-----------|--------------|
| GitHub Pages               | Free      | $0           |
| GitHub Actions (public)    | Free      | $0           |
| Cloudflare Workers         | Free      | $0           |
| Västtrafik Planera Resa v4 | Free tier | $0           |
| **Total**                  |           | **$0**       |

## Notes

- The "On time" threshold is set to ≤ 2 minutes late. Adjust `ON_TIME_THRESHOLD` in `scripts/rollup.mjs` if you want stricter or looser bookkeeping.
- `traffic-situations` is a separate API product on the developer portal. If your subscription doesn't include it, the dashboard will show "no active disruptions" and the Worker logs will show 401/403 from `/api/situations`. You can add the subscription on developer.vasttrafik.se without redeploying anything.
- Stop GIDs in `scripts/stops.json` are filled in automatically on the first scheduled run. If you want different stops, edit the file and change `gid` back to `null` for the stops you want to re-resolve.
>>>>>>> 5d49d5d (Initial commit)
