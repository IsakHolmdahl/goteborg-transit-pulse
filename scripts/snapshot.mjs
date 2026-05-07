/**
 * Snapshot script — runs every 10 min via GitHub Actions.
 *
 * Fetches:
 *   1. Departure boards for every stop in stops.json
 *   2. Active traffic situations (if subscription allows; otherwise skipped gracefully)
 * Writes:
 *   data/snapshots/YYYY-MM-DD.json   — appended (rewrite-with-array)
 *   data/latest.json                 — just the most recent snapshot, for the dashboard
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { vtGet, vtTry, PR_BASE, TS_BASE, todayInStockholm } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const STOPS_PATH = path.join(here, "stops.json");
const SNAP_DIR = path.join(repoRoot, "data", "snapshots");
const LATEST = path.join(repoRoot, "data", "latest.json");

async function main() {
  const cfg = JSON.parse(await readFile(STOPS_PATH, "utf8"));
  const stops = cfg.stops.filter((s) => s.gid);
  if (stops.length === 0) {
    throw new Error("No stops have GIDs yet — run `node scripts/resolve-stops.mjs` first.");
  }

  const ts = new Date().toISOString();
  const snapshot = { ts, stops: {}, situations: [], situationsStatus: "ok", stats: null };

  // 1. Departures per stop, in parallel
  const depResults = await Promise.allSettled(
    stops.map(async (s) => {
      const url =
        `${PR_BASE}/stop-areas/${encodeURIComponent(s.gid)}/departures` +
        `?maxDeparturesPerLineAndDirection=2&limit=20&includeOccupancy=false`;
      const res = await vtGet(url);
      const items = (res.results ?? res ?? []).map(normalizeDeparture);
      return { key: s.key, name: s.resolvedName ?? s.name, gid: s.gid, departures: items };
    })
  );

  let departuresTotal = 0,
    onTime = 0,
    late = 0,
    cancelled = 0;

  for (let i = 0; i < depResults.length; i++) {
    const r = depResults[i];
    const meta = stops[i];
    if (r.status === "fulfilled") {
      const v = r.value;
      snapshot.stops[v.key] = v;
      for (const d of v.departures) {
        departuresTotal++;
        if (d.cancelled) cancelled++;
        else if (d.delayMin > 2) late++;
        else onTime++;
      }
    } else {
      snapshot.stops[meta.key] = {
        key: meta.key,
        name: meta.name,
        gid: meta.gid,
        error: String(r.reason?.message ?? r.reason),
        departures: [],
      };
    }
  }

  snapshot.stats = {
    departuresTotal,
    onTime,
    late,
    cancelled,
    onTimePct: departuresTotal ? +((onTime / departuresTotal) * 100).toFixed(1) : null,
  };

  // 2. Traffic situations (best-effort; skip if not subscribed)
  const sitRes = await vtTry(`${TS_BASE}/traffic-situations`);
  if (sitRes.ok) {
    snapshot.situations = (Array.isArray(sitRes.data) ? sitRes.data : sitRes.data?.results ?? [])
      .map(normalizeSituation)
      .slice(0, 100);
    snapshot.situationsStatus = "ok";
  } else {
    snapshot.situations = [];
    snapshot.situationsStatus = `unavailable (${sitRes.status}): ${sitRes.error?.slice(0, 120)}`;
  }

  // 3. Persist
  await mkdir(SNAP_DIR, { recursive: true });
  const dayFile = path.join(SNAP_DIR, `${todayInStockholm()}.json`);
  let arr = [];
  if (existsSync(dayFile)) {
    try {
      arr = JSON.parse(await readFile(dayFile, "utf8"));
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = [];
    }
  }
  arr.push(snapshot);
  await writeFile(dayFile, JSON.stringify(arr) + "\n", "utf8");
  await writeFile(LATEST, JSON.stringify(snapshot, null, 2) + "\n", "utf8");

  console.log(
    `[snapshot] ts=${ts} stops=${stops.length} dep=${departuresTotal} ` +
      `(on-time=${onTime} late=${late} cancelled=${cancelled}) ` +
      `situations=${snapshot.situations.length} (${snapshot.situationsStatus})`
  );
}

/* ------------------------- normalisation ------------------------- */

function normalizeDeparture(d) {
  // The exact field paths in /pr/v4 may shift slightly; pull defensively.
  const sj = d.serviceJourney ?? {};
  const line = sj.line ?? {};
  const sp = d.stopPoint ?? {};
  const planned = d.plannedTime ?? d.scheduledTime ?? null;
  const estimated = d.estimatedTime ?? d.realTime ?? planned;
  const delayMin =
    planned && estimated && estimated !== planned
      ? Math.round((new Date(estimated) - new Date(planned)) / 60000)
      : 0;
  return {
    detailsRef: d.detailsReference ?? null,
    line: line.designation ?? line.shortName ?? line.name ?? "?",
    lineName: line.name ?? null,
    transportMode: line.transportMode ?? sj.transportMode ?? null,
    direction: sj.direction ?? sj.directionDetails?.direction ?? null,
    platform: sp.platform ?? d.stopPoint?.platform ?? null,
    plannedTime: planned,
    estimatedTime: estimated,
    delayMin,
    cancelled: !!(d.isCancelled ?? d.cancelled ?? sj.isCancelled ?? false),
  };
}

function normalizeSituation(s) {
  const lines = s.affectedLines ?? s.affectedLineGroups ?? [];
  return {
    id: s.situationNumber ?? s.id ?? null,
    title: s.title ?? s.summary ?? null,
    description: s.description ?? null,
    severity: s.severity ?? "undefined",
    creationTime: s.creationTime ?? s.startTime ?? null,
    startTime: s.startTime ?? null,
    endTime: s.endTime ?? null,
    affectedLines: lines.map((l) => l.designation ?? l.name ?? l).filter(Boolean),
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
