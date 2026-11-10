// Data layer for the page. Two modes, picked automatically on first load:
//  - "server": the Node server (server.js) is there → use /api/conditions and /api/plan.
//  - "direct": static hosting (e.g. GitHub Pages) → fetch data.gov.sg from the browser and run core.js here.
// Direct mode never uses an API key (it would be public), so it stays within the keyless limit itself.
(function (root) {
  const Core = root.RunCheckCore;
  const API = "https://api-open.data.gov.sg/v2/real-time/api";
  const TTL = { fast: 60_000, slow: 10 * 60_000 };
  const MAX_STALE = { fast: 15 * 60_000, slow: 6 * 3_600_000 };
  const SLOW = new Set(["twenty-four-hr-forecast", "four-day-outlook"]);
  const LIMIT = 6, WINDOW_MS = 10_000; // keyless rate limit per visitor

  let mode = null;
  let lastFeeds = null;
  const mem = {}; // feed -> { at, data }

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem("rc:" + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("rc:" + k, JSON.stringify(v)); } catch {} },
  };

  const sent = [];
  async function slot() {
    for (;;) {
      const now = Date.now();
      while (sent.length && now - sent[0] > WINDOW_MS) sent.shift();
      if (sent.length < LIMIT) { sent.push(now); return; }
      await new Promise((r) => setTimeout(r, WINDOW_MS - (now - sent[0]) + 50));
    }
  }

  async function feed(name) {
    const kind = SLOW.has(name) ? "slow" : "fast";
    const cached = mem[name] || ls.get(name);
    if (cached && Date.now() - cached.at < TTL[kind]) return (mem[name] = cached).data;
    try {
      await slot();
      const res = await fetch(`${API}/${name}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(res.status === 429 ? "data.gov.sg is busy — try again shortly" : `data.gov.sg error ${res.status}`);
      const json = await res.json();
      if (json.code !== 0 || !json.data) throw new Error("Unexpected data from data.gov.sg");
      mem[name] = { at: Date.now(), data: json.data };
      ls.set(name, mem[name]);
      return json.data;
    } catch (err) {
      if (cached && Date.now() - cached.at < MAX_STALE[kind]) return (mem[name] = cached).data;
      throw err;
    }
  }

  // Is our Node server answering? Its API replies with JSON; static hosts reply with an HTML 404.
  async function detect() {
    if (/\.github\.io$/.test(location.hostname)) return { mode: "direct" }; // GitHub Pages: no server to ask
    try {
      const res = await fetch("api/conditions");
      if ((res.headers.get("content-type") || "").includes("application/json")) return { mode: "server", res };
    } catch {}
    return { mode: "direct" };
  }

  async function serverJson(res) {
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Failed to load");
    return json;
  }

  async function getConditions() {
    if (mode === null) {
      const d = await detect();
      mode = d.mode;
      if (d.res) return serverJson(d.res);
    }
    if (mode === "server") return serverJson(await fetch("api/conditions"));

    lastFeeds = await Promise.all(Core.FEEDS.map(feed));
    const oldest = Math.min(...Core.FEEDS.map((f) => mem[f].at));
    return { ...Core.buildConditions(lastFeeds), fetchedAt: new Date(oldest).toISOString(), stale: Date.now() - oldest > 2 * TTL.fast };
  }

  async function getPlan(areaName, conditions) {
    if (mode === "server") return serverJson(await fetch(`api/plan?area=${encodeURIComponent(areaName)}`));
    const area = conditions.areas.find((a) => a.name === areaName);
    if (!area) throw new Error("Unknown area");
    const [f24, f4] = await Promise.all([feed("twenty-four-hr-forecast"), feed("four-day-outlook")]);
    return Core.buildPlan(area, lastFeeds[0], f24, f4);
  }

  root.RunCheckData = { getConditions, getPlan, get mode() { return mode; } };
})(this);
