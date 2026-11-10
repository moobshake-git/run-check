---
name: run-check
description: How to run, change and verify the Run Check app (Singapore "should I run now / best time to run" web app built on data.gov.sg real-time weather APIs). Use when working on run-check's server, page, verdict rules, best-time-to-run estimates, data feeds, rate limiting, or attribution.
---

# Run Check

A mobile-first web app for outdoor runners in Singapore. It answers three questions:

- **Run now?** A GO / WAIT / DON'T verdict for your area, with the reasons.
- **Where?** Nearby areas where conditions are better, plus all 47 forecast areas.
- **When?** The best time to run today and tomorrow, with an hour-by-hour strip.

The server is Node 18+ with **no dependencies** and no accounts or database. Keep it that way unless the user asks otherwise.

## Files

- `server.js`: the Node backend (optional; the static page works without it). Its sections, in order:
  - the upstream rate limiter
  - the feed cache (`getFeed`)
  - (verdict and best-time logic live in `public/core.js`)
  - `conditions()`, which serves `/api/conditions`
  - `plan()`, which serves `/api/plan?area=<name>`
  - the HTTP server, which also serves static files from `public/`
- `public/index.html`: the single page, with inline CSS and JS. It supports light and dark themes and uses geolocation with an area dropdown as fallback. Only the chosen area is stored in localStorage.
- `public/core.js`: **all the verdict and best-time logic** (`RULES`, `judge`, `buildConditions`, `buildPlan`, `heatIndexC`, `DIURNAL`, `dist`), written as pure functions. The server loads it with `require` and the page with `<script src="core.js">`. Keep it free of Node-only or browser-only APIs.
- `public/data.js`: the page's data layer. It checks for the Node server (`api/conditions` returning JSON) and uses it if found. Otherwise, as on GitHub Pages, it fetches data.gov.sg directly from the browser with no key, its own 6-per-10s limiter and a localStorage cache. Use relative URLs (`api/...`, `core.js`) so the site works under the `/run-check/` subpath on Pages.
- `.github/workflows/pages.yml`: deploys `public/` to GitHub Pages on every push to `main`.
- `README.md`: user-facing docs, including the rules table and how "best time" is estimated. **Update it whenever you change `RULES`, `DIURNAL` or the feeds.**

## Running it

```bash
node server.js                 # http://localhost:3000
PORT=3999 node server.js       # second instance for curl testing
DATA_GOV_SG_API_KEY=... node server.js
```

In the desktop app, use the Browser pane's `preview_start` with the name `run-check`. It is configured in `Workshop/.claude/launch.json`. The server must be restarted after any `server.js` change, because nothing reloads it automatically.

## Data feeds

Base URL: `https://api-open.data.gov.sg/v2/real-time/api/<feed>`. Responses are `{ code: 0, data }`.

| Feed | Shape | Used for |
|---|---|---|
| `two-hr-forecast` | `area_metadata[]` (47 areas, `label_location`), `items[0].forecasts[]` `{area, forecast}`, `valid_period` | rain now and in the next 2h; the list of areas |
| `air-temperature`, `relative-humidity`, `rainfall` | `stations[]` `{id, name, location}` + `readings[0].data[]` `{stationId, value}`. Rainfall is in mm per 5 min | nearest-station readings |
| `psi` | `regionMetadata[]` (north/south/east/west/central, `labelLocation`), `items[0].readings.psi_twenty_four_hourly` | haze |
| `twenty-four-hr-forecast` | `records[0].general.{temperature,relativeHumidity}.{low,high}`, `periods[]` `{timePeriod{start,end}, regions{<region>:{text}}}` | best-time estimate |
| `four-day-outlook` | `records[0].forecasts[]` `{timestamp, forecast{summary,text}, temperature, relativeHumidity}` | tomorrow's range and rain |

The following feeds **do not exist** at these paths, so don't assume them: WBGT (official heat stress), lightning, flood alerts. Transport data (bus, taxi, carparks) is on LTA DataMall, not here.

## Rules that are easy to break

- **Rate limit.** Upstream allows 6 requests per 10 s without a key and 12 with a dev key, and returns HTTP 429 when exceeded. Every upstream call must go through `upstream()`, which uses the `slot()` limiter. Never call `fetch` on the API directly. Fast feeds are cached for 60 s and the two forecast feeds for 10 min. The cache is warmed when the server starts.
- **`judge()` matches forecast text.** It checks for `thunder`, `heavy` and `/rain|shower|drizzle/`. Any placeholder text you pass as `forecast` must not contain those words. For example, "Dry outside rain hours" would wrongly count as rain.
- **Time zone.** All hour logic is in SGT (UTC+8), worked out by hand with `sgtParts()` and `sgtIso()`. Don't use the server's local time, because it may be deployed in UTC.
- **Heat index is an estimate** made from temperature and humidity, using the Rothfusz formula. It is not WBGT. Keep the on-page disclaimer saying so.
- **Licence (Singapore Open Data Licence v1.0).** The page footer must keep:
  - the data source (NEA via data.gov.sg)
  - the date and time of access
  - a link to `https://data.gov.sg/open-data-licence`
  - a notice that the app is not affiliated with or endorsed by NEA or the Singapore Government

  Don't remove these when redesigning.
- **Untrusted text.** Area and station names from the API go through `esc()` before being inserted into HTML.

## Changing verdict thresholds

Edit `RULES` in `public/core.js`. The current values (heat index WAIT ≥ 34 °C, DON'T ≥ 41 °C; PSI 101 / 201; rain ≥ 2 mm in 5 min counts as heavy) are **starting guesses, not validated with runners**. Say so if asked. When you change them, update the table in the README.

## Best-time estimate (`plan()`)

- It covers start hours from 5am to 9pm (`RUN_HOURS`), for the rest of today and tomorrow.
- Temperature and humidity: the daily low and high are spread across the day using `DIURNAL`, a hand-written typical Singapore curve that is 0 at 6am and 1 at 2pm. The next few hours are adjusted toward the current station reading, and that adjustment fades to nothing over 6 h.
- Rain priority: the 2-hour area forecast, then the 24-hour region period, then the 4-day outlook. For the outlook, words like "morning", "afternoon", "evening" or "night" in the summary limit the rain to those hours (`outlookApplies`).
- The suggested window is the best verdict, then the coolest hour, widened to adjacent hours with the same verdict and a heat index within 1.5 °C (up to 3 h).

## Verifying a change

1. Run `node --check server.js`.
2. Start a test instance and query it:
   ```bash
   PORT=3999 node server.js & sleep 4
   curl -s localhost:3999/api/conditions | head -c 500
   curl -s "localhost:3999/api/plan?area=Bishan" | head -c 800
   kill %1
   ```
   On a cold start `/api/plan` can take about 10 s because of the rate limiter.
3. Restart the preview, then in the Browser pane at the `mobile` preset (375×812) check:
   - the verdict card
   - the "Best time to run" cards and hour strip
   - "Better places"
   - that there are no console errors

   Reset the viewport to `desktop` afterwards.
