// Vercel serverless function: real-time aircraft from community ADS-B (adsb.lol).
//
// Returns a compact, sampled snapshot of aircraft currently airborne, MEASURED
// from the adsb.lol feed (live ADS-B). We query several regional centres in
// parallel (adsb.lol has no single global endpoint) and merge/dedupe by hex,
// so coverage is dense over busy airspaces (Europe, N.America, E/S Asia, Gulf,
// Oceania, S.America) and sparse over open ocean — which is honest for ADS-B.
//
// Why not OpenSky? OpenSky refuses TCP connections from Vercel's datacenter IPs
// (UND_ERR_CONNECT_TIMEOUT) and only allows browser CORS from its own domain,
// so it's unreachable both from the server and the client here.

const UA = "neon-earth/1.0 (+https://earth-iota-three.vercel.app)";
const MAX_SAMPLE = 900;

// [lat, lon, distance(nm)] regional centres covering the busiest airspaces.
// adsb.lol rate-limits hard, so we keep the count modest and fetch with low
// concurrency (see runLimited) rather than firing them all at once.
// Ordered for geographic spread first, so if the rate limit clips the tail we
// still keep wide coverage rather than losing one whole hemisphere.
const REGIONS = [
  [50, 8, 550],    // Europe
  [40, -95, 800],  // North America (central — wide radius covers E + W)
  [31, 112, 650],  // East / SE Asia
  [-15, -55, 750], // South America
  [20, 80, 650],   // South Asia (India) + Gulf edge
];

// Run async tasks with limited concurrency and a small gap between starts,
// to stay under adsb.lol's rate limit.
async function runLimited(tasks, limit, gapMs) {
  const out = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

// 0 Asia, 1 Europe, 2 Africa, 3 N.America, 4 S.America, 5 Oceania, 6 Other
function continentOf(lon, lat) {
  if (lat < -60) return 6;
  if (lon >= -93 && lon <= -32 && lat >= -57 && lat <= 14) return 4;
  if (lon >= -170 && lon <= -50 && lat > 14 && lat <= 84) return 3;
  if (lon >= -130 && lon <= -58 && lat >= 7 && lat <= 33) return 3;
  if (lon >= -25 && lon <= 40 && lat >= 36 && lat <= 72) return 1;
  if (lon >= -20 && lon <= 52 && lat >= -37 && lat < 36) return 2;
  if (lon >= 110 && lon <= 180 && lat >= -50 && lat <= 0) return 5;
  if (lon >= 40 && lon <= 180 && lat >= -10 && lat <= 82) return 0;
  if (lon >= 25 && lon < 40 && lat >= 36) return 0;
  return 6;
}

let cache = { at: 0, body: null };

// Serverless egress can hang on IPv6; force IPv4 with a connect timeout.
let dispatcherSet = false;
function ensureIPv4() {
  if (dispatcherSet) return;
  dispatcherSet = true;
  try {
    const { Agent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(new Agent({ connect: { family: 4, timeout: 8000 } }));
  } catch (_) { /* fall back to default */ }
}

async function fetchRegion(lat, lon, dist) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const url = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    return j.ac || [];
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  ensureIPv4();
  res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=60");

  if (cache.body && Date.now() - cache.at < 15000) {
    return res.status(200).json(cache.body);
  }

  try {
    const results = await runLimited(
      REGIONS.map(([la, lo, d]) => () => fetchRegion(la, lo, d)),
      1,     // concurrency — adsb.lol rate-limits ~1 req/s
      1200,  // gap between requests (ms)
    );

    // Per region: keep airborne aircraft with a position, dedupe globally by hex.
    const seen = new Set();
    const perRegionValid = results.map((list) => {
      const valid = [];
      for (const a of list) {
        if (!a || a.lat == null || a.lon == null || a.alt_baro === "ground") continue;
        if (a.hex) { if (seen.has(a.hex)) continue; seen.add(a.hex); }
        valid.push(a);
      }
      return valid;
    });

    const count = perRegionValid.reduce((n, v) => n + v.length, 0);
    if (!count) throw new Error("no aircraft returned");

    // Sample each region evenly so every covered continent is represented,
    // instead of letting the densest region (Europe) dominate.
    const per = Math.ceil(MAX_SAMPLE / REGIONS.length);
    const sample = [];
    for (const valid of perRegionValid) {
      const step = Math.max(1, Math.floor(valid.length / per));
      let taken = 0;
      for (let i = 0; i < valid.length && taken < per && sample.length < MAX_SAMPLE; i += step) {
        const a = valid[i];
        const track = (a.track != null ? a.track : (a.true_heading != null ? a.true_heading : 0));
        const velMs = (a.gs != null ? a.gs : 0) * 0.514444; // knots -> m/s
        sample.push([
          Math.round(a.lon * 100) / 100,
          Math.round(a.lat * 100) / 100,
          Math.round(track),
          Math.round(velMs),
          continentOf(a.lon, a.lat),
        ]);
        taken++;
      }
    }
    const body = { time: Math.floor(Date.now() / 1000), count, sampled: sample.length, source: "adsb.lol", sample };
    cache = { at: Date.now(), body };
    return res.status(200).json(body);
  } catch (err) {
    if (cache.body) return res.status(200).json(cache.body); // serve stale on error
    const cause = err && err.cause ? (err.cause.code || String(err.cause)) : null;
    return res.status(502).json({ error: "live data unavailable", detail: String((err && err.message) || err), cause });
  }
};
