// Build a representative daily global flight-volume series -> daily.json
//
// IMPORTANT: these are MODELED representative values, not measured counts.
// They reproduce well-known real-world shape: a weekly cycle, a Northern-summer
// seasonal peak, the 2020 COVID-19 collapse + multi-year recovery, and slow
// long-term growth. To use REAL measurements instead, replace the `counts`
// array with daily totals from a source such as the OpenSky Network REST API
// (/flights/all aggregated per day) or Eurocontrol (Europe). Keep the same
// { start, counts } shape and the globe will pick it up unchanged.
const fs = require("fs");
const path = require("path");

const START = new Date(Date.UTC(2019, 0, 1));
// Through today (UTC) — the modeled history is only meaningful up to "now".
const now = new Date();
const END = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// COVID multiplier on the long-term baseline.
function covid(ms) {
  const d = (y, m, day) => Date.UTC(y, m, day);
  if (ms < d(2020, 1, 20)) return 1;                    // pre-pandemic
  if (ms < d(2020, 3, 12)) return 1 - 0.78 * smoothstep(d(2020, 1, 20), d(2020, 3, 12), ms); // collapse
  if (ms < d(2020, 4, 30)) return 0.22;                 // trough
  if (ms < d(2021, 11, 1)) return 0.22 + 0.50 * smoothstep(d(2020, 4, 30), d(2021, 11, 1), ms); // recovery 0.22->0.72
  if (ms < d(2023, 6, 1)) return 0.72 + 0.28 * smoothstep(d(2021, 11, 1), d(2023, 6, 1), ms);   // ->1.0
  return 1.0;
}

const counts = [];
for (let t = +START; t <= +END; t += 86400000) {
  const date = new Date(t);
  const year = date.getUTCFullYear();
  const doy = Math.floor((t - Date.UTC(year, 0, 0)) / 86400000);
  const dow = date.getUTCDay();

  const yearsFrom2019 = (t - +START) / (365.25 * 86400000);
  const baseline = 185000 + 3300 * yearsFrom2019;           // slow long-term growth
  const seasonal = 1 + 0.11 * Math.sin(((doy - 80) / 365) * 2 * Math.PI); // summer peak
  const weekly = [0.99, 1.0, 1.0, 1.0, 1.02, 0.95, 0.92][dow]; // Sat/Sun a touch lower
  const noise = 1 + (Math.sin(t * 0.7) * 0.5 + Math.sin(t * 1.9) * 0.5) * 0.012;

  const c = Math.round((baseline * covid(t) * seasonal * weekly * noise) / 100) * 100;
  counts.push(c);
}

const out = {
  meta: {
    modeled: true,
    note: "Representative modeled daily commercial-flight volume, not measured. See scripts/build-daily.js to swap in real data.",
    unit: "flights/day (approx)",
    days: counts.length,
  },
  start: "2019-01-01",
  counts,
};
fs.writeFileSync(path.join(__dirname, "..", "daily.json"), JSON.stringify(out));
console.log("days:", counts.length, "| min:", Math.min(...counts), "| max:", Math.max(...counts));
console.log("bytes:", fs.statSync(path.join(__dirname, "..", "daily.json")).size);
