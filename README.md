# Run Check

"Should I run now?" for outdoor runners in Singapore. It combines NEA's live data from data.gov.sg (2-hour forecast, temperature, humidity, rainfall and PSI) into a GO / WAIT / DON'T verdict for your area, and lists nearby areas where conditions are better.

## Run it

```bash
node server.js
```

Open http://localhost:3000. Requires Node 18+ and has no dependencies.

Optional: get an API key from data.gov.sg. Without one the API allows 6 requests per 10 seconds; with one you get more.

```bash
DATA_GOV_SG_API_KEY=your-key node server.js
```

The server caches each feed for 60 s, so all visitors share about 5 upstream calls per minute.

## Hosting on GitHub Pages (no server)

The `public/` folder works on its own as static files. Without the Node server, the page fetches data.gov.sg directly from the visitor's browser (the API allows this) and runs the same logic from `public/core.js`.

- `.github/workflows/pages.yml` deploys `public/` on every push to `main`. In the repo, set **Settings → Pages → Source** to **GitHub Actions**.
- Static mode never uses an API key, because anything in the page is public. Each visitor stays within the keyless limit (6 requests per 10 s) on their own. The first visit can take about 10 seconds because the page needs 7 feeds; after that, the feeds are cached in the browser.

## Verdict rules

These are in `RULES` in `public/core.js`. They are starting guesses, so tune them with real runners.

| Signal | WAIT | DON'T |
|---|---|---|
| Heat index ("feels like") | ≥ 34 °C | ≥ 41 °C |
| 2-hr forecast | rain / showers / drizzle | thundery or heavy |
| Rain gauge, last 5 min | > 0 mm | ≥ 2 mm |
| 24h PSI | ≥ 101 | ≥ 201 |

## Best time to run

`/api/plan?area=<name>` estimates each running hour (5am–9pm, today and tomorrow):

- **Temperature and humidity** come from the 24-hour forecast's daily range (or the 4-day outlook's range for tomorrow). The range is spread across the day using Singapore's typical daily curve (`DIURNAL` in `public/core.js`: coolest around 6am, hottest around 2pm), then adjusted toward the current station reading. That adjustment fades out over 6 hours.
- **Rain** comes from the 2-hour forecast for the area, then the 24-hour forecast for the region (in 6–12 hour blocks), then the 4-day outlook. For the outlook, phrases like "Afternoon thundery showers" are applied only to those hours.
- Each hour gets the same GO / WAIT / DON'T rules. The suggested window is the best verdict, then the coolest, widened to neighbouring hours that are as good (up to 3 hours).

NEA doesn't publish hourly forecasts, so these times are estimates.

The heat index is estimated from temperature and humidity. It is **not** the official WBGT heat-stress reading.

## Licence and attribution

The data is under the Singapore Open Data Licence v1.0. The page footer carries the required attribution and a no-endorsement notice. Keep it if you change the UI.
