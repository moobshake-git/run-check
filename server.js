// Run Check — "Should I run now?" for Singapore runners.
// Zero dependencies. Node 18+.  Usage:  node server.js   (optional env: DATA_GOV_SG_API_KEY, PORT)
const http = require("http");
const fs = require("fs");
const path = require("path");

const API = "https://api-open.data.gov.sg/v2/real-time/api";
const KEY = process.env.DATA_GOV_SG_API_KEY || "";
const PORT = Number(process.env.PORT) || 3000;
const TTL_MS = 60_000; // one upstream fetch per feed per minute, shared by all visitors
const SLOW_TTL_MS = 10 * 60_000; // multi-hour forecasts change a few times a day
const FEEDS = ["two-hr-forecast", "air-temperature", "relative-humidity", "rainfall", "psi"];
const SLOW_FEEDS = new Set(["twenty-four-hr-forecast", "four-day-outlook"]);
const FETCH_TIMEOUT_MS = 8_000;   // give up on a hung upstream connection
const RETRY_AFTER_MS = 30_000;    // after a failure, serve cached data this long before trying upstream again
const MAX_STALE_MS = 15 * 60_000; // never serve live readings older than this
const MAX_STALE_SLOW_MS = 6 * 3_600_000;

// ---------- upstream rate limiter (6 req / 10 s without key, 12 with a dev key) ----------
const LIMIT = KEY ? 12 : 6, WINDOW_MS = 10_000;
const sent = [];
async function slot() {
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0] > WINDOW_MS) sent.shift();
    if (sent.length < LIMIT) { sent.push(now); return; }
    await new Promise((r) => setTimeout(r, WINDOW_MS - (now - sent[0]) + 50));
  }
}
async function upstream(feed) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await slot();
    const res = await fetch(`${API}/${feed}`, { headers: KEY ? { "x-api-key": KEY } : {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    return res;
  }
}

// ---------- upstream fetch with cache ----------
const cache = new Map(); // feed -> { at, data, pending, retryAt }

async function getFeed(feed) {
  const slow = SLOW_FEEDS.has(feed);
  const ttl = slow ? SLOW_TTL_MS : TTL_MS;
  const maxStale = slow ? MAX_STALE_SLOW_MS : MAX_STALE_MS;
  const c = cache.get(feed) || {};
  const now = Date.now();
  if (c.data && now - c.at < ttl) return c.data;
  if (c.pending) return c.pending;
  // Recently failed: back off and keep serving cached data (if not too old) instead of hammering upstream.
  if (c.retryAt > now) {
    if (c.data && now - c.at < maxStale) return c.data;
    throw new Error(`${feed}: upstream unavailable, retrying in ${Math.ceil((c.retryAt - now) / 1000)}s`);
  }
  const pending = (async () => {
    try {
      const res = await upstream(feed);
      if (!res.ok) throw new Error(`${feed}: HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== 0 || !json.data) throw new Error(`${feed}: bad payload`);
      cache.set(feed, { at: Date.now(), data: json.data });
      return json.data;
    } catch (err) {
      const prev = cache.get(feed) || {};
      const retryAt = Date.now() + RETRY_AFTER_MS;
      if (prev.data && Date.now() - prev.at < maxStale) {
        console.warn(`Using stale ${feed}:`, err.message);
        cache.set(feed, { at: prev.at, data: prev.data, retryAt });
        return prev.data;
      }
      cache.set(feed, { retryAt }); // too old to trust: drop it
      throw err;
    }
  })();
  cache.set(feed, { ...c, pending });
  return pending;
}


// ---------- logic (shared with the static page) ----------
const { buildConditions, buildPlan } = require("./public/core.js");

// Rebuilt only when a feed object changes or a minute passes (reading-age checks depend on the clock).
let memo = { feeds: [], minute: -1, value: null };

async function conditions() {
  const feeds = await Promise.all(FEEDS.map(getFeed));
  const minute = Math.floor(Date.now() / 60_000);
  if (!memo.value || memo.minute !== minute || feeds.some((d, i) => d !== memo.feeds[i])) {
    memo = { feeds, minute, value: buildConditions(feeds) };
  }
  // When the data was actually fetched from upstream (the oldest live feed), not when this response was built.
  const oldest = Math.min(...FEEDS.map((f) => (cache.get(f) && cache.get(f).at) || Date.now()));
  return { ...memo.value, fetchedAt: new Date(oldest).toISOString(), stale: Date.now() - oldest > 2 * TTL_MS };
}

async function plan(areaName) {
  const [base, f24, f4] = await Promise.all([conditions(), getFeed("twenty-four-hr-forecast"), getFeed("four-day-outlook")]);
  const area = base.areas.find((a) => a.name === areaName);
  if (!area) return null;
  return buildPlan(area, memo.feeds[0], f24, f4); // memo.feeds[0] = 2-hr forecast already loaded by conditions()
}

// ---------- http ----------
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(PORT, () => {
  // Warm the cache so the first visitor doesn't wait on the upstream rate limit.
  Promise.all([...FEEDS, ...SLOW_FEEDS].map((f) => getFeed(f).catch(() => {})));
  console.log(`Run Check on http://localhost:${PORT}${KEY ? "" : "  (no API key: rate-limited, set DATA_GOV_SG_API_KEY)"}`);
});

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end("Bad request"); }
  if (url.pathname === "/api/conditions") {
    try {
      const body = JSON.stringify(await conditions());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=30" });
      res.end(body);
    } catch (err) {
      console.error(err);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Couldn't reach data.gov.sg right now. Try again in a minute." }));
    }
    return;
  }
  if (url.pathname === "/api/plan") {
    try {
      const p = await plan(url.searchParams.get("area") || "");
      if (!p) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Unknown area" })); }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=30" });
      res.end(JSON.stringify(p));
    } catch (err) {
      console.error(err);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Couldn't load the forecast right now." }));
    }
    return;
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}
