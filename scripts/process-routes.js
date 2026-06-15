// Build a compact routes.json from OpenFlights routes.dat + airports.dat.
// Usage: node scripts/process-routes.js
const fs = require("fs");
const path = require("path");

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

// airports.dat: id,name,city,country,iata,icao,lat,lon,...
const byId = new Map();
for (const line of fs.readFileSync(path.join(root, "airports.dat"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const f = parseCSVLine(line);
  const id = f[0];
  const lat = parseFloat(f[6]); const lon = parseFloat(f[7]);
  if (Number.isFinite(lat) && Number.isFinite(lon)) byId.set(id, [lon, lat]);
}

// routes.dat: airline,airlineId,src,srcId,dst,dstId,codeshare,stops,equip
const weight = new Map(); // key "i|j" (sorted) -> count
const coord = new Map();  // id -> [lon,lat] for endpoints we keep
let total = 0;
for (const line of fs.readFileSync(path.join(root, "routes.dat"), "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const f = line.split(",");
  const s = f[3], d = f[5];
  if (!byId.has(s) || !byId.has(d) || s === d) continue;
  total++;
  const key = s < d ? s + "|" + d : d + "|" + s;
  weight.set(key, (weight.get(key) || 0) + 1);
  coord.set(s, byId.get(s)); coord.set(d, byId.get(d));
}

function gcDistKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const la1 = a[1] * toR, la2 = b[1] * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const r2 = (n) => Math.round(n * 100) / 100;
const TOP = 1600;
const rows = [...weight.entries()]
  .map(([k, w]) => { const [s, d] = k.split("|"); return { o: byId.get(s), d: byId.get(d), w }; })
  .filter((r) => gcDistKm(r.o, r.d) > 150)
  .sort((a, b) => b.w - a.w)
  .slice(0, TOP)
  .map((r) => [r2(r.o[0]), r2(r.o[1]), r2(r.d[0]), r2(r.d[1]), r.w]);

const out = { meta: { source: "OpenFlights", uniquePairs: weight.size, totalRouteRecords: total, kept: rows.length }, routes: rows };
fs.writeFileSync(path.join(root, "routes.json"), JSON.stringify(out));
console.log("unique pairs:", weight.size, "| total records:", total, "| kept:", rows.length);
console.log("routes.json bytes:", fs.statSync(path.join(root, "routes.json")).size);
console.log("max weight:", rows[0][4], "| min kept weight:", rows[rows.length - 1][4]);
