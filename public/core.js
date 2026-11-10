// Run Check core logic: turns raw data.gov.sg feed payloads into verdicts and best-time plans.
// Pure functions, no I/O. Shared by server.js (require) and index.html (<script src="core.js">),
// so the app works both with the Node server and as static files (e.g. GitHub Pages).
(function (root) {
  // ---------- helpers ----------
  // Approximate distance on Singapore's scale (equirectangular); only used for "nearest" comparisons.
  const dist = (a, b) => Math.hypot(a.latitude - b.latitude, (a.longitude - b.longitude) * Math.cos((a.latitude * Math.PI) / 180));

  // Ignore observations older than this, even if upstream still returns them.
  const MAX_READING_AGE_MS = 30 * 60_000;
  const MAX_PSI_AGE_MS = 3 * 3_600_000; // PSI is hourly
  const tooOld = (iso, maxAge) => !iso || Date.now() - Date.parse(iso) > maxAge;

  // Station feeds -> [{ name, location, value }] using the latest reading set.
  function stationValues(data) {
    const latest = data.readings && data.readings[0];
    if (!latest || tooOld(latest.timestamp, MAX_READING_AGE_MS)) return { at: latest ? latest.timestamp : null, list: [] };
    const byId = new Map(latest.data.map((d) => [d.stationId, d.value]));
    const list = data.stations
      .filter((s) => byId.has(s.id) && typeof byId.get(s.id) === "number")
      .map((s) => ({ name: s.name, location: s.location, value: byId.get(s.id) }));
    return { at: latest.timestamp, list };
  }

  function nearest(list, loc) {
    let best = null, bestD = Infinity;
    for (const item of list) {
      const d = dist(loc, item.location);
      if (d < bestD) { best = item; bestD = d; }
    }
    return best;
  }

  // Heat index (NWS Rothfusz regression), input/output in °C. An estimate — not official WBGT.
  function heatIndexC(tC, rh) {
    const T = tC * 9 / 5 + 32;
    let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
    if ((hi + T) / 2 >= 80) { // NWS: use the full regression when the simple estimate averaged with T is >= 80°F
      hi = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 0.00683783 * T * T
        - 0.05481717 * rh * rh + 0.00122874 * T * T * rh + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
    }
    return Math.round(((hi - 32) * 5 / 9) * 10) / 10;
  }

  // ---------- verdict rules (tweak these) ----------
  const RULES = {
    heatWait: 34,   // heat index °C: run easy / wait for cooler hours
    heatDont: 41,   // heat index °C: danger zone for hard exercise
    psiWait: 101,   // 24h PSI "unhealthy"
    psiDont: 201,   // 24h PSI "very unhealthy"
    rainHeavy: 2,   // mm in the last 5 min at nearest gauge
  };
  const LEVEL = { go: 0, wait: 1, dont: 2 };

  function judge({ forecast, rainNow, heat, psi }) {
    const reasons = [];
    let level = "go";
    const bump = (l, text, kind) => { if (LEVEL[l] > LEVEL[level]) level = l; reasons.push({ level: l, kind, text }); };

    const f = (forecast || "").toLowerCase();
    if (f.includes("thunder")) bump("dont", `Thundery showers forecast for the next 2 hours (${forecast})`, "rain");
    else if (f.includes("heavy")) bump("dont", `Heavy rain forecast for the next 2 hours (${forecast})`, "rain");
    else if (/rain|shower|drizzle/.test(f)) bump("wait", `Rain likely in the next 2 hours (${forecast})`, "rain");

    if (rainNow != null) {
      if (rainNow >= RULES.rainHeavy) bump("dont", `Raining hard nearby right now (${rainNow} mm in 5 min)`, "rain");
      else if (rainNow > 0) bump("wait", `Raining nearby right now (${rainNow} mm in 5 min)`, "rain");
    }

    if (heat != null) {
      if (heat >= RULES.heatDont) bump("dont", `Feels like ${heat}°C — dangerous for hard running`, "heat");
      else if (heat >= RULES.heatWait) bump("wait", `Feels like ${heat}°C — very hot; go easy or wait for cooler hours`, "heat");
      else reasons.push({ level: "go", kind: "heat", text: `Feels like ${heat}°C` });
    }

    if (psi != null) {
      if (psi >= RULES.psiDont) bump("dont", `Haze: 24h PSI ${psi} (very unhealthy)`, "air");
      else if (psi >= RULES.psiWait) bump("wait", `Haze: 24h PSI ${psi} (unhealthy) — cut intensity`, "air");
    }

    if (!reasons.some((r) => r.kind === "rain")) {
      reasons.push(forecast
        ? { level: "go", kind: "rain", text: `No rain expected — ${forecast}` }
        : { level: "go", kind: "rain", text: rainNow === 0 ? "Not raining nearby (no current forecast available)" : "No current rain data available" });
    }
    return { level, reasons };
  }

  // ---------- "run now" for every area ----------
  // feeds = [two-hr-forecast, air-temperature, relative-humidity, rainfall, psi] payloads (the `data` field).
  const FEEDS = ["two-hr-forecast", "air-temperature", "relative-humidity", "rainfall", "psi"];

  function buildConditions([fc, temp, rh, rain, psi]) {
    const fcItem = fc.items[0];
    const fcValid = fcItem && fcItem.valid_period && Date.parse(fcItem.valid_period.end) > Date.now();
    const fcByArea = new Map(fcValid ? fcItem.forecasts.map((x) => [x.area, x.forecast]) : []);
    const T = stationValues(temp), H = stationValues(rh), R = stationValues(rain);
    const psiItem = psi.items[0];
    const psi24 = psiItem && !tooOld(psiItem.timestamp, MAX_PSI_AGE_MS) ? psiItem.readings.psi_twenty_four_hourly : {};
    const regions = psi.regionMetadata.filter((r) => r.name !== "national").map((r) => ({ ...r, location: r.labelLocation }));

    const areas = fc.area_metadata.map((a) => {
      const loc = a.label_location;
      const t = nearest(T.list, loc), h = nearest(H.list, loc), r = nearest(R.list, loc), reg = nearest(regions, loc);
      const heat = t && h ? heatIndexC(t.value, h.value) : null;
      const input = {
        forecast: fcByArea.get(a.name) || null,
        rainNow: r ? r.value : null,
        heat,
        psi: reg && psi24[reg.name] != null ? psi24[reg.name] : null,
      };
      const { level, reasons } = judge(input);
      return {
        name: a.name,
        location: loc,
        level,
        reasons,
        ...input,
        tempC: t ? t.value : null,
        humidity: h ? h.value : null,
        stations: { temp: t && t.name, rain: r && r.name, psiRegion: reg && reg.name },
      };
    });

    const wet = (x) => (x.reasons.some((r) => r.kind === "rain" && r.level !== "go") ? 1 : 0);
    areas.sort((a, b) => LEVEL[a.level] - LEVEL[b.level] || wet(a) - wet(b) || (a.heat ?? 99) - (b.heat ?? 99));

    return {
      forecastPeriod: fcValid ? fcItem.valid_period.text : null,
      observedAt: { temp: T.at, rain: R.at, psi: psiItem ? psiItem.timestamp : null },
      rules: RULES,
      areas,
    };
  }

  // ---------- best time to run (forecast-based estimate) ----------
  // Typical Singapore daily temperature shape: 0 = daily low (~6am), 1 = daily high (~2pm).
  const DIURNAL = [0.30, 0.25, 0.20, 0.15, 0.10, 0.05, 0.00, 0.05, 0.20, 0.40, 0.60, 0.75,
                   0.88, 0.97, 1.00, 0.97, 0.88, 0.75, 0.60, 0.50, 0.43, 0.38, 0.35, 0.32];
  const RUN_HOURS = { first: 5, last: 21 }; // suggest start times from 5am to 9pm
  const HOUR = 3_600_000, SGT = 8 * HOUR;

  const sgtParts = (ms) => { const d = new Date(ms + SGT); return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() }; };
  const sgtIso = (date, hour) => `${date}T${String(hour).padStart(2, "0")}:00:00+08:00`;
  const hourLabel = (h) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`);

  // Which part of the day a 4-day-outlook summary like "Afternoon thundery showers" applies to.
  function outlookApplies(summary, hour) {
    const s = (summary || "").toLowerCase();
    const parts = [];
    if (s.includes("morning")) parts.push([6, 12]);
    if (s.includes("afternoon")) parts.push([12, 19]);
    if (s.includes("evening")) parts.push([18, 22]);
    if (s.includes("night")) parts.push([19, 24], [0, 6]);
    if (!parts.length) return true; // no time-of-day qualifier: whole day
    return parts.some(([a, b]) => hour >= a && hour < b);
  }

  // area: one entry of buildConditions().areas; fc2: two-hr-forecast payload; f24 / f4: 24-hour and 4-day payloads.
  function buildPlan(area, fc2, f24, f4) {
    const region = area.stations.psiRegion || "central";
    const fc2Item = fc2 && fc2.items[0];
    const rec24 = f24.records[0];
    const outlook = (f4.records[0] && f4.records[0].forecasts) || [];
    const now = Date.now();
    const nowP = sgtParts(now);
    const today = nowP.date;
    const tomorrow = sgtParts(now + 24 * HOUR).date;

    function dayRange(date) {
      const o = outlook.find((x) => x.timestamp.slice(0, 10) === date);
      if (date === today || !o) return { t: rec24.general.temperature, rh: rec24.general.relativeHumidity };
      return { t: o.temperature, rh: o.relativeHumidity };
    }
    function rainText(ms, date, hour) {
      const v = fc2Item && fc2Item.valid_period;
      if (v && ms >= Date.parse(v.start) && ms < Date.parse(v.end)) return { text: area.forecast, source: "2-hour forecast" };
      const p = rec24.periods.find((x) => ms >= Date.parse(x.timePeriod.start) && ms < Date.parse(x.timePeriod.end));
      if (p && p.regions[region]) return { text: p.regions[region].text, source: `24-hour forecast (${region})` };
      const o = outlook.find((x) => x.timestamp.slice(0, 10) === date);
      if (o) return outlookApplies(o.forecast.summary, hour)
        ? { text: o.forecast.summary || o.forecast.text, source: "4-day outlook" }
        : { text: "Dry at this hour (per outlook)", source: "4-day outlook" };
      return { text: null, source: "none" };
    }

    // Anchor the curve to what the nearest station reads right now; the correction fades over 6 hours.
    const r0 = dayRange(today);
    const model = (r, h) => ({
      t: r.t.low + (r.t.high - r.t.low) * DIURNAL[h],
      rh: r.rh.high - (r.rh.high - r.rh.low) * DIURNAL[h],
    });
    const m0 = model(r0, nowP.hour);
    const dT = area.tempC != null ? area.tempC - m0.t : 0;
    const dRH = area.humidity != null ? area.humidity - m0.rh : 0;

    const hours = [];
    const startMs = Math.floor((now + SGT) / HOUR) * HOUR - SGT; // top of current SGT hour
    for (let ms = startMs; ; ms += HOUR) {
      const { date, hour } = sgtParts(ms);
      if (date !== today && date !== tomorrow) break;
      if (hour < RUN_HOURS.first || hour > RUN_HOURS.last) continue;
      const fade = Math.max(0, 1 - (ms - startMs) / (6 * HOUR));
      const m = model(dayRange(date), hour);
      const t = Math.round((m.t + dT * fade) * 10) / 10;
      const rh = Math.min(100, Math.max(30, Math.round(m.rh + dRH * fade)));
      const heat = heatIndexC(t, rh);
      const rain = rainText(ms + HOUR / 2, date, hour);
      // For the current hour, rain falling right now counts too (same as the "run now" verdict).
      const { level } = judge({ forecast: rain.text, rainNow: ms === startMs ? area.rainNow : null, heat, psi: area.psi });
      hours.push({ start: sgtIso(date, hour), day: date === today ? "today" : "tomorrow", hour, label: hourLabel(hour), tempC: t, humidity: rh, heat, forecast: rain.text, source: rain.source, level, isNow: ms === startMs });
    }

    // Best window per day: best verdict, then coolest; widen to neighbouring hours that are as good (within 1.5°C).
    function bestWindow(day) {
      const hs = hours.filter((h) => h.day === day);
      if (!hs.length) return null;
      const best = hs.reduce((b, h) => (LEVEL[h.level] < LEVEL[b.level] || (LEVEL[h.level] === LEVEL[b.level] && h.heat < b.heat) ? h : b));
      const b = hs.indexOf(best);
      let i = b, j = b;
      while (i > 0 && hs[i - 1].level === best.level && hs[i - 1].heat <= best.heat + 1.5 && hs[i - 1].hour === hs[i].hour - 1) i--;
      while (j < hs.length - 1 && hs[j + 1].level === best.level && hs[j + 1].heat <= best.heat + 1.5 && hs[j + 1].hour === hs[j].hour + 1) j++;
      // At most 3 hours, always containing the best hour.
      const s = Math.max(i, Math.min(b, j - 2));
      const win = hs.slice(s, Math.min(j, s + 2) + 1);
      const last = win[win.length - 1];
      return {
        day, level: best.level,
        from: win[0].label, to: hourLabel((last.hour + 1) % 24),
        heatRange: [Math.min(...win.map((h) => h.heat)), Math.max(...win.map((h) => h.heat))],
        forecast: best.forecast, startsNow: win[0].isNow,
      };
    }

    return {
      area: area.name, region,
      generatedAt: new Date().toISOString(),
      best: { today: bestWindow("today"), tomorrow: bestWindow("tomorrow") },
      hours,
      note: "Estimated hour by hour from NEA's 24-hour forecast and 4-day outlook (6–12 hour forecast blocks and daily temperature ranges), anchored to the current station reading. A guide, not a promise.",
    };
  }

  const core = { FEEDS, RULES, LEVEL, dist, heatIndexC, judge, buildConditions, buildPlan };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  else root.RunCheckCore = core;
})(this);
