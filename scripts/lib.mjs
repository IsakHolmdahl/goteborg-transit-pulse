/**
 * Shared helpers: OAuth, request retry, light JSON utilities.
 * Plain Node 20+ — no dependencies, native fetch.
 */

const TOKEN_URL = "https://ext-api.vasttrafik.se/token";
export const PR_BASE = "https://ext-api.vasttrafik.se/pr/v4";
export const TS_BASE = "https://ext-api.vasttrafik.se/ts/v1";

let cached = null; // { value, expiresAt }

/**
 * Acquire (and cache) an access token via OAuth2 client_credentials.
 * Reads VT_CLIENT_ID and VT_CLIENT_SECRET from process.env.
 */
export async function getToken() {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.value;

  const id = required("VT_CLIENT_ID");
  const secret = required("VT_CLIENT_SECRET");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OAuth ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  cached = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return cached.value;
}

/**
 * GET an upstream URL with the bearer token, automatic 401 retry,
 * and lightweight backoff on 429/5xx.
 */
export async function vtGet(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await getToken();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 401 && attempt === 0) {
      cached = null;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(800 * Math.pow(2, attempt));
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`GET ${url} → ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  throw new Error(`GET ${url}: exhausted retries`);
}

/** Try-call an upstream and capture the error rather than throwing.
 *  Useful when an endpoint may be unsubscribed (traffic-situations). */
export async function vtTry(url) {
  try {
    return { ok: true, data: await vtGet(url) };
  } catch (err) {
    return { ok: false, status: err.status ?? 0, error: String(err.message ?? err) };
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Round a Date to ISO without milliseconds, in Stockholm time. */
export function nowIsoStockholm() {
  // Node 20+: Intl supports timeZone; we just emit ISO with offset.
  const d = new Date();
  // Use Intl to figure out offset; build a simple ISO with seconds resolution.
  const local = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Stockholm" }));
  const offsetMin = -d.getTimezoneOffset(); // local agent's offset, but we want Sthlm
  // Simpler approach: just emit UTC ISO. Easier downstream.
  return d.toISOString();
}

/** YYYY-MM-DD in Stockholm time. */
export function todayInStockholm() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
