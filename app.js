/**
 * Göteborg Transit Pulse — dashboard front-end.
 * Pulls live boards / situations from the Worker, and analytics
 * from /data/rollups/*.json (committed by GitHub Actions).
 *
 * IMPORTANT: After your first `wrangler deploy`, replace WORKER_URL below
 * with the URL Cloudflare prints (something like
 *   https://goteborg-transit-pulse-api.<your-account>.workers.dev
 * ).
 */

const WORKER_URL = "https://vt-pulse.workers.dev";

/* ------------------------- line colours ------------------------- */
// Västtrafik tram line colours; buses get a uniform yellow.
const TRAM_COLORS = {
  1: "#5e646a",
  2: "#fde500",
  3: "#0086cd",
  4: "#009d3a",
  5: "#e30613",
  6: "#f59331",
  7: "#a4459a",
  8: "#ec0d8b",
  9: "#76b82a",
  10: "#0094d2",
  11: "#000000",
  13: "#a87532",
};
const BUS_COLOR = "#bf9000";
function lineColor(d) {
  if (TRAM_COLORS[d]) return TRAM_COLORS[d];
  return BUS_COLOR;
}
function isDarkText(hex) {
  // simple luminance check
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16),
    g = parseInt(c.slice(2, 4), 16),
    b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128;
}

