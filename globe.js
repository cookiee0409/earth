(function () {
  "use strict";

  const canvas = document.getElementById("globe");
  const ctx = canvas.getContext("2d");

  let width = 0, height = 0, dpr = 1, cx = 0, cy = 0;
  let baseScale = 0;          // scale that fits the viewport
  let scale = 0;              // current scale (controls zoom)
  const MIN_K = 0.55, MAX_K = 7; // zoom multipliers relative to baseScale

  // Orthographic projection — a true globe view.
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.3);
  const path = d3.geoPath(projection, ctx);
  const graticule = d3.geoGraticule10();
  const sphere = { type: "Sphere" };

  let land = null;          // GeoJSON of all land
  let rotation = [0, -12, 0]; // [λ, φ, γ]
  let autoSpin = true;
  let lastSpin = performance.now();

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
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cx = width / 2;
    cy = height / 2;
    const fit = Math.min(width, height) / 2 - 18;
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
    const glow = Math.max(10, scale * 0.06);

    // Pass 1 — broad neon bloom.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = "#00ffa3";
    ctx.shadowBlur = glow * 2;
    ctx.beginPath();
    path(land);
    ctx.fillStyle = "rgba(0, 255, 150, 0.45)";
    ctx.fill();
    ctx.restore();

    // Pass 2 — solid fluorescent body with a purple→green sheen.
    const sheen = ctx.createLinearGradient(cx - scale, cy - scale, cx + scale, cy + scale);
    sheen.addColorStop(0, "#13e58a");
    sheen.addColorStop(0.5, "#0fd6a6");
    sheen.addColorStop(1, "#2fb6ff");
    ctx.beginPath();
    path(land);
    ctx.fillStyle = sheen;
    ctx.fill();

    // Pass 3 — bright neon coastline.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = "#7dffd1";
    ctx.shadowBlur = glow;
    ctx.lineWidth = Math.max(0.6, scale * 0.0018);
    ctx.strokeStyle = "rgba(150, 255, 215, 0.9)";
    ctx.beginPath();
    path(land);
    ctx.stroke();
    ctx.restore();
  }

  function drawRim() {
    // Thin glowing edge of the planet.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = "#5a8cff";
    ctx.shadowBlur = 24;
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
    drawRim();
  }

  function frame(t) {
    if (autoSpin) {
      const dt = t - lastSpin;
      rotation[0] = (rotation[0] + dt * 0.006) % 360; // ~6°/s
    }
    lastSpin = t;
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

  window.addEventListener("resize", resize);

  // ---- boot ---------------------------------------------------------------

  resize();
  scale = baseScale;

  // Start the render loop immediately so the ocean, stars and atmosphere
  // appear right away; land pops in once its data finishes loading.
  lastSpin = performance.now();
  requestAnimationFrame(frame);

  fetch("land-50m.json")
    .then((r) => r.json())
    .then((topo) => {
      land = topojson.feature(topo, topo.objects.land);
    })
    .catch((err) => {
      console.error("Failed to load land data:", err);
    });
})();
