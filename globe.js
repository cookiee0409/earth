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

  // ---- flights ------------------------------------------------------------
  let routes = [];          // [{o,d,w,interp,dist}]
  let cumW = [], totalW = 0;
  let daily = null;         // { start, counts:[...] }
  let dayIndex = 0, maxCount = 1;
  let playing = false, playAccum = 0;
  let planes = [];
  const MAX_PLANES = 420;
  const SPEED_K = 0.0011;   // angular speed = K / route-length (constant ground speed)
  const DAY_MS = 86400000;
  const START_MS = Date.UTC(2019, 0, 1);

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
    routes = data.routes.map((a) => {
      const o = [a[0], a[1]], d = [a[2], a[3]];
      return { o, d, w: a[4], interp: d3.geoInterpolate(o, d), dist: Math.max(0.02, d3.geoDistance(o, d)) };
    });
    cumW = []; totalW = 0;
    for (const r of routes) { totalW += r.w; cumW.push(totalW); }
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
    n = Math.max(0, Math.min(MAX_PLANES, n));
    while (planes.length < n) { const pl = {}; respawn(pl); pl.t = Math.random(); planes.push(pl); }
    if (planes.length > n) planes.length = n;
  }

  function fmtDate(idx) {
    const d = new Date(START_MS + idx * DAY_MS);
    const p = (n) => String(n).padStart(2, "0");
    return d.getUTCFullYear() + "." + p(d.getUTCMonth() + 1) + "." + p(d.getUTCDate());
  }

  const elSlider = document.getElementById("dateslider");
  const elDate = document.getElementById("rodate");
  const elCount = document.getElementById("rocount");
  const elPlay = document.getElementById("play");

  function setDay(idx) {
    if (!daily) return;
    dayIndex = Math.max(0, Math.min(daily.counts.length - 1, idx | 0));
    elSlider.value = dayIndex;
    elDate.textContent = fmtDate(dayIndex);
    elCount.textContent = "약 " + daily.counts[dayIndex].toLocaleString("ko-KR") + "편";
    setPlaneCount(Math.round((daily.counts[dayIndex] / maxCount) * MAX_PLANES));
  }

  function drawFlights() {
    if (!routes.length || !planes.length) return;
    const rot = projection.rotate();
    const center = [-rot[0], -rot[1]];
    const horizon = Math.PI / 2 - 0.02;
    const glyphScale = Math.max(0.5, Math.min(2.4, scale * 0.0034));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Trails first, then plane glyphs on top.
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(125, 247, 255, 0.34)";
    for (const pl of planes) {
      pl.t += pl.sp;
      if (pl.t >= 1) { respawn(pl); continue; }
      const r = routes[pl.ri];
      const head = r.interp(pl.t);
      if (d3.geoDistance(head, center) > horizon) continue;
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

    ctx.fillStyle = "#eafcff";
    for (const pl of planes) {
      const r = routes[pl.ri];
      const head = r.interp(pl.t);
      if (d3.geoDistance(head, center) > horizon) continue;
      const p0 = projection(head);
      const pa = projection(r.interp(Math.min(1, pl.t + 0.012)));
      const ang = Math.atan2(pa[1] - p0[1], pa[0] - p0[0]);
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
    drawFlights();
    drawRim();
  }

  function frame(t) {
    const dt = t - lastFrame;
    lastFrame = t;
    if (autoSpin) {
      rotation[0] = (rotation[0] + (t - lastSpin) * 0.006) % 360; // ~6°/s
    }
    lastSpin = t;
    if (playing && daily) {
      playAccum += dt;
      const msPerDay = 45;
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

  elSlider.addEventListener("input", () => setDay(+elSlider.value));
  elPlay.addEventListener("click", () => {
    playing = !playing;
    elPlay.textContent = playing ? "❚❚" : "▶";
  });

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
    })
    .catch((err) => {
      console.error("Failed to load map data:", err);
    });

  fetch("routes.json")
    .then((r) => r.json())
    .then((d) => { buildRoutes(d); if (daily) setDay(dayIndex); })
    .catch((err) => { console.error("Failed to load routes:", err); });

  fetch("daily.json")
    .then((r) => r.json())
    .then((d) => {
      daily = d;
      maxCount = d.counts.reduce((m, c) => (c > m ? c : m), 1);
      elSlider.max = d.counts.length - 1;
      setDay(d.counts.length - 1); // start at the most recent day
    })
    .catch((err) => { console.error("Failed to load daily data:", err); });
})();