/* ------------------------- helpers ------------------------- */
const $ = (id) => document.getElementById(id);
const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
};
const sinceText = (iso) => {
  if (!iso) return "";
  const sec = (Date.now() - +new Date(iso)) / 1000;
  if (sec < 60) return `${Math.round(sec)} sec ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
};

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

/* ------------------------- state ------------------------- */
const state = {
  stops: [], // [{key,name,gid}]
  activeStop: null, // key
  latest: null, // /data/latest.json
};

/* ------------------------- bootstrap ------------------------- */
async function init() {
  // 1. Load latest snapshot — gives us stop metadata + current KPIs
  try {
    state.latest = await getJSON("data/latest.json?t=" + Date.now());
    state.stops = Object.values(state.latest.stops ?? {});
    state.activeStop = state.stops[0]?.key ?? null;
  } catch (e) {
    console.warn("No latest.json yet — first snapshot may not have run.", e);
    renderEmpty(
      "Waiting for the first snapshot to land. The GitHub Action runs every 10 minutes — refresh in a moment.",
    );
    return;
  }

  renderTabs();
  renderKpisFromLatest();
  renderDisruptionsFromLatest();
  await refreshActiveBoard();
  await loadAnalytics();

  // Periodic live refresh of the visible board + situations
  setInterval(refreshActiveBoard, 30_000);
  setInterval(refreshSituations, 60_000);
  setInterval(updateLastUpdated, 5_000);
  updateLastUpdated();
}

function renderEmpty(msg) {
  $("board").innerHTML = `<div class="empty">${msg}</div>`;
  $("disr-list").innerHTML = `<div class="empty">${msg}</div>`;
  $("live-pulse").classList.add("stalled");
}

/* ------------------------- KPIs ------------------------- */
function renderKpisFromLatest() {
  const s = state.latest?.stats;
  const departures = s?.departuresTotal ?? 0;
  $("kpi-departures").querySelector(".val").textContent = departures;
  const ontime = s?.onTimePct ?? null;
  $("kpi-ontime").querySelector(".val").textContent =
    ontime != null ? ontime.toFixed(1) + "%" : "—";
  // disruptions
  const sits = state.latest?.situations ?? [];
  const major = sits.filter((x) => /sev|major/i.test(x.severity ?? "")).length;
  const minor = sits.length - major;
  $("kpi-disruptions").querySelector(".val").textContent = sits.length;
  $("kpi-disruptions").querySelector(".delta").textContent =
    `${major} major · ${minor} other`;
  if (sits.length === 0) $("kpi-disruptions").classList.add("good");
  else if (sits.length > 5) $("kpi-disruptions").classList.add("bad");
  else $("kpi-disruptions").classList.add("warn");
  $("snapshot-count").textContent = "—"; // populated by analytics later if we expose it
}

/* ------------------------- Tabs ------------------------- */
function renderTabs() {
  const tabs = $("tabs");
  tabs.innerHTML = "";
  for (const s of state.stops) {
    const b = document.createElement("button");
    b.className = "tab" + (s.key === state.activeStop ? " active" : "");
    b.dataset.stop = s.key;
    const lineCount = new Set((s.departures ?? []).map((d) => d.line)).size;
    b.innerHTML = `${escapeHTML(stripCity(s.name))}<span class="stop-meta">${lineCount} lines</span>`;
    b.addEventListener("click", () => {
      state.activeStop = s.key;
      renderTabs();
      refreshActiveBoard();
    });
    tabs.appendChild(b);
  }
}

function stripCity(n) {
  return (n ?? "").replace(/, *Göteborg/i, "");
}

/* ------------------------- Departure board ------------------------- */
async function refreshActiveBoard() {
  if (!state.activeStop) return;
  const stop = state.stops.find((s) => s.key === state.activeStop);
  if (!stop) return;

  let departures;
  try {
    const url = `${WORKER_URL}/api/departures/${encodeURIComponent(stop.gid)}?limit=20`;
    const j = await getJSON(url);
    departures = (j.results ?? j ?? []).map(normalizeDeparture);
  } catch (e) {
    console.warn(
      "live worker fetch failed; falling back to latest snapshot",
      e,
    );
    departures = stop.departures ?? [];
  }

  const board = $("board");
  board.innerHTML = "";
  if (departures.length === 0) {
    board.innerHTML = `<div class="empty">No departures returned.</div>`;
    return;
  }
  for (const d of departures) {
    const c = lineColor(d.line);
    const dark = isDarkText(c);
    const est = d.cancelled ? "—" : fmtTime(d.estimatedTime);
    const planned = fmtTime(d.plannedTime);
    const delay = d.delayMin ?? 0;
    const badge = badgeFor(delay, d.cancelled);
    const estCls = d.cancelled
      ? ""
      : delay > 5
        ? "very-late"
        : delay > 2
          ? "late"
          : "";
    const el = document.createElement("div");
    el.className = "dep";
    el.innerHTML = `
      <div class="line-pill ${dark ? "dark-text" : "light-text"}" style="background:${c}">${escapeHTML(d.line)}</div>
      <div class="dest">
        ${escapeHTML(d.direction || d.lineName || "")}
        ${d.platform ? `<small>läge ${escapeHTML(d.platform)}</small>` : ""}
      </div>
      <div class="time planned" style="text-align:right">${planned}</div>
      <div class="time est ${estCls}" style="text-align:right">${est}</div>
      <div><span class="delay-badge ${badge.cls}">${badge.txt}</span></div>
    `;
    board.appendChild(el);
  }
  state.latest && (state.latest.ts = state.latest.ts); // keep type
  state.lastBoardRefresh = new Date().toISOString();
  updateLastUpdated();
}

function badgeFor(delayMin, cancelled) {
  if (cancelled) return { cls: "cancelled", txt: "INSTÄLLD" };
  if (delayMin <= 0) return { cls: "ontime", txt: "I TID" };
  if (delayMin <= 3) return { cls: "late", txt: `+${delayMin} min` };
  return { cls: "very-late", txt: `+${delayMin} min` };
}

function normalizeDeparture(d) {
  // Accept both raw v4 shape and the normalised shape from snapshot.mjs.
  if (d.lineName != null || d.delayMin != null || d.estimatedTime !== undefined)
    return d;
  const sj = d.serviceJourney ?? {};
  const line = sj.line ?? {};
  const sp = d.stopPoint ?? {};
  const planned = d.plannedTime ?? d.scheduledTime ?? null;
  const estimated = d.estimatedTime ?? d.realTime ?? planned;
  const delay =
    planned && estimated
      ? Math.round((+new Date(estimated) - +new Date(planned)) / 60000)
      : 0;
  return {
    line: line.designation ?? line.shortName ?? line.name ?? "?",
    lineName: line.name ?? null,
    direction: sj.direction ?? null,
    platform: sp.platform ?? null,
    plannedTime: planned,
    estimatedTime: estimated,
    delayMin: delay,
    cancelled: !!(d.isCancelled ?? d.cancelled ?? false),
  };
}

/* ------------------------- Disruptions ------------------------- */
async function refreshSituations() {
  let sits;
  try {
    const j = await getJSON(`${WORKER_URL}/api/situations`);
    sits = (Array.isArray(j) ? j : (j.results ?? [])).map(normalizeSit);
  } catch (e) {
    console.warn("live situations failed; falling back", e);
    sits = state.latest?.situations ?? [];
  }
  renderDisruptions(sits);
}

function renderDisruptionsFromLatest() {
  renderDisruptions(state.latest?.situations ?? []);
}

function renderDisruptions(sits) {
  const list = $("disr-list");
  list.innerHTML = "";
  $("situations-meta").textContent = sits.length
    ? `${sits.length} active`
    : "none active";
  if (sits.length === 0) {
    list.innerHTML = `<div class="empty">No active disruptions right now. 🟢</div>`;
    return;
  }
  // Sort newest first
  sits.sort(
    (a, b) =>
      +new Date(b.creationTime ?? b.startTime ?? 0) -
      +new Date(a.creationTime ?? a.startTime ?? 0),
  );
  for (const s of sits.slice(0, 30)) {
    const firstLine = (s.affectedLines ?? [])[0] ?? "?";
    const c = lineColor(firstLine);
    const dark = isDarkText(c);
    const sev = (s.severity ?? "undefined").toLowerCase();
    const el = document.createElement("div");
    el.className = "disr-item";
    el.innerHTML = `
      <div class="disr-line-pill" style="background:${c};color:${dark ? "#0a0e1a" : "#fff"}">${escapeHTML(firstLine)}</div>
      <div class="disr-body">
        <div class="disr-title">${escapeHTML(s.title || s.description || "(no title)")}</div>
        <div class="disr-meta">
          <span class="sev ${sev}">${escapeHTML(sev)}</span>
          <span>${sinceText(s.creationTime ?? s.startTime)}</span>
          ${s.endTime ? `<span>· until ${escapeHTML(fmtTime(s.endTime))}</span>` : ""}
          ${s.affectedLines?.length > 1 ? `<span>· also: ${s.affectedLines.slice(1, 5).map(escapeHTML).join(", ")}</span>` : ""}
        </div>
      </div>`;
    list.appendChild(el);
  }
}

function normalizeSit(s) {
  if (s.affectedLines) return s;
  const lines = s.affectedLines ?? s.affectedLineGroups ?? [];
  return {
    id: s.situationNumber ?? s.id,
    title: s.title ?? s.summary ?? null,
    description: s.description ?? null,
    severity: s.severity ?? "undefined",
    creationTime: s.creationTime ?? s.startTime ?? null,
    startTime: s.startTime ?? null,
    endTime: s.endTime ?? null,
    affectedLines: lines
      .map((l) => l.designation ?? l.name ?? l)
      .filter(Boolean),
  };
}

/* ------------------------- Analytics (rollups) ------------------------- */
async function loadAnalytics() {
  await Promise.allSettled([
    loadPunctuality(),
    loadDisruptionsByLine(),
    loadTrend(),
    loadHeatmap(),
    loadTrivia(),
  ]);
}

async function loadPunctuality() {
  let data;
  try {
    data = await getJSON("data/rollups/punctuality-7d.json?t=" + Date.now());
  } catch {
    return;
  }
  const lines = (data.lines ?? []).slice(0, 14);
  const labels = lines.map((l) => "Linje " + l.line);
  const values = lines.map((l) => l.onTimePct ?? 0);
  const colors = lines.map((l) => lineColor(l.line));
  new Chart($("punctuality-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.parsed.y.toFixed(1) + "%" } },
      },
      scales: {
        y: {
          min: 75,
          max: 100,
          ticks: { callback: (v) => v + "%" },
          grid: { color: "#1a2342" },
        },
        x: { grid: { display: false } },
      },
    },
  });
}

async function loadDisruptionsByLine() {
  let data;
  try {
    data = await getJSON("data/rollups/disruptions-30d.json?t=" + Date.now());
  } catch {
    return;
  }
  const top = (data.byLine ?? []).slice(0, 8);
  const labels = top.map((x) => "L " + x.line);
  const values = top.map((x) => x.totalMinutes);
  const colors = top.map((x) => lineColor(x.line));
  // Update KPI worst-line
  if (top[0]) {
    $("kpi-worst").querySelector(".val").textContent = "Linje " + top[0].line;
    $("kpi-worst").querySelector(".delta").textContent =
      `${top[0].totalMinutes} min cumul (30d)`;
    $("kpi-worst").classList.add("bad");
  }
  new Chart($("disrupt-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: colors,
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.parsed.x + " min" } },
      },
      scales: {
        x: { ticks: { callback: (v) => v + "m" }, grid: { color: "#1a2342" } },
        y: { grid: { display: false } },
      },
    },
  });
}

async function loadTrend() {
  let data;
  try {
    data = await getJSON("data/rollups/trend-30d.json?t=" + Date.now());
  } catch {
    return;
  }
  const days = data.days ?? [];
  new Chart($("trend-chart"), {
    type: "line",
    data: {
      labels: days.map((d) => d.date.slice(5)),
      datasets: [
        {
          data: days.map((d) => d.onTimePct),
          borderColor: "#3b9eff",
          backgroundColor: "rgba(59,158,255,0.12)",
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => (c.parsed.y ?? 0).toFixed(1) + "%" },
        },
      },
      scales: {
        y: {
          min: 70,
          max: 100,
          ticks: { callback: (v) => v + "%" },
          grid: { color: "#1a2342" },
        },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
      },
    },
  });
}

async function loadHeatmap() {
  let data;
  try {
    data = await getJSON("data/rollups/heatmap-14d.json?t=" + Date.now());
  } catch {
    return;
  }
  const hm = $("heatmap");
  hm.innerHTML = "";
  const lines = Object.keys(data.lines ?? {}).sort((a, b) =>
    numericOrder(a, b),
  );
  // header row
  hm.appendChild(
    Object.assign(document.createElement("div"), { className: "row-lab" }),
  );
  for (let h = 0; h < 24; h++) {
    const c = document.createElement("div");
    c.className = "hour-lab";
    c.textContent = h % 3 === 0 ? h : "";
    hm.appendChild(c);
  }
  for (const l of lines) {
    const lab = document.createElement("div");
    lab.className = "row-lab";
    lab.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${lineColor(l)};margin-right:6px"></span> L ${escapeHTML(l)}`;
    hm.appendChild(lab);
    const hours = data.lines[l] ?? [];
    for (let h = 0; h < 24; h++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const v = hours[h];
      cell.style.background = v == null ? "#1a2342" : heatColor(v);
      cell.title =
        v == null
          ? `L${l} · kl ${h}:00 · n/a`
          : `L${l} · kl ${h}:00 · +${v.toFixed(1)} min`;
      hm.appendChild(cell);
    }
  }
}

