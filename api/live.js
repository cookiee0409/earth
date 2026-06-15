// Vercel serverless function: real-time aircraft from the OpenSky Network.
//
// Returns a compact, sampled snapshot of aircraft currently airborne worldwide.
// This is MEASURED live data (unlike the modeled daily.json history).
//
// Auth: if OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET env vars are set, uses
// OAuth2 client-credentials (higher rate limits). Otherwise falls back to
// anonymous access, which works but is rate-limited — so we cache hard at the
// edge (s-maxage) and in warm-lambda memory to share one upstream call.

const STATES_URL = "https://opensky-network.org/api/states/all";
const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const MAX_SAMPLE = 700;

// idx 0..6: Asia, Europe, Africa, N.America, S.America, Oceania, Other
function continentOf(lon, lat) {
  if (lat < -60) return 6;
  if (lon >= -93 && lon <= -32 && lat >= -57 && lat <= 14) return 4; // S.America
  if (lon >= -170 && lon <= -50 && lat > 14 && lat <= 84) return 3;  // N.America
  if (lon >= -130 && lon <= -58 && lat >= 7 && lat <= 33) return 3;  // Central America
  if (lon >= -25 && lon <= 40 && lat >= 36 && lat <= 72) return 1;   // Europe
  if (lon >= -20 && lon <= 52 && lat >= -37 && lat < 36) return 2;   // Africa
  if (lon >= 110 && lon <= 180 && lat >= -50 && lat <= 0) return 5;  // Oceania
  if (lon >= 40 && lon <= 180 && lat >= -10 && lat <= 82) return 0;  // Asia
  if (lon >= 25 && lon < 40 && lat >= 36) return 0;                  // W.Asia
  return 6;
}

let cache = { at: 0, body: null };
let token = { value: null, exp: 0 };

async function getToken() {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token.value && Date.now() < token.exp) return token.value;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) return null;
  const j = await r.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in - 30) * 1000 };
  return token.value;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=45");

  // Warm-lambda memory cache (second line of defence against rate limits).
  if (cache.body && Date.now() - cache.at < 12000) {
    return res.status(200).json(cache.body);
  }

  try {
    const tok = await getToken();
    const headers = tok ? { Authorization: "Bearer " + tok } : {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(STATES_URL, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error("opensky " + r.status);
    const data = await r.json();

    const states = data.states || [];
    const airborne = [];
    for (const s of states) {
      const lon = s[5], lat = s[6], onGround = s[8];
      if (onGround || lon == null || lat == null) continue;
      airborne.push(s);
    }

    // Even sampling across the airborne list.
    const count = airborne.length;
    const step = Math.max(1, Math.floor(count / MAX_SAMPLE));
    const sample = [];
    for (let i = 0; i < count && sample.length < MAX_SAMPLE; i += step) {
      const s = airborne[i];
      const lon = s[5], lat = s[6];
      const track = s[10] == null ? 0 : s[10];
      const vel = s[9] == null ? 0 : s[9];
      sample.push([
        Math.round(lon * 100) / 100,
        Math.round(lat * 100) / 100,
        Math.round(track),
        Math.round(vel),
        continentOf(lon, lat),
      ]);
    }

    const body = { time: data.time, count, sampled: sample.length, source: "OpenSky Network", sample };
    cache = { at: Date.now(), body };
    return res.status(200).json(body);
  } catch (err) {
    if (cache.body) return res.status(200).json(cache.body); // serve stale on error
    return res.status(502).json({ error: "live data unavailable", detail: String(err && err.message || err) });
  }
}
