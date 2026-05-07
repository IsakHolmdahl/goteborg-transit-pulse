/**
 * Rollup script — runs daily at 03:00 Stockholm via GitHub Actions.
 *
 * Reads:  data/snapshots/*.json (per-day arrays of snapshots)
 * Writes: data/rollups/punctuality-7d.json
 *         data/rollups/disruptions-30d.json
 *         data/rollups/trend-30d.json
 *         data/rollups/heatmap-14d.json
 *         data/rollups/trivia-latest.json
 *
 * All output is small JSON (a few KB each) optimised for direct fetch
 * by the static dashboard.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const SNAP_DIR = path.join(repoRoot, "data", "snapshots");
const ROLL_DIR = path.join(repoRoot, "data", "rollups");

const ON_TIME_THRESHOLD = 2; // minutes; ≤ threshold counts as on time

async function main() {
  const files = (await readdir(SNAP_DIR).catch(() => []))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  if (files.length === 0) {
    console.warn("No snapshots yet — nothing to roll up.");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  /* Load all snapshots, keyed by day */
  const byDay = {};
  for (const f of files) {
    try {
      const arr = JSON.parse(await readFile(path.join(SNAP_DIR, f), "utf8"));
      if (Array.isArray(arr)) byDay[f.replace(".json", "")] = arr;
    } catch (e) {
      console.warn(`skip ${f}: ${e.message}`);
    }
  }

  await mkdir(ROLL_DIR, { recursive: true });

  /* ---------- punctuality-7d.json ---------- */
  const days7 = pastDays(today, 7);
  const punct = aggregateByLine(byDay, days7);
  await writeFile(
    path.join(ROLL_DIR, "punctuality-7d.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        windowDays: 7,
        threshold: ON_TIME_THRESHOLD,
        lines: punct
          .filter((p) => p.samples >= 5)
          .sort((a, b) => b.onTimePct - a.onTimePct),
      },
      null,
      2
    )
  );

  /* ---------- trend-30d.json ---------- */
  const days30 = pastDays(today, 30);
  const trend = days30.map((d) => {
    const snaps = byDay[d] ?? [];
    let total = 0,
      onTime = 0;
    for (const snap of snaps) {
      for (const stop of Object.values(snap.stops ?? {})) {
        for (const dep of stop.departures ?? []) {
          if (dep.cancelled) continue;
          total++;
          if ((dep.delayMin ?? 0) <= ON_TIME_THRESHOLD) onTime++;
        }
      }
    }
    return { date: d, onTimePct: total ? +((onTime / total) * 100).toFixed(1) : null, samples: total };
  });
  await writeFile(
    path.join(ROLL_DIR, "trend-30d.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), days: trend }, null, 2)
  );

  /* ---------- disruptions-30d.json ---------- */
  // Approximation: each unique situation contributes (endTime − startTime) minutes
  // to each line it affects. If endTime is null, we use the snapshot's own ts as
  // a lower-bound observation.
  const seen = new Map(); // id → {start, lastSeen, end, lines}
  for (const day of days30) {
    for (const snap of byDay[day] ?? []) {
      const tsMs = +new Date(snap.ts);
      for (const sit of snap.situations ?? []) {
        const id = sit.id ?? `${sit.title}-${sit.startTime}`;
        if (!seen.has(id)) {
          seen.set(id, {
            id,
            title: sit.title,
            severity: sit.severity ?? "undefined",
            start: sit.startTime ? +new Date(sit.startTime) : tsMs,
            end: sit.endTime ? +new Date(sit.endTime) : tsMs,
            lastSeen: tsMs,
            lines: new Set(sit.affectedLines ?? []),
          });
        } else {
          const e = seen.get(id);
          if (sit.endTime) e.end = Math.max(e.end, +new Date(sit.endTime));
          e.lastSeen = Math.max(e.lastSeen, tsMs);
          (sit.affectedLines ?? []).forEach((l) => e.lines.add(l));
        }
      }
    }
  }
  const lineMin = new Map(); // line -> {count, totalMinutes}
  for (const e of seen.values()) {
    const minutes = Math.max(0, Math.round((Math.max(e.end, e.lastSeen) - e.start) / 60000));
    for (const l of e.lines) {
      const cur = lineMin.get(l) ?? { line: l, count: 0, totalMinutes: 0 };
      cur.count++;
      cur.totalMinutes += minutes;
      lineMin.set(l, cur);
    }
  }
  const disruptionsByLine = [...lineMin.values()].sort((a, b) => b.totalMinutes - a.totalMinutes);
  await writeFile(
    path.join(ROLL_DIR, "disruptions-30d.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        windowDays: 30,
        totalSituations: seen.size,
        byLine: disruptionsByLine,
      },
      null,
      2
    )
  );

  /* ---------- heatmap-14d.json ---------- */
  const days14 = pastDays(today, 14);
  const heat = {}; // line -> Array(24) of {sumDelay, samples}
  for (const day of days14) {
    for (const snap of byDay[day] ?? []) {
      for (const stop of Object.values(snap.stops ?? {})) {
        for (const dep of stop.departures ?? []) {
          if (dep.cancelled || !dep.plannedTime) continue;
          const hr = new Date(dep.plannedTime).getHours();
          const line = dep.line ?? "?";
          if (!heat[line]) heat[line] = Array.from({ length: 24 }, () => ({ s: 0, n: 0 }));
          heat[line][hr].s += dep.delayMin ?? 0;
          heat[line][hr].n++;
        }
      }
    }
  }
  const heatOut = {};
  for (const [line, hours] of Object.entries(heat)) {
    heatOut[line] = hours.map((h) => (h.n ? +(h.s / h.n).toFixed(2) : null));
  }
  await writeFile(
    path.join(ROLL_DIR, "heatmap-14d.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), windowDays: 14, lines: heatOut }, null, 2)
  );

  /* ---------- trivia-latest.json ---------- */
  const latestDay = days7[days7.length - 1];
  const latestSnaps = byDay[latestDay] ?? [];
  const latestSnap = latestSnaps[latestSnaps.length - 1];

  // longest single delay we have ever seen across all loaded days
  let longest = { delayMin: 0 };
  for (const day of Object.keys(byDay)) {
    for (const snap of byDay[day] ?? []) {
      for (const stop of Object.values(snap.stops ?? {})) {
        for (const dep of stop.departures ?? []) {
          if (!dep.cancelled && (dep.delayMin ?? 0) > longest.delayMin) {
            longest = {
              delayMin: dep.delayMin,
              line: dep.line,
              direction: dep.direction,
              stop: stop.name,
              ts: dep.estimatedTime ?? snap.ts,
            };
          }
        }
      }
    }
  }

  // busiest stop right now (last snapshot, departures with planned in next hour)
  let busiest = null;
  if (latestSnap) {
    const cutoff = +new Date(latestSnap.ts) + 60 * 60_000;
    let best = -1;
    for (const stop of Object.values(latestSnap.stops ?? {})) {
      const c = (stop.departures ?? []).filter(
        (d) => d.plannedTime && +new Date(d.plannedTime) <= cutoff
      ).length;
      if (c > best) {
        best = c;
        busiest = { name: stop.name, count: c };
      }
    }
  }

  // cancelled today
  const cancelledToday = (byDay[today] ?? []).reduce((acc, snap) => {
    for (const stop of Object.values(snap.stops ?? {})) {
      for (const d of stop.departures ?? []) if (d.cancelled) acc++;
    }
    return acc;
  }, 0);

  // most punctual line in last 7 days
  const sortedAsc = [...punct].filter((p) => p.samples >= 50).sort((a, b) => b.onTimePct - a.onTimePct);
  const mostPunctual = sortedAsc[0] ?? null;

  await writeFile(
    path.join(ROLL_DIR, "trivia-latest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mostPunctualLine: mostPunctual,
        longestSingleDelay: longest.delayMin > 0 ? longest : null,
        busiestStop: busiest,
        cancelledToday,
      },
      null,
      2
    )
  );

  console.log("[rollup] wrote 5 rollups in", ROLL_DIR);
}

function pastDays(today, n) {
  const out = [];
  const base = new Date(today + "T00:00:00Z");
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function aggregateByLine(byDay, days) {
  const map = new Map();
  for (const day of days) {
    for (const snap of byDay[day] ?? []) {
      for (const stop of Object.values(snap.stops ?? {})) {
        for (const dep of stop.departures ?? []) {
          if (dep.cancelled) continue;
          const line = dep.line ?? "?";
          const cur = map.get(line) ?? { line, samples: 0, onTime: 0, totalDelayMin: 0 };
          cur.samples++;
          if ((dep.delayMin ?? 0) <= ON_TIME_THRESHOLD) cur.onTime++;
          cur.totalDelayMin += dep.delayMin ?? 0;
          map.set(line, cur);
        }
      }
    }
  }
  return [...map.values()].map((v) => ({
    ...v,
    onTimePct: v.samples ? +((v.onTime / v.samples) * 100).toFixed(1) : null,
    avgDelayMin: v.samples ? +(v.totalDelayMin / v.samples).toFixed(2) : null,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
