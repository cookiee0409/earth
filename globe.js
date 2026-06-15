(function () {
  "use strict";

  const canvas = document.getElementById("globe");
  const ctx = canvas.getContext("2d");

  let width = 0, height = 0, dpr = 1, cx = 0, cy = 0;
  let baseScale = 0;          // scale that fits the viewport
  let scale = 0;              // current scale (controls zoom)
  const MIN_K = 0.55, MAX_K = 7; // zoom multipliers relative to baseScale

  // Orthographic projection — a true globe view.
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.5);
  const path = d3.geoPath(projection, ctx);
  const graticule = d3.geoGraticule10();
  const sphere = { type: "Sphere" };

  // Offscreen layer for land — drawn once per frame, then blurred for the
  // neon bloom in a single raster pass (far cheaper than per-path shadowBlur).
  const layer = document.createElement("canvas");
  const lctx = layer.getContext("2d");
  const lpath = d3.geoPath(projection, lctx);

  let land = null;          // GeoJSON of all land
  let borders = null;       // mesh of interior country borders
  let rotation = [0, -12, 0]; // [λ, φ, γ]
  let autoSpin = true;
  let lastSpin = performance.now();
  let lastFrame = performance.now();
  let frameDt = 16;

  // ---- flights ------------------------------------------------------------
  let routes = [];          // full list, sorted by weight: [{o,d,w,interp,dist,cont}]
  let activeN = 0;          // routes currently in use (scales with screen size)
  let cumW = [], totalW = 0;
  let daily = null;         // { start, counts:[...] }
  let dayIndex = 0, maxCount = 1;
  let playing = false, playAccum = 0;
  let planes = [];
  let maxPlanes = 420;      // plane cap (scales with screen size)
  const SPEED_K = 0.0011;   // angular speed = K / route-length (constant ground speed)
  const DAY_MS = 86400000;
  const START_MS = Date.UTC(2019, 0, 1);

  // Live (measured) mode — real aircraft from OpenSky via /api/live.
  let liveMode = false;
  let livePlanes = [];      // [{lon,lat,track,vel,cont}]
  let liveCount = 0, liveTimer = null, liveLoading = false;

  // ---- continents (color by departure / current position) -----------------
  // 0 Asia, 1 Europe, 2 Africa, 3 N.America, 4 S.America, 5 Oceania, 6 Other
  const CONT_RGB = [
    [255, 93, 210], [93, 249, 255], [255, 210, 93],
    [93, 255, 155], [255, 138, 77], [185, 138, 255], [234, 252, 255],
  ];
  const CONT_NAME = ["아시아", "유럽", "아프리카", "북미", "남미", "오세아니아", "기타"];
  const CONT_FILL = CONT_RGB.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`);
  const CONT_TRAIL = CONT_RGB.map((c) => `rgba(${c[0]},${c[1]},${c[2]},0.34)`);

  function continentOf(lon, lat) {
    if (lat < -60) return 6;
    if (lon >= -93 && lon <= -32 && lat >= -57 && lat <= 14) return 4; // S.America
    if (lon >= -170 && lon <= -50 && lat > 14 && lat <= 84) return 3;  // N.America
    if (lon >= -130 && lon <= -58 && lat >= 7 && lat <= 33) return 3;  // Central America
    if (lon >= 110 && lon <= 180 && lat >= -50 && lat <= 0) return 5;  // Oceania
    if (lon >= -25 && lon <= 45 && lat >= 34 && lat <= 72) return 1;   // Europe
    if (lon >= 34 && lon <= 63 && lat >= 12 && lat < 40) return 0;     // Middle East -> Asia
    if (lon >= -20 && lon <= 52 && lat >= -37 && lat < 34) return 2;   // Africa
    if (lon >= 40 && lon <= 180 && lat >= -10 && lat <= 82) return 0;  // Asia
    return 6;
  }

  // ---- filters & metadata -------------------------------------------------
  let routeCountries = [];   // index -> country name (from routes.json)
  let byCont = {};           // continent index -> [country index, ...]
  const contOff = new Set(); // disabled continents
  const countryOff = new Set(); // disabled country names
  let countryFeatures = null, countryBounds = null; // for live point-in-country

  let speed = 1;             // playback speed multiplier
  const BASE_MS_PER_DAY = 700; // slow by default (1×)

  // Korean labels for the countries that appear in the panels.
  const KO = {
    "China": "중국", "India": "인도", "Japan": "일본", "Malaysia": "말레이시아",
    "United Arab Emirates": "아랍에미리트", "Indonesia": "인도네시아", "Thailand": "태국",
    "South Korea": "대한민국", "Saudi Arabia": "사우디아라비아", "Philippines": "필리핀",
    "Spain": "스페인", "France": "프랑스", "Italy": "이탈리아", "Germany": "독일",
    "Portugal": "포르투갈", "United Kingdom": "영국", "Turkey": "튀르키예", "Austria": "오스트리아",
    "Greece": "그리스", "Belgium": "벨기에", "Netherlands": "네덜란드", "Switzerland": "스위스",
    "Burkina Faso": "부르키나파소", "South Africa": "남아프리카공화국", "Ghana": "가나",
    "Morocco": "모로코", "Ethiopia": "에티오피아", "Rwanda": "르완다", "Benin": "베냉",
    "Senegal": "세네갈", "Burundi": "부룬디", "Tanzania": "탄자니아", "Egypt": "이집트",
    "Kenya": "케냐", "Nigeria": "나이지리아", "Algeria": "알제리",
    "United States of America": "미국", "Canada": "캐나다", "Mexico": "멕시코",
    "Puerto Rico": "푸에르토리코", "Guatemala": "과테말라", "Haiti": "아이티",
    "Dominican Rep.": "도미니카공화국", "Jamaica": "자메이카", "Honduras": "온두라스", "Cuba": "쿠바",
    "Brazil": "브라질", "Colombia": "콜롬비아", "Peru": "페루", "Ecuador": "에콰도르",
    "Chile": "칠레", "Venezuela": "베네수엘라", "Panama": "파나마", "El Salvador": "엘살바도르",
    "Bolivia": "볼리비아", "Nicaragua": "니카라과", "Argentina": "아르헨티나",
    "Australia": "호주", "New Zealand": "뉴질랜드", "Fiji": "피지", "Papua New Guinea": "파푸아뉴기니",
  };
  const koName = (n) => KO[n] || n;

  function hidden(cont, country) {
    if (contOff.has(cont)) return true;
    if (country && countryOff.has(country)) return true;
    return false;
  }

  // Point-in-country for live aircraft (countries-110m), with a bbox prefilter.
  function countryOfLive(lon, lat) {
    if (!countryFeatures) return null;
    for (let i = 0; i < countryFeatures.length; i++) {
      const b = countryBounds[i];
      const w = b[0][0], s = b[0][1], e = b[1][0], n = b[1][1];
      if (lat < s - 1 || lat > n + 1) continue;
      if (w <= e && (lon < w - 1 || lon > e + 1)) continue;
      if (d3.geoContains(countryFeatures[i], [lon, lat])) return countryFeatures[i].properties.name;
    }
    return null;
  }

  // Top-down plane silhouette pointing +x, given as the upper half outline.
  const PLANE_HALF = [[9,0],[2,1.4],[2,2.2],[-1,7],[-2.6,7],[-2,2.2],[-4.6,2.2],[-5.2,4.6],[-6.8,4.6],[-6,1.1],[-8,0]];
  function planeGlyph() {
    ctx.beginPath();
    ctx.moveTo(PLANE_HALF[0][0], PLANE_HALF[0][1]);
    for (let i = 1; i < PLANE_HALF.length; i++) ctx.lineTo(PLANE_HALF[i][0], PLANE_HALF[i][1]);
    for (let i = PLANE_HALF.length - 2; i >= 1; i--) ctx.lineTo(PLANE_HALF[i][0], -PLANE_HALF[i][1]);
    ctx.closePath();
    ctx.fill();
  }

  function buildRoutes(data) {
    routeCountries = data.countries || [];
    byCont = data.byCont || {};
    routes = data.routes.map((a) => {
      const o = [a[0], a[1]], d = [a[2], a[3]];
      return {
        o, d, w: a[4],
        interp: d3.geoInterpolate(o, d),
        dist: Math.max(0.02, d3.geoDistance(o, d)),
        cont: a[5] != null ? a[5] : continentOf(a[0], a[1]),
        country: (a[6] != null && a[6] >= 0) ? routeCountries[a[6]] : null,
      };
    });
    computeCaps();
    rebuildActive();
  }

  // Scale route count and plane cap to the viewport (1280×720 ≈ baseline).
  function computeCaps() {
    const f = (width * height) / 921600;
    maxPlanes = Math.round(Math.max(90, Math.min(560, 420 * f)));
    activeN = Math.round(Math.max(350, Math.min(routes.length || 1600, 1600 * f)));
    if (routes.length) activeN = Math.min(activeN, routes.length);
  }

  function rebuildActive() {
    if (!routes.length) return;
    cumW = []; totalW = 0;
    for (let i = 0; i < activeN; i++) { totalW += routes[i].w; cumW.push(totalW); }
    for (const pl of planes) if (pl.ri >= activeN) respawn(pl);
  }

  function weightedPick() {
    const x = Math.random() * totalW;
    let lo = 0, hi = cumW.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cumW[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  function respawn(pl) {
    pl.ri = weightedPick();
    pl.t = 0;
    pl.sp = SPEED_K / routes[pl.ri].dist;
  }

  function setPlaneCount(n) {
    if (!routes.length) return;
    n = Math.max(0, Math.min(maxPlanes, n));
    while (planes.length < n) { const pl = {}; respawn(pl); pl.t = Math.random(); planes.push(pl); }
    if (planes.length > n) planes.length = n;
  }

  function fmtISO(idx) {
    const d = new Date(START_MS + idx * DAY_MS);
    const p = (n) => String(n).padStart(2, "0");
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
  }

  const elSlider = document.getElementById("dateslider");
  const elDatePick = document.getElementById("datepick");
  const elCount = document.getElementById("rocount");
  const elPlay = document.getElementById("play");
  const elLive = document.getElementById("live");
  const elModeled = document.getElementById("romodeled");
  const elBar = document.getElementById("flightbar");

  function setDay(idx) {
    if (!daily) return;
    dayIndex = Math.max(0, Math.min(daily.counts.length - 1, idx | 0));
    elSlider.value = dayIndex;
    if (elDatePick) elDatePick.value = fmtISO(dayIndex);
    elCount.textContent = "약 " + daily.counts[dayIndex].toLocaleString("ko-KR") + "편";
    setPlaneCount(Math.round((daily.counts[dayIndex] / maxCount) * maxPlanes));
  }

  // ---- live (measured) mode ----------------------------------------------
  function fetchLive() {
    if (liveLoading) return;
    liveLoading = true;
    fetch("/api/live")
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((d) => {
        liveLoading = false;
        if (!liveMode) return;
        liveCount = d.count || 0;
        livePlanes = (d.sample || []).map((s) => ({
          lon: s[0], lat: s[1], track: s[2], vel: s[3], cont: s[4],
          country: countryOfLive(s[0], s[1]),
        }));
        // cap to screen-based plane budget
        if (livePlanes.length > maxPlanes) livePlanes.length = maxPlanes;
        elCount.textContent = "LIVE · " + liveCount.toLocaleString("ko-KR") + "대 추적 (ADS-B)";
      })
      .catch((err) => {
        liveLoading = false;
        if (!liveMode) return;
        elCount.textContent = "실시간 데이터를 불러오지 못함";
        console.error("live fetch failed:", err);
      });
  }

  function setLiveMode(on) {
    liveMode = on;
    elLive.classList.toggle("on", on);
    elLive.textContent = on ? "LIVE ●" : "LIVE";
    if (elBar) elBar.classList.toggle("liveon", on);
    if (elDatePick) elDatePick.disabled = on;
    if (on) {
      playing = false; elPlay.textContent = "▶";
      if (elModeled) { elModeled.textContent = "실측"; elModeled.title = "adsb.lol 실시간 측정 데이터 (ADS-B)"; }
      elCount.textContent = "불러오는 중…";
      fetchLive();
      if (liveTimer) clearInterval(liveTimer);
      liveTimer = setInterval(fetchLive, 18000);
    } else {
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      livePlanes = [];
      if (elModeled) { elModeled.textContent = "대표값"; elModeled.title = "실측이 아닌 대표값(모델) 데이터입니다"; }
      if (daily) setDay(dayIndex);
    }
  }

  // Destination point given start, bearing (deg from north) and distance (m).
  const EARTH_M = 6371000;
  function destination(lon, lat, brgDeg, distM) {
    const d = distM / EARTH_M, br = brgDeg * Math.PI / 180;
    const la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
    const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return [((lo2 * 180 / Math.PI + 540) % 360) - 180, la2 * 180 / Math.PI];
  }

  function drawFlights(dt) {
    if (liveMode) return drawLive(dt);
    if (!routes.length || !planes.length) return;
    const rot = projection.rotate();
    const center = [-rot[0], -rot[1]];
    const horizon = Math.PI / 2 - 0.02;
    const glyphScale = Math.max(0.25, Math.min(1.2, scale * 0.0017));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Trails first, then plane glyphs on top — both colored by departure continent.
    ctx.lineWidth = 1;
    for (const pl of planes) {
      pl.t += pl.sp;
      if (pl.t >= 1) { respawn(pl); continue; }
      const r = routes[pl.ri];
      if (hidden(r.cont, r.country)) continue;
      const head = r.interp(pl.t);
      if (d3.geoDistance(head, center) > horizon) continue;
      ctx.strokeStyle = CONT_TRAIL[r.cont];
      const steps = 6, back = 0.09;
      ctx.beginPath();
      let started = false;
      for (let k = steps; k >= 0; k--) {
        const tt = pl.t - back * (k / steps);
        if (tt < 0) { started = false; continue; }
        const pt = r.interp(tt);
        if (d3.geoDistance(pt, center) > horizon) { started = false; continue; }
        const pp = projection(pt);
        if (started) ctx.lineTo(pp[0], pp[1]);
        else { ctx.moveTo(pp[0], pp[1]); started = true; }
      }
      ctx.stroke();
    }

    for (const pl of planes) {
      const r = routes[pl.ri];
      if (hidden(r.cont, r.country)) continue;
      const head = r.interp(pl.t);
      if (d3.geoDistance(head, center) > horizon) continue;
      const p0 = projection(head);
      const pa = projection(r.interp(Math.min(1, pl.t + 0.012)));
      const ang = Math.atan2(pa[1] - p0[1], pa[0] - p0[0]);
      ctx.fillStyle = CONT_FILL[r.cont];
      ctx.save();
      ctx.translate(p0[0], p0[1]);
      ctx.rotate(ang);
      ctx.scale(glyphScale, glyphScale);
      planeGlyph();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawLive(dt) {
    if (!livePlanes.length) return;
    const rot = projection.rotate();
    const center = [-rot[0], -rot[1]];
    const horizon = Math.PI / 2 - 0.02;
    const glyphScale = Math.max(0.25, Math.min(1.2, scale * 0.0017));
    const secs = Math.min(0.1, (dt || 16) / 1000); // dead-reckon step, clamped

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const pl of livePlanes) {
      if (pl.vel > 0) { const np = destination(pl.lon, pl.lat, pl.track, pl.vel * secs); pl.lon = np[0]; pl.lat = np[1]; }
      if (hidden(pl.cont, pl.country)) continue;
      const pos = [pl.lon, pl.lat];
      if (d3.geoDistance(pos, center) > horizon) continue;
      const p0 = projection(pos);
      const ahead = destination(pl.lon, pl.lat, pl.track, 30000);
      const pa = projection(ahead);
      const ang = Math.atan2(pa[1] - p0[1], pa[0] - p0[0]);
      ctx.fillStyle = CONT_FILL[pl.cont];
      ctx.save();
      ctx.translate(p0[0], p0[1]);
      ctx.rotate(ang);
      ctx.scale(glyphScale, glyphScale);
      planeGlyph();
      ctx.restore();
    }
    ctx.restore();
  }

  // Starfield (screen-space, generated once on resize).
  let stars = [];

  function makeStars() {
    stars = [];
    const n = Math.round((width * height) / 5200);
    for (let i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.3 + 0.2,
        p: Math.random() * Math.PI * 2,
        sp: 0.6 + Math.random() * 1.6,
      });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    layer.width = canvas.width;
    layer.height = canvas.height;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cx = width / 2;
    cy = height / 2;
    const fit = Math.max(20, Math.min(width, height) / 2 - 18);
    const k = baseScale ? scale / baseScale : 1; // preserve zoom level
    baseScale = fit;
    scale = baseScale * (baseScale ? k : 1);
    if (!scale) scale = baseScale;
    projection.translate([cx, cy]);
    makeStars();

    if (routes.length) {
      computeCaps();
      rebuildActive();
      if (daily && !liveMode) setDay(dayIndex); // re-evaluate plane count for new cap
    }
  }

  function applyScale() {
    projection.scale(scale);
  }

  // ---- rendering ----------------------------------------------------------

  function drawBackground(t) {
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(width, height) * 0.75);
    bg.addColorStop(0, "#0d0a24");
    bg.addColorStop(0.45, "#070613");
    bg.addColorStop(1, "#030208");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const s of stars) {
      const tw = 0.45 + 0.55 * Math.abs(Math.sin(t * 0.001 * s.sp + s.p));
      ctx.globalAlpha = tw * 0.8;
      ctx.fillStyle = "#cdd8ff";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawAtmosphere() {
    // Outer neon halo around the globe edge.
    const r0 = scale * 0.96;
    const r1 = scale * 1.35;
    const halo = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    halo.addColorStop(0, "rgba(90, 120, 255, 0)");
    halo.addColorStop(0.4, "rgba(120, 90, 255, 0.30)");
    halo.addColorStop(0.7, "rgba(60, 150, 255, 0.16)");
    halo.addColorStop(1, "rgba(60, 150, 255, 0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawOcean() {
    // Globe disc with a deep purple→blue gradient.
    const oc = ctx.createRadialGradient(
      cx - scale * 0.3, cy - scale * 0.3, scale * 0.1,
      cx, cy, scale
    );
    oc.addColorStop(0, "#241159");
    oc.addColorStop(0.55, "#12104a");
    oc.addColorStop(1, "#070a33");
    ctx.beginPath();
    path(sphere);
    ctx.fillStyle = oc;
    ctx.fill();
  }

  function drawGraticule() {
    ctx.beginPath();
    path(graticule);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = "rgba(90, 150, 255, 0.22)";
    ctx.stroke();
    ctx.restore();
  }

  function drawLand() {
    if (!land) return;

    // Draw land once onto the offscreen layer — solid body + bright coastline,
    // no per-path shadow (which is what made it crawl).
    lctx.clearRect(0, 0, width, height);

    const sheen = lctx.createLinearGradient(cx - scale, cy - scale, cx + scale, cy + scale);
    sheen.addColorStop(0, "#13e58a");
    sheen.addColorStop(0.5, "#0fd6a6");
    sheen.addColorStop(1, "#2fb6ff");
    lctx.beginPath();
    lpath(land);
    lctx.fillStyle = sheen;
    lctx.fill();

    lctx.beginPath();
    lpath(land);
    lctx.lineWidth = Math.max(0.6, scale * 0.0018);
    lctx.strokeStyle = "rgba(170, 255, 225, 0.95)";
    lctx.stroke();

    // Country borders — thin fluorescent purple neon lines.
    if (borders) {
      lctx.beginPath();
      lpath(borders);
      lctx.lineWidth = Math.max(0.7, scale * 0.0014);
      lctx.strokeStyle = "rgba(206, 138, 255, 0.95)";
      lctx.stroke();
    }

    // Bloom: composite a blurred copy with additive blending (one raster blur),
    // then the sharp copy on top.
    const blur = Math.max(4, scale * 0.018);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if ("filter" in ctx) {
      ctx.filter = "blur(" + blur.toFixed(1) + "px)";
      ctx.globalAlpha = 0.85;
      ctx.drawImage(layer, 0, 0, width, height);
      ctx.filter = "none";
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(layer, 0, 0, width, height);
    ctx.restore();
  }

  function drawRim() {
    // Thin glowing edge of the planet (single arc — cheap shadow).
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = "#5a8cff";
    ctx.shadowBlur = 18;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(140, 170, 255, 0.7)";
    ctx.beginPath();
    ctx.arc(cx, cy, scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function render(t) {
    ctx.clearRect(0, 0, width, height);
    projection.rotate(rotation);
    applyScale();

    drawBackground(t);
    drawAtmosphere();
    drawOcean();
    drawGraticule();
    drawLand();
    drawFlights(frameDt);
    drawRim();
  }

  function frame(t) {
    const dt = t - lastFrame;
    lastFrame = t;
    frameDt = dt;
    if (autoSpin) {
      rotation[0] = (rotation[0] + (t - lastSpin) * 0.006) % 360; // ~6°/s
    }
    lastSpin = t;
    if (playing && daily) {
      playAccum += dt;
      const msPerDay = BASE_MS_PER_DAY / speed;
      while (playAccum >= msPerDay) {
        playAccum -= msPerDay;
        setDay(dayIndex + 1 >= daily.counts.length ? 0 : dayIndex + 1);
      }
    }
    try {
      render(t);
    } catch (err) {
      console.error("render error:", err);
    }
    requestAnimationFrame(frame);
  }

  // ---- interaction --------------------------------------------------------

  let dragging = false;
  let lastX = 0, lastY = 0;
  let spinResume = null;

  function pointerDown(e) {
    dragging = true;
    autoSpin = false;
    if (spinResume) clearTimeout(spinResume);
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  }

  function pointerMove(e) {
    if (!dragging) return;
    const sens = 0.25 * (baseScale / scale); // slower when zoomed in
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    rotation[0] = (rotation[0] + dx * sens) % 360;
    rotation[1] = Math.max(-90, Math.min(90, rotation[1] - dy * sens));
  }

  function pointerUp(e) {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    spinResume = setTimeout(() => { autoSpin = true; lastSpin = performance.now(); }, 1600);
  }

  function zoomBy(factor) {
    scale = Math.max(baseScale * MIN_K, Math.min(baseScale * MAX_K, scale * factor));
  }

  function onWheel(e) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }

  // Pinch-to-zoom (two pointers).
  const active = new Map();
  let pinchStart = 0, pinchScale0 = 0;

  function trackDown(e) { active.set(e.pointerId, e); }
  function trackMove(e) {
    if (active.has(e.pointerId)) active.set(e.pointerId, e);
    if (active.size === 2) {
      const [a, b] = [...active.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!pinchStart) { pinchStart = dist; pinchScale0 = scale; }
      else {
        scale = Math.max(baseScale * MIN_K, Math.min(baseScale * MAX_K, pinchScale0 * (dist / pinchStart)));
      }
      dragging = false; // suppress rotation during pinch
    }
  }
  function trackUp(e) {
    active.delete(e.pointerId);
    if (active.size < 2) pinchStart = 0;
  }

  canvas.addEventListener("pointerdown", (e) => { trackDown(e); if (active.size < 2) pointerDown(e); });
  canvas.addEventListener("pointermove", (e) => { trackMove(e); pointerMove(e); });
  canvas.addEventListener("pointerup", (e) => { trackUp(e); pointerUp(e); });
  canvas.addEventListener("pointercancel", (e) => { trackUp(e); pointerUp(e); });
  canvas.addEventListener("wheel", onWheel, { passive: false });

  document.getElementById("zoom-in").addEventListener("click", () => zoomBy(1.25));
  document.getElementById("zoom-out").addEventListener("click", () => zoomBy(1 / 1.25));
  document.getElementById("reset").addEventListener("click", () => {
    scale = baseScale;
    rotation = [0, -12, 0];
    autoSpin = true;
    lastSpin = performance.now();
  });

  elSlider.addEventListener("input", () => { if (liveMode) return; setDay(+elSlider.value); });
  elPlay.addEventListener("click", () => {
    if (liveMode) return;
    playing = !playing;
    elPlay.textContent = playing ? "❚❚" : "▶";
  });
  if (elLive) elLive.addEventListener("click", () => setLiveMode(!liveMode));

  if (elDatePick) {
    elDatePick.addEventListener("change", () => {
      if (liveMode || !daily) return;
      const t = Date.parse(elDatePick.value + "T00:00:00Z");
      if (!isNaN(t)) setDay(Math.round((t - START_MS) / DAY_MS));
    });
  }

  // Speed buttons (1× / 2× / 4× / 8×).
  document.querySelectorAll("#speeds button").forEach((b) => {
    b.addEventListener("click", () => {
      speed = +b.dataset.sp;
      document.querySelectorAll("#speeds button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });

  // Continent legend + country panel.
  const LEGEND_ORDER = [3, 4, 1, 2, 0, 5];
  function buildLegend() {
    const host = document.getElementById("legend-items");
    if (!host) return;
    host.innerHTML = "";
    for (const c of LEGEND_ORDER) {
      const item = document.createElement("div");
      item.className = "lg-item";
      item.innerHTML = '<i style="background:' + CONT_FILL[c] + ";color:" + CONT_FILL[c] + '"></i><span class="lg-name">' + CONT_NAME[c] + "</span>";
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "lg-chk"; chk.checked = !contOff.has(c);
      chk.title = "이 대륙 표시 켜기/끄기";
      chk.addEventListener("click", (e) => e.stopPropagation());
      chk.addEventListener("change", () => {
        if (chk.checked) contOff.delete(c); else contOff.add(c);
        item.classList.toggle("off", !chk.checked);
      });
      item.appendChild(chk);
      item.addEventListener("click", () => openPanel(c));
      host.appendChild(item);
    }
  }

  function openPanel(c) {
    const panel = document.getElementById("contpanel");
    if (!panel) return;
    document.getElementById("cp-title").textContent = CONT_NAME[c] + " 주요 국가";
    const list = document.getElementById("cp-list");
    list.innerHTML = "";
    const arr = (byCont && byCont[c]) || [];
    if (!arr.length) {
      list.innerHTML = '<div class="cp-empty">표시할 국가가 없습니다</div>';
    }
    for (const ci of arr) {
      const name = routeCountries[ci];
      if (!name) continue;
      const row = document.createElement("label");
      row.className = "cp-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = !countryOff.has(name);
      cb.addEventListener("change", () => {
        if (cb.checked) countryOff.delete(name); else countryOff.add(name);
      });
      const sw = document.createElement("i");
      sw.style.background = CONT_FILL[c];
      sw.style.color = CONT_FILL[c];
      const sp = document.createElement("span");
      sp.textContent = koName(name);
      row.appendChild(cb); row.appendChild(sw); row.appendChild(sp);
      list.appendChild(row);
    }
    panel.hidden = false;
  }
  const cpClose = document.getElementById("cp-close");
  if (cpClose) cpClose.addEventListener("click", () => { document.getElementById("contpanel").hidden = true; });

  window.addEventListener("resize", resize);

  // ---- boot ---------------------------------------------------------------

  resize();
  scale = baseScale;

  // Start the render loop immediately so the ocean, stars and atmosphere
  // appear right away; land pops in once its data finishes loading.
  lastSpin = performance.now();
  requestAnimationFrame(frame);

  fetch("countries-110m.json")
    .then((r) => r.json())
    .then((topo) => {
      land = topojson.feature(topo, topo.objects.land);
      // Interior borders only (shared edges), so coastlines aren't doubled.
      borders = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b);
      // Country polygons for live point-in-country lookup.
      countryFeatures = topojson.feature(topo, topo.objects.countries).features;
      countryBounds = countryFeatures.map((f) => d3.geoBounds(f));
    })
    .catch((err) => {
      console.error("Failed to load map data:", err);
    });

  fetch("routes.json")
    .then((r) => r.json())
    .then((d) => { buildRoutes(d); buildLegend(); if (daily) setDay(dayIndex); })
    .catch((err) => { console.error("Failed to load routes:", err); });

  fetch("daily.json")
    .then((r) => r.json())
    .then((d) => {
      daily = d;
      maxCount = d.counts.reduce((m, c) => (c > m ? c : m), 1);
      elSlider.max = d.counts.length - 1;
      if (elDatePick) { elDatePick.min = fmtISO(0); elDatePick.max = fmtISO(d.counts.length - 1); }
      setDay(d.counts.length - 1); // start at the most recent day
    })
    .catch((err) => { console.error("Failed to load daily data:", err); });
})();
