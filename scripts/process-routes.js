// Build a compact routes.json from OpenFlights routes.dat + airports.dat.
// Each route carries BOTH endpoints' airport (IATA + name), country and
// continent, so the app can filter by departure and arrival independently.
// Usage: node scripts/process-routes.js
const fs = require("fs");
const path = require("path");
const topojson = require("topojson-client");
const { geoContains, geoBounds } = require("d3-geo");

const root = path.join(__dirname, "..");

function parseCSVLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// 0 Asia, 1 Europe, 2 Africa, 3 N.America, 4 S.America, 5 Oceania, 6 Other
function continentOf(lon, lat) {
  if (lat < -60) return 6;
  if (lon >= -93 && lon <= -32 && lat >= -57 && lat <= 14) return 4;
  if (lon >= -170 && lon <= -50 && lat > 14 && lat <= 84) return 3;
  if (lon >= -130 && lon <= -58 && lat >= 7 && lat <= 33) return 3;
  if (lon >= 110 && lon <= 180 && lat >= -50 && lat <= 0) return 5;
  if (lon >= -25 && lon <= 45 && lat >= 34 && lat <= 72) return 1;
  if (lon >= 34 && lon <= 63 && lat >= 12 && lat < 40) return 0;
  if (lon >= -20 && lon <= 52 && lat >= -37 && lat < 34) return 2;
  if (lon >= 40 && lon <= 180 && lat >= -10 && lat <= 82) return 0;
  return 6;
}

const topo = require(path.join(root, "countries-110m.json"));
const feats = topojson.feature(topo, topo.objects.countries).features;
const bnds = feats.map((f) => geoBounds(f));
function countryOf(lon, lat) {
  for (let i = 0; i < feats.length; i++) {
    const [[w, s], [e, n]] = bnds[i];
    if (lat < s - 1 || lat > n + 1) continue;
    if (w <= e && (lon < w - 1 || lon > e + 1)) continue;
    if (geoContains(feats[i], [lon, lat])) return feats[i].properties.name;
  }
  return null;
}

function gcDistKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const la1 = a[1] * toR, la2 = b[1] * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// airports.dat: id,name,city,country,iata,icao,lat,lon,...
const ap = new Map(); // id -> {lon,lat,iata,name,city}
for (const line of fs.readFileSync(path.join(root, "airports.dat"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const f = parseCSVLine(line);
  const lat = parseFloat(f[6]), lon = parseFloat(f[7]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const iata = f[4] && f[4] !== "\\N" ? f[4] : (f[5] && f[5] !== "\\N" ? f[5] : "");
  ap.set(f[0], { lon, lat, iata, name: f[1] || iata, city: f[2] || "" });
}

// routes.dat: airline,airlineId,src,srcId,dst,dstId,...  (weight = #records)
const weight = new Map(); // "srcId|dstId" -> count (directional)
for (const line of fs.readFileSync(path.join(root, "routes.dat"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const f = line.split(",");
  const s = f[3], d = f[5];
  if (!ap.has(s) || !ap.has(d) || s === d) continue;
  const key = s + "|" + d;
  weight.set(key, (weight.get(key) || 0) + 1);
}

const TOP = 1700;
const top = [...weight.entries()]
  .map(([k, w]) => { const [s, d] = k.split("|"); return { s, d, w }; })
  .filter((r) => gcDistKm([ap.get(r.s).lon, ap.get(r.s).lat], [ap.get(r.d).lon, ap.get(r.d).lat]) > 120)
  .sort((a, b) => b.w - a.w)
  .slice(0, TOP);

// Airport + country registries (only those used by kept routes).
const countryIdx = new Map(), countries = [];
const airIdx = new Map(), airports = [];
const ctyCache = new Map(); // airport id -> country name
function countryIdxOf(name) {
  if (countryIdx.has(name)) return countryIdx.get(name);
  const i = countries.length; countries.push(name); countryIdx.set(name, i); return i;
}
const r2 = (n) => Math.round(n * 100) / 100;
function airIdxOf(id) {
  if (airIdx.has(id)) return airIdx.get(id);
  const a = ap.get(id);
  let cty = ctyCache.get(id);
  if (cty === undefined) { cty = countryOf(a.lon, a.lat); ctyCache.set(id, cty); }
  const cont = continentOf(a.lon, a.lat);
  const ci = cty ? countryIdxOf(cty) : -1;
  const i = airports.length;
  airports.push([a.iata, a.name, ci, cont, r2(a.lon), r2(a.lat)]);
  airIdx.set(id, i);
  return i;
}

const rows = top.map((r) => [r.w, airIdxOf(r.s), airIdxOf(r.d)]);

// Fix each country to a SINGLE continent (override, else majority of its airports),
// so a country never appears under two continents (Russia, Indonesia, Morocco, …).
const OVERRIDE = { Russia: 1, Indonesia: 0, Morocco: 2, Algeria: 2 };
const votes = {};
for (const a of airports) { if (a[2] < 0) continue; (votes[a[2]] = votes[a[2]] || {}); votes[a[2]][a[3]] = (votes[a[2]][a[3]] || 0) + 1; }
const ctyCont = {};
for (const ci in votes) { const v = votes[ci]; ctyCont[ci] = Object.keys(v).map(Number).sort((x, y) => v[y] - v[x])[0]; }
for (const name in OVERRIDE) { const ci = countryIdx.get(name); if (ci != null) ctyCont[ci] = OVERRIDE[name]; }
for (const a of airports) { if (a[2] >= 0 && ctyCont[a[2]] != null) a[3] = ctyCont[a[2]]; }

const out = {
  meta: { source: "OpenFlights + Natural Earth", kept: rows.length, airports: airports.length, countries: countries.length },
  countries, airports, routes: rows,
};
fs.writeFileSync(path.join(root, "routes.json"), JSON.stringify(out));
console.log("routes:", rows.length, "| airports:", airports.length, "| countries:", countries.length);
console.log("bytes:", fs.statSync(path.join(root, "routes.json")).size);
console.log("sample route [w,oAir,dAir]:", JSON.stringify(rows[0]));
console.log("sample airport [iata,name,ctyIdx,cont,lon,lat]:", JSON.stringify(airports[0]), "->", countries[airports[0][2]]);
