/**
 * Resolves stop names to GIDs via /pr/v4/locations/by-text and writes them
 * back into scripts/stops.json. Run once after first deploy:
 *
 *   VT_CLIENT_ID=... VT_CLIENT_SECRET=... node scripts/resolve-stops.mjs
 *
 * Idempotent: skips entries that already have a gid.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { vtGet, PR_BASE } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const STOPS_PATH = path.join(here, "stops.json");

async function main() {
  const cfg = JSON.parse(await readFile(STOPS_PATH, "utf8"));
  let changed = false;

  for (const s of cfg.stops) {
    if (s.gid) {
      console.log(`✓ ${s.key} already has gid ${s.gid}`);
      continue;
    }
    const url = `${PR_BASE}/locations/by-text?q=${encodeURIComponent(s.name)}&limit=5&types=stoparea`;
    const res = await vtGet(url);
    const list = res.results ?? res ?? [];
    const hit =
      list.find((x) => x.locationType === "stoparea" || x.type === "stoparea") ||
      list[0];
    if (!hit?.gid) {
      console.warn(`✗ no gid found for "${s.name}"`);
      continue;
    }
    s.gid = hit.gid;
    s.resolvedName = hit.name;
    console.log(`+ ${s.key}: ${hit.name} → ${hit.gid}`);
    changed = true;
  }

  if (changed) {
    await writeFile(STOPS_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    console.log("Wrote stops.json");
  } else {
    console.log("No changes.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