function numericOrder(a, b) {
  const ai = parseInt(a, 10),
    bi = parseInt(b, 10);
  if (!isNaN(ai) && !isNaN(bi)) return ai - bi;
  return String(a).localeCompare(String(b));
}

function heatColor(v) {
  const t = Math.max(0, Math.min(v / 6, 1));
  const r = Math.round(26 + (255 - 26) * t);
  const g = Math.round(35 + (94 - 35) * t);
  const b = Math.round(66 + (122 - 66) * t * 0.4);
  return `rgb(${r},${g},${b})`;
}

async function loadTrivia() {
  let data;
  try {
    data = await getJSON("data/rollups/trivia-latest.json?t=" + Date.now());
  } catch {
    return;
  }
  if (data.mostPunctualLine) {
    const l = data.mostPunctualLine;
    $("trivia-punctual").innerHTML =
      `Linje ${escapeHTML(l.line)} <span style="color:var(--good)">${(l.onTimePct ?? 0).toFixed(1)}%</span>`;
    $("trivia-punctual-ctx").textContent = `over ${l.samples ?? 0} departures`;
  }
  if (data.longestSingleDelay) {
    const x = data.longestSingleDelay;
    $("trivia-longest").textContent = `${x.delayMin} min`;
    $("trivia-longest-ctx").textContent =
      `Line ${x.line ?? "?"} at ${stripCity(x.stop ?? "")} · ${new Date(x.ts).toLocaleString("sv-SE")}`;
  }
  if (data.busiestStop) {
    $("trivia-busy").textContent = stripCity(data.busiestStop.name ?? "—");
    $("trivia-busy-ctx").textContent =
      `${data.busiestStop.count} departures in next hour`;
  }
  $("trivia-cancelled").textContent = data.cancelledToday ?? 0;
  $("trivia-cancelled-ctx").textContent = "today";
}

/* ------------------------- last-updated indicator ------------------------- */
function updateLastUpdated() {
  const ref = state.lastBoardRefresh ?? state.latest?.ts;
  $("last-updated").textContent = ref ? sinceText(ref) : "—";
  if (ref && Date.now() - +new Date(ref) > 15 * 60 * 1000) {
    $("live-pulse").classList.add("stalled");
  } else {
    $("live-pulse").classList.remove("stalled");
  }
}

/* ------------------------- util ------------------------- */
function escapeHTML(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

init();
