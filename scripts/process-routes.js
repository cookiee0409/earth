// Build a compact routes.json from OpenFlights routes.dat + airports.dat,
// tagging each route's departure with a continent and country (via the
// countries-110m polygons), plus a per-continent list of major countries.
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
  if (lon >= -93 && lon <= -32 && lat >= -57 && lat <= 14) return 4; // S.America
  if (lon >= -170 && lon <= -50 && lat > 14 && lat <= 84) return 3;  // N.America
  if (lon >= -130 && lon <= -58 && lat >= 7 && lat <= 33) return 3;  // Central America
  if (lon >= 110 && lon <= 180 && lat >= -50 && lat <= 0) return 5;  // Oceania
  if (lon >= -25 && lon <= 45 && lat >= 34 && lat <= 72) return 1;   // Europe (incl. Greece/Cyprus)
  if (lon >= 34 && lon <= 63 && lat >= 12 && lat < 40) return 0;     // Middle East -> Asia
  if (lon >= -20 && lon <= 52 && lat >= -37 && lat < 34) return 2;   // Africa
  if (lon >= 40 && lon <= 180 && lat >= -10 && lat <= 82) return 0;  // Asia
  return 6;
}

// Country lookup from countries-110m polygons, with a bbox prefilter.
const feats = topojson.feature(
  require(path.join(root, "countries-110m.json")),
  require(path.join(root, "countries-110m.json")).objects.countries
).features;
const bounds = feats.map((f) => geoBounds(f)); // [[w,s],[e,n]]
function countryOf(lon, lat) {
  for (let i = 0; i < feats.length; i++) {
    const [[w, s], [e, n]] = bounds[i];
    if (lat < s - 1 || lat > n + 1) continue;
    if (w <= e && (lon < w - 1 || lon > e + 1)) continue; // skip bbox test if it wraps antimeridian
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
const byId = new Map();
for (const line of fs.readFileSync(path.join(root, "airports.dat"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const f = parseCSVLine(line);
  const lat = parseFloat(f[6]); const lon = parseFloat(f[7]);
  if (Number.isFinite(lat) && Number.isFinite(lon)) byId.set(f[0], [lon, lat]);
}

// routes.dat: airline,airlineId,src,srcId,dst,dstId,...
const weight = new Map(); // "i|j" -> count
for (const line of fs.readFileSync(path.join(root, "routes.dat"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const f = line.split(",");
  const s = f[3], d = f[5];
  if (!byId.has(s) || !byId.has(d) || s === d) continue;
  const key = s < d ? s + "|" + d : d + "|" + s;
  weight.set(key, (weight.get(key) || 0) + 1);
}

const r2 = (n) => Math.round(n * 100) / 100;
const TOP = 1600;
const top = [...weight.entries()]
  .map(([k, w]) => { const [s, d] = k.split("|"); return { o: byId.get(s), d: byId.get(d), w }; })
  .filter((r) => gcDistKm(r.o, r.d) > 150)
  .sort((a, b) => b.w - a.w)
  .slice(0, TOP);

// Tag departure continent + country; collect weight per (continent, country).
const countryIdx = new Map();   // name -> index
const countries = [];
const contCountryW = new Map();  // "cont|idx" -> weight
const cache = new Map();         // "lon,lat" -> name (airports repeat)
function idxOf(name) {
  if (countryIdx.has(name)) return countryIdx.get(name);
  const i = countries.length; countries.push(name); countryIdx.set(name, i); return i;
}

const rows = top.map((r) => {
  const cont = continentOf(r.o[0], r.o[1]);
  const ck = r.o[0] + "," + r.o[1];
  let name = cache.has(ck) ? cache.get(ck) : (cache.set(ck, countryOf(r.o[0], r.o[1])), cache.get(ck));
  let ci = -1;
  if (name) {
    ci = idxOf(name);
    const k = cont + "|" + ci;
    contCountryW.set(k, (contCountryW.get(k) || 0) + r.w);
  }
  return [r2(r.o[0]), r2(r.o[1]), r2(r.d[0]), r2(r.d[1]), r.w, cont, ci];
});

// Top countries per continent (by departure weight).
const byCont = {};
for (const [k, w] of contCountryW.entries()) {
  const [cont, ci] = k.split("|").map(Number);
  (byCont[cont] = byCont[cont] || []).push([ci, w]);
}
for (const c of Object.keys(byCont)) {
  byCont[c] = byCont[c].sort((a, b) => b[1] - a[1]).slice(0, 10).map((x) => x[0]);
}

const out = {
  meta: { source: "OpenFlights + Natural Earth", uniquePairs: weight.size, kept: rows.length },
  countries, byCont, routes: rows,
};
fs.writeFileSync(path.join(root, "routes.json"), JSON.stringify(out));
console.log("kept routes:", rows.length, "| distinct dep countries:", countries.length);
console.log("routes.json bytes:", fs.statSync(path.join(root, "routes.json")).size);
const N = ["Asia", "Europe", "Africa", "N.Am", "S.Am", "Oceania", "Other"];
for (const c of Object.keys(byCont)) console.log(N[c] + ":", byCont[c].map((i) => countries[i]).join(", "));
