/**
 * Göteborg Transit Pulse — Västtrafik proxy Worker
 * --------------------------------------------------
 * A tiny Cloudflare Worker that:
 *   1. Holds your Västtrafik OAuth client credentials in encrypted env vars
 *      (never exposed to the browser, never in the GitHub repo).
 *   2. Acquires + caches an access token via OAuth2 client_credentials.
 *   3. Proxies a small allowlist of Planera Resa v4 endpoints to the dashboard,
 *      with brief edge caching to stay polite to upstream rate limits.
 *
 * Endpoints (all GET):
 *   /api/health                       liveness probe (no upstream call)
 *   /api/locations?q=<text>           Västtrafik /pr/v4/locations/by-text
 *   /api/departures/:gid?limit=15     Västtrafik /pr/v4/stop-areas/:gid/departures
 *   /api/situations                   Västtrafik /ts/v1/traffic-situations
 *
 * Required env (set as encrypted secrets via `wrangler secret put` or the dashboard):
 *   VT_CLIENT_ID, VT_CLIENT_SECRET
 *
 * Optional env (plain vars in wrangler.toml [vars]):
 *   ALLOWED_ORIGIN  e.g. "https://isakholmdahl.github.io"
 *                   defaults to "*" for development
 *
 * Author: built for IsakHolmdahl/goteborg-transit-pulse
 */

export interface Env {
  VT_CLIENT_ID: string;
  VT_CLIENT_SECRET: string;
  ALLOWED_ORIGIN?: string;
}

/* ------------------------------------------------------------------ */
/* Token cache — module scope persists across requests in same isolate */
/* ------------------------------------------------------------------ */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  // Refresh ~60s before expiry to avoid edge cases.
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.value;
  }

  const basic = btoa(`${env.VT_CLIENT_ID}:${env.VT_CLIENT_SECRET}`);
  const res = await fetch("https://ext-api.vasttrafik.se/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OAuth token request failed: ${res.status} ${txt.slice(0, 200)}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

/* ------------------------------------------------------------------ */
/* Upstream proxy with one automatic retry on 401 (token rotation)    */
/* ------------------------------------------------------------------ */
async function callVT(env: Env, url: string): Promise<Response> {
  const fire = async () => {
    const token = await getAccessToken(env);
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      // Workers' edge cache. Vasttrafik responses don't set strong
      // cache headers; we set our own short TTL.
      cf: { cacheTtl: 15, cacheEverything: true },
    });
  };

  let res = await fire();
  if (res.status === 401) {
    cachedToken = null;
    res = await fire();
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* CORS                                                                */
/* ------------------------------------------------------------------ */
function corsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body: unknown, env: Env, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(env),
      ...extra,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (req.method !== "GET") {
      return jsonResponse({ error: "method not allowed" }, env, 405);
    }

    try {
      // ---------- /api/health ----------
      if (url.pathname === "/api/health") {
        return jsonResponse(
          {
            ok: true,
            tokenCached: !!cachedToken,
            tokenExpiresInSec: cachedToken
              ? Math.max(0, Math.round((cachedToken.expiresAt - Date.now()) / 1000))
              : null,
            now: new Date().toISOString(),
          },
          env
        );
      }

      // ---------- /api/locations?q=... ----------
      if (url.pathname === "/api/locations") {
        const q = url.searchParams.get("q");
        if (!q) return jsonResponse({ error: "missing q" }, env, 400);
        const upstream = `https://ext-api.vasttrafik.se/pr/v4/locations/by-text?q=${encodeURIComponent(
          q
        )}&limit=10&types=stoparea`;
        const r = await callVT(env, upstream);
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: {
            "Content-Type": r.headers.get("Content-Type") ?? "application/json",
            "Cache-Control": "public, max-age=86400",
            ...corsHeaders(env),
          },
        });
      }

      // ---------- /api/departures/:gid ----------
      const depMatch = url.pathname.match(/^\/api\/departures\/([^/]+)$/);
      if (depMatch) {
        const gid = depMatch[1];
        const limit = url.searchParams.get("limit") ?? "20";
        const upstream =
          `https://ext-api.vasttrafik.se/pr/v4/stop-areas/${encodeURIComponent(gid)}/departures` +
          `?maxDeparturesPerLineAndDirection=2&limit=${encodeURIComponent(limit)}` +
          `&includeOccupancy=false`;
        const r = await callVT(env, upstream);
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: {
            "Content-Type": r.headers.get("Content-Type") ?? "application/json",
            "Cache-Control": "public, max-age=15",
            ...corsHeaders(env),
          },
        });
      }

      // ---------- /api/situations ----------
      if (url.pathname === "/api/situations") {
        // TrafficSituations v1 is a separate API product; if the user's
        // subscription doesn't include it the upstream returns 401/403
        // and we surface that to the client without breaking the page.
        const upstream = `https://ext-api.vasttrafik.se/ts/v1/traffic-situations`;
        const r = await callVT(env, upstream);
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: {
            "Content-Type": r.headers.get("Content-Type") ?? "application/json",
            "Cache-Control": "public, max-age=60",
            ...corsHeaders(env),
          },
        });
      }

      return jsonResponse({ error: "not found" }, env, 404);
    } catch (err: any) {
      return jsonResponse({ error: "proxy_error", message: String(err?.message ?? err) }, env, 502);
    }
  },
};
