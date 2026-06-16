(function () {
  "use strict";

  const canvas = document.getElementById("globe");
  const ctx = canvas.getContext("2d");

  let width = 0, height = 0, dpr = 1, cx = 0, cy = 0;
  let baseScale = 0;          // scale that fits the viewport
  let scale = 0;              // current scale (controls zoom)
  const MIN_K = 0.55, MAX_K = 16; // zoom multipliers (16× ≈ a country fills the view)

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
  let paused = false, playAccum = 0; // paused freezes planes, spin, and time
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

  // Per-country custom colors (override the continent color when set).
  const countryRGB = {}; // country name -> [r,g,b]
  function rgbOf(country, cont) { return countryRGB[country] || CONT_RGB[cont != null ? cont : 6]; }
  const cssRGB = (a) => `rgb(${a[0]},${a[1]},${a[2]})`;
  const cssRGBA = (a, al) => `rgba(${a[0]},${a[1]},${a[2]},${al})`;
  function hexToRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function rgbToHex(a) { return "#" + a.map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join(""); }

  let markAirports = []; // airport indices to mark (airports of selected countries)
  function computeMarks() {
    markAirports = [];
    const showAll = alwaysAirports;
    if (!showAll && !depSel.size && !arrSel.size) return;
    for (let i = 0; i < airports.length && markAirports.length < 500; i++) {
      const a = airports[i];
      if (showAll || (a.cty && (depSel.has(a.cty) || arrSel.has(a.cty)))) markAirports.push(i);
    }
  }

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

  // ---- routes, airports, departure/arrival filters ------------------------
  let countries = [];        // index -> country name
  let airports = [];         // index -> {iata,name,cty,cont,lon,lat}
  const depSel = new Set();  // selected DEPARTURE country names
  const arrSel = new Set();  // selected ARRIVAL country names
  let depTree = {};          // contIdx -> Map(country -> Set(airportIdx))  origins
  let arrTree = {};          // contIdx -> Map(country -> Set(airportIdx))  destinations
  let shown = [];            // route indices (within activeN) passing the filter
  let countryFeatures = null, countryBounds = null; // for live point-in-country
  const LINE_CAP = 450;      // draw route arcs only when shown count is manageable
  let wP80 = 0, wP95 = 0;    // weight percentiles → route line thickness/brightness tiers
  let focusRoute = null;     // a clicked single route (overrides the filter)
  let focusCountry = null;   // a clicked country whose analysis fills the summary
  let neonOn = true;         // neon land glow toggle
  let neonColor = "blue";    // neon hue preset
  let alwaysAirports = false; // show all airports as markers even without a selection
  let flowType = "all";      // route flow filter: all | intl | dom
  let countryAirports = {};  // country name -> [airport idx] (all airports of the country)
  let rlRoutes = [], rlPage = 0, rlCountry = null; // right-side route list (paginated)
  const RL_PER = 7;
  let flyAnim = null; // animated globe move to a country/airport

  // Smoothly rotate (and zoom) the globe to center a lon/lat.
  function flyTo(lon, lat, k) {
    const r = projection.rotate();
    let dLon = -lon - r[0];
    while (dLon > 180) dLon -= 360;
    while (dLon < -180) dLon += 360;
    flyAnim = {
      fromLon: r[0], dLon, fromLat: r[1], toLat: Math.max(-90, Math.min(90, -lat)),
      fromS: scale, toS: k ? Math.max(baseScale * MIN_K, Math.min(baseScale * MAX_K, baseScale * k)) : scale,
      t0: performance.now(), dur: 750,
    };
  }
  function countryCentroid(name) {
    const a = (countryAirports[name] || []).map((i) => airports[i]);
    if (!a.length) return null;
    let x = 0, y = 0;
    for (const p of a) { x += p.lon; y += p.lat; }
    return [x / a.length, y / a.length];
  }

  // Neon hue presets (land sheen / atmosphere / coastline / border / rim).
  const PALETTE = {
    blue:   { land: ["#13e58a", "#0fd6a6", "#2fb6ff"], atmo: ["rgba(120,90,255,0.30)", "rgba(60,150,255,0.16)"], coast: "rgba(170,255,225,0.95)", border: "rgba(206,138,255,0.95)", rim: "#5a8cff", grat: "rgba(90,150,255,0.22)" },
    green:  { land: ["#1fe85a", "#16d24a", "#86ff39"], atmo: ["rgba(60,255,120,0.28)", "rgba(120,255,80,0.16)"], coast: "rgba(190,255,190,0.95)", border: "rgba(120,255,160,0.9)", rim: "#39ff7a", grat: "rgba(90,255,150,0.22)" },
  };
  const pal = () => PALETTE[neonColor] || PALETTE.blue;

  // Realistic (neon-off) Natural Earth texture, reprojected onto the sphere.
  let texData = null, texW = 0, texH = 0;
  let texCanvas = null, texCtx = null, texKey = "", texStep = 99;
  const texImg = new Image();
  texImg.onload = () => {
    const c = document.createElement("canvas");
    c.width = texImg.naturalWidth; c.height = texImg.naturalHeight;
    const cc = c.getContext("2d");
    cc.drawImage(texImg, 0, 0);
    texW = c.width; texH = c.height;
    texData = cc.getImageData(0, 0, texW, texH).data;
    texKey = "";
  };
  texImg.src = "earth-hypso.jpg?v=1";

  // Plane cap by how narrow the current view is.
  function coversFullContinent(sel, tree) {
    for (const c in tree) {
      const cties = [...tree[c].keys()];
      if (cties.length && cties.every((n) => sel.has(n))) return true;
    }
    return false;
  }
  function selectionCap() {
    if (focusRoute != null) return 5;            // a single clicked route
    const d = depSel.size > 0, a = arrSel.size > 0;
    if (d && a) return 20;                        // country → country
    if (d) return coversFullContinent(depSel, depTree) ? 60 : 50;
    if (a) return coversFullContinent(arrSel, arrTree) ? 60 : 50;
    return 80;                                    // whole world
  }

  let speed = 1;             // playback speed multiplier
  const BASE_MS_PER_DAY = 5000; // 1× = one day per 5 seconds

  // Departure ∩ arrival rule (both empty = no filter = show all):
  function routeShown(r) {
    if (flowType === "dom" && r.oCountry !== r.dCountry) return false;
    if (flowType === "intl" && r.oCountry === r.dCountry) return false;
    const depOk = depSel.size === 0 || depSel.has(r.oCountry);
    const arrOk = arrSel.size === 0 || arrSel.has(r.dCountry);
    return depOk && arrOk;
  }

  // Korean labels for the countries that appear in the panels.
  const KO = {
    "Afghanistan": "아프가니스탄", "Albania": "알바니아", "Algeria": "알제리", "Argentina": "아르헨티나",
    "Australia": "호주", "Austria": "오스트리아", "Bangladesh": "방글라데시", "Belgium": "벨기에",
    "Benin": "베냉", "Bolivia": "볼리비아", "Brazil": "브라질", "Burkina Faso": "부르키나파소",
    "Burundi": "부룬디", "Cambodia": "캄보디아", "Cameroon": "카메룬", "Canada": "캐나다",
    "Chile": "칠레", "China": "중국", "Colombia": "콜롬비아", "Croatia": "크로아티아",
    "Cyprus": "키프로스", "Czechia": "체코", "Côte d'Ivoire": "코트디부아르",
    "Dem. Rep. Congo": "콩고민주공화국", "Denmark": "덴마크", "Dominican Rep.": "도미니카공화국",
    "Ecuador": "에콰도르", "Egypt": "이집트", "Ethiopia": "에티오피아", "Finland": "핀란드",
    "France": "프랑스", "Gambia": "감비아", "Germany": "독일", "Ghana": "가나", "Greece": "그리스",
    "Guatemala": "과테말라", "Guinea": "기니", "India": "인도", "Indonesia": "인도네시아",
    "Iran": "이란", "Ireland": "아일랜드", "Italy": "이탈리아", "Japan": "일본",
    "Kazakhstan": "카자흐스탄", "Kenya": "케냐", "Kuwait": "쿠웨이트", "Kyrgyzstan": "키르기스스탄",
    "Liberia": "라이베리아", "Libya": "리비아", "Malawi": "말라위", "Malaysia": "말레이시아",
    "Mali": "말리", "Mexico": "멕시코", "Montenegro": "몬테네그로", "Morocco": "모로코",
    "Myanmar": "미얀마", "Namibia": "나미비아", "Nepal": "네팔", "Netherlands": "네덜란드",
    "New Zealand": "뉴질랜드", "Niger": "니제르", "Nigeria": "나이지리아", "Norway": "노르웨이",
    "Oman": "오만", "Pakistan": "파키스탄", "Panama": "파나마", "Peru": "페루",
    "Philippines": "필리핀", "Poland": "폴란드", "Portugal": "포르투갈", "Puerto Rico": "푸에르토리코",
    "Romania": "루마니아", "Russia": "러시아", "Rwanda": "르완다", "Saudi Arabia": "사우디아라비아",
    "Senegal": "세네갈", "Serbia": "세르비아", "Sierra Leone": "시에라리온", "Somalia": "소말리아",
    "South Africa": "남아프리카공화국", "South Korea": "대한민국", "Spain": "스페인",
    "Sri Lanka": "스리랑카", "Sweden": "스웨덴", "Switzerland": "스위스", "Taiwan": "대만",
    "Tanzania": "탄자니아", "Thailand": "태국", "Togo": "토고", "Turkey": "튀르키예",
    "Uganda": "우간다", "United Arab Emirates": "아랍에미리트", "United Kingdom": "영국",
    "United States of America": "미국", "Venezuela": "베네수엘라", "Vietnam": "베트남",
    "Zambia": "잠비아", "Zimbabwe": "짐바브웨",
  };
  const koName = (n) => KO[n] || n;

  // Airport IATA -> Korean name (Korea complete + major world hubs).
  const KO_AIR = {
    ICN: "인천", GMP: "김포", PUS: "김해(부산)", CJU: "제주", TAE: "대구", KWJ: "광주",
    CJJ: "청주", MWX: "무안", RSU: "여수", USN: "울산", KPO: "포항경주", YNY: "양양",
    KUV: "군산", WJU: "원주", HIN: "사천",
    NRT: "도쿄(나리타)", HND: "도쿄(하네다)", KIX: "오사카(간사이)", FUK: "후쿠오카",
    NGO: "나고야", CTS: "삿포로", OKA: "오키나와", KOJ: "가고시마",
    PEK: "베이징", PKX: "베이징(다싱)", PVG: "상하이(푸둥)", SHA: "상하이(훙차오)",
    CAN: "광저우", SZX: "선전", CTU: "청두", TAO: "칭다오", SHE: "선양", DLC: "다롄",
    HKG: "홍콩", MFM: "마카오", TPE: "타이베이", KHH: "가오슝",
    BKK: "방콕(수완나품)", DMK: "방콕(돈므앙)", SIN: "싱가포르", KUL: "쿠알라룸푸르",
    CGK: "자카르타", DPS: "발리", MNL: "마닐라", CEB: "세부", SGN: "호치민", HAN: "하노이",
    DAD: "다낭", RGN: "양곤", PNH: "프놈펜", DEL: "델리", BOM: "뭄바이", CMB: "콜롬보",
    KTM: "카트만두", DAC: "다카",
    DXB: "두바이", AUH: "아부다비", DOH: "도하", RUH: "리야드", JED: "제다", KWI: "쿠웨이트",
    TLV: "텔아비브", IST: "이스탄불",
    LHR: "런던(히드로)", LGW: "런던(개트윅)", CDG: "파리(샤를드골)", FRA: "프랑크푸르트",
    MUC: "뮌헨", AMS: "암스테르담", MAD: "마드리드", BCN: "바르셀로나", FCO: "로마",
    MXP: "밀라노", ZRH: "취리히", VIE: "빈", BRU: "브뤼셀", CPH: "코펜하겐", ARN: "스톡홀름",
    OSL: "오슬로", HEL: "헬싱키", SVO: "모스크바", ATH: "아테네", LIS: "리스본", DUB: "더블린",
    JFK: "뉴욕(JFK)", EWR: "뉴욕(뉴어크)", LAX: "로스앤젤레스", SFO: "샌프란시스코",
    ORD: "시카고", ATL: "애틀랜타", SEA: "시애틀", DFW: "댈러스", IAD: "워싱턴", BOS: "보스턴",
    LAS: "라스베이거스", HNL: "호놀룰루", YVR: "밴쿠버", YYZ: "토론토", MEX: "멕시코시티",
    GRU: "상파울루", GIG: "리우데자네이루", EZE: "부에노스아이레스", SCL: "산티아고",
    LIM: "리마", BOG: "보고타",
    SYD: "시드니", MEL: "멜버른", BNE: "브리즈번", AKL: "오클랜드", GUM: "괌", SPN: "사이판",
    CAI: "카이로", JNB: "요하네스버그", CPT: "케이프타운", NBO: "나이로비", ADD: "아디스아바바",
    CMN: "카사블랑카", LOS: "라고스",
  };
  const airLabel = (a) => a.iata
    ? (KO_AIR[a.iata] ? a.iata + " " + KO_AIR[a.iata] : a.iata + " " + a.name)
    : a.name;

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

  function sampleArc(interp) {
    const n = 22, a = [];
    for (let i = 0; i <= n; i++) a.push(interp(i / n));
    return a;
  }

  function buildRoutes(data) {
    countries = data.countries || [];
    airports = (data.airports || []).map((a) => ({
      iata: a[0], name: a[1], cty: a[2] >= 0 ? countries[a[2]] : null, cont: a[3], lon: a[4], lat: a[5],
    }));
    routes = data.routes.map((a) => {
      const oi = a[1], di = a[2];
      const oa = airports[oi], da = airports[di];
      const o = [oa.lon, oa.lat], d = [da.lon, da.lat];
      const interp = d3.geoInterpolate(o, d);
      return {
        o, d, w: a[0], interp,
        lineCoords: sampleArc(interp),
        dist: Math.max(0.02, d3.geoDistance(o, d)),
        oAirIdx: oi, dAirIdx: di, oAir: oa, dAir: da,
        oCont: oa.cont, dCont: da.cont, oCountry: oa.cty, dCountry: da.cty,
      };
    });
    const ws = routes.map((r) => r.w).sort((a, b) => a - b);
    wP80 = ws[Math.floor(ws.length * 0.8)] || 0;
    wP95 = ws[Math.floor(ws.length * 0.95)] || 0;
    buildTrees();
    buildCountryAirports();
    computeCaps();
    maxPlanes = selectionCap();
    rebuildShown();
    buildSummary();
  }

  function buildCountryAirports() {
    countryAirports = {};
    for (let i = 0; i < airports.length; i++) {
      const c = airports[i].cty;
      if (!c) continue;
      (countryAirports[c] = countryAirports[c] || []).push(i);
    }
  }

  function buildTrees() {
    depTree = {}; arrTree = {};
    const add = (tree, cont, cty, ai) => {
      if (cty == null) return;
      (tree[cont] = tree[cont] || new Map());
      if (!tree[cont].has(cty)) tree[cont].set(cty, new Set());
      tree[cont].get(cty).add(ai);
    };
    for (const r of routes) {
      add(depTree, r.oCont, r.oCountry, r.oAirIdx);
      add(arrTree, r.dCont, r.dCountry, r.dAirIdx);
    }
  }

  // Scale route count and plane cap to the viewport (1280×720 ≈ baseline).
  function computeCaps() {
    const f = (width * height) / 921600;
    activeN = Math.round(Math.max(400, Math.min(routes.length || 1700, 1700 * f)));
    if (routes.length) activeN = Math.min(activeN, routes.length);
  }

  // Recompute the visible route set (filtered) and reassign planes onto it.
  function rebuildShown() {
    if (!routes.length) return;
    shown = []; cumW = []; totalW = 0;
    if (focusRoute != null) {
      shown = [focusRoute]; totalW = routes[focusRoute].w; cumW = [totalW];
    } else {
      // Filtered views consider every route (small sets); the unfiltered world
      // view is capped to activeN for performance.
      const filtered = depSel.size > 0 || arrSel.size > 0;
      const N = filtered ? routes.length : activeN;
      for (let i = 0; i < N; i++) {
        if (routeShown(routes[i])) { shown.push(i); totalW += routes[i].w; cumW.push(totalW); }
      }
    }
    if (!shown.length) { planes.length = 0; return; }
    for (const pl of planes) respawn(pl);
  }

  function weightedPick() { // -> a route index drawn from `shown`, weighted
    const x = Math.random() * totalW;
    let lo = 0, hi = cumW.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cumW[m] < x) lo = m + 1; else hi = m; }
    return shown[lo];
  }

  function respawn(pl) {
    pl.ri = weightedPick();
    pl.t = 0;
    pl.sp = SPEED_K / routes[pl.ri].dist;
  }

  function setPlaneCount(n) {
    if (!routes.length || !shown.length) { planes.length = 0; return; }
    n = Math.max(0, Math.min(maxPlanes, n));
    while (planes.length < n) { const pl = {}; respawn(pl); pl.t = Math.random(); planes.push(pl); }
    if (planes.length > n) planes.length = n;
  }

  // Recompute filter + plane count after a selection change.
  function applyFilter() {
    maxPlanes = selectionCap();
    rebuildShown();
    computeMarks();
    buildSummary();
    if (daily && !liveMode) setPlaneCount(Math.round((daily.counts[dayIndex] / maxCount) * maxPlanes));
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
  const elSummary = document.getElementById("summary");
  const elSumTitle = document.getElementById("sum-title");
  const elSumBody = document.getElementById("sum-body");

  // ---- filter summary panel ----------------------------------------------
  function fmtNames(set) {
    const a = [...set];
    if (!a.length) return "";
    if (a.length === 1) return koName(a[0]);
    return koName(a[0]) + " 외 " + (a.length - 1) + "개국";
  }
  function topByWeight(map, n) {
    return [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, n);
  }

  function renderSummary(title, rows) {
    elSumTitle.textContent = title;
    elSumBody.innerHTML = rows.map((r) =>
      '<div class="sum-row"><span class="sum-k">' + r[0] + '</span><span class="sum-v">' + r[1] + "</span></div>"
    ).join("");
    elSummary.hidden = false;
  }

  // Detailed analysis for a single clicked country (both directions).
  function buildCountrySummary(C) {
    const depAir = new Map(), goC = new Map(), inC = new Map();
    for (const r of routes) {
      if (r.oCountry === C) {
        const oa = r.oAir.iata || r.oAir.name;
        depAir.set(oa, (depAir.get(oa) || 0) + r.w);
        if (r.dCountry) goC.set(r.dCountry, (goC.get(r.dCountry) || 0) + r.w);
      }
      if (r.dCountry === C && r.oCountry) inC.set(r.oCountry, (inC.get(r.oCountry) || 0) + r.w);
    }
    const dash = (s) => s || "-";
    renderSummary(koName(C) + " 항공 흐름", [
      ["주요 출발 공항", dash(topByWeight(depAir, 3).map((e) => e[0]).join(", "))],
      ["많이 가는 국가", dash(topByWeight(goC, 5).map((e) => koName(e[0])).join(", "))],
      ["많이 들어오는 국가", dash(topByWeight(inC, 5).map((e) => koName(e[0])).join(", "))],
    ]);
  }

  function buildSummary() {
    if (!elSummary) return;
    if (liveMode || !routes.length) { elSummary.hidden = true; return; }
    if (focusCountry) { buildCountrySummary(focusCountry); return; }
    const hasDep = depSel.size > 0, hasArr = arrSel.size > 0;
    const destC = new Map(), origC = new Map(), origA = new Map(), destA = new Map();
    for (const ri of shown) {
      const r = routes[ri];
      if (r.dCountry) destC.set(r.dCountry, (destC.get(r.dCountry) || 0) + r.w);
      if (r.oCountry) origC.set(r.oCountry, (origC.get(r.oCountry) || 0) + r.w);
      const oa = r.oAir.iata || r.oAir.name, da = r.dAir.iata || r.dAir.name;
      origA.set(oa, (origA.get(oa) || 0) + r.w);
      destA.set(da, (destA.get(da) || 0) + r.w);
    }
    const topRoutes = shown.map((ri) => routes[ri]).sort((a, b) => b.w - a.w).slice(0, 3)
      .map((r) => (r.oAir.iata || r.oAir.name) + " → " + (r.dAir.iata || r.dAir.name));
    const dash = (s) => s || "-";

    let title;
    const rows = [["표시 노선", shown.length.toLocaleString("ko-KR") + "개"]];
    if (hasDep && hasArr) {
      title = fmtNames(depSel) + " → " + fmtNames(arrSel) + " 항공 흐름";
      rows.push(["주요 노선", dash(topRoutes.join(", "))]);
      let depTotal = 0;
      for (let i = 0; i < routes.length; i++) if (depSel.has(routes[i].oCountry)) depTotal++;
      const pct = depTotal ? Math.round((shown.length / depTotal) * 100) : 0;
      rows.push(["전체 대비", fmtNames(depSel) + " 출발 노선 중 약 " + pct + "%"]);
    } else if (hasDep) {
      title = fmtNames(depSel) + " 출발 항공 흐름";
      rows.push(["주요 도착국", dash(topByWeight(destC, 5).map((e) => koName(e[0])).join(", "))]);
      rows.push(["주요 출발 공항", dash(topByWeight(origA, 4).map((e) => e[0]).join(", "))]);
      rows.push(["가장 강한 노선", dash(topRoutes.join(", "))]);
    } else if (hasArr) {
      title = fmtNames(arrSel) + " 도착 항공 흐름";
      rows.push(["주요 출발국", dash(topByWeight(origC, 5).map((e) => koName(e[0])).join(", "))]);
      rows.push(["주요 도착 공항", dash(topByWeight(destA, 4).map((e) => e[0]).join(", "))]);
      rows.push(["가장 강한 노선", dash(topRoutes.join(", "))]);
    } else {
      title = "전체 항공 흐름";
      rows.push(["주요 출발국", dash(topByWeight(origC, 5).map((e) => koName(e[0])).join(", "))]);
      rows.push(["가장 강한 노선", dash(topRoutes.join(", "))]);
    }
    elSumTitle.textContent = title;
    elSumBody.innerHTML = rows.map((r) =>
      '<div class="sum-row"><span class="sum-k">' + r[0] + '</span><span class="sum-v">' + r[1] + "</span></div>"
    ).join("");
    elSummary.hidden = false;
  }

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
    if (!routes.length) return;
    const rot = projection.rotate();
    const center = [-rot[0], -rot[1]];
    const horizon = Math.PI / 2 - 0.02;
    const glyphScale = Math.max(0.25, Math.min(1.2, scale * 0.0017));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Persistent route arcs — width + brightness scale with traffic weight (~2× thicker).
    // When a country is selected, the busiest route(s) are drawn in neon green.
    if (shown.length && shown.length <= LINE_CAP) {
      const countrySel = depSel.size > 0 || arrSel.size > 0;
      let shownMaxW = 0;
      if (countrySel) for (const ri of shown) if (routes[ri].w > shownMaxW) shownMaxW = routes[ri].w;
      const NEON_GREEN = [57, 255, 20];

      const drawArc = (r, lw, col, al) => {
        ctx.lineWidth = lw;
        ctx.strokeStyle = cssRGBA(col, al);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < r.lineCoords.length; i++) {
          if (d3.geoDistance(r.lineCoords[i], center) > horizon) { started = false; continue; }
          const pp = projection(r.lineCoords[i]);
          if (started) ctx.lineTo(pp[0], pp[1]);
          else { ctx.moveTo(pp[0], pp[1]); started = true; }
        }
        ctx.stroke();
      };

      const greens = [];
      for (const ri of shown) {
        const r = routes[ri];
        if (countrySel && r.w === shownMaxW) { greens.push(r); continue; }
        let lw, al;
        if (r.w >= wP95) { lw = 7.2; al = 0.6; }         // top ~5%: bright + thick
        else if (r.w >= wP80) { lw = 4.2; al = 0.34; }   // top ~20%: medium
        else { lw = 2.2; al = 0.15; }                    // rest: thin + faint
        drawArc(r, lw, rgbOf(r.oCountry, r.oCont), al);
      }
      for (const r of greens) drawArc(r, 8, NEON_GREEN, 0.95); // busiest route(s) on top
    }

    drawMarks(center, horizon);

    // Plane trails then glyphs (planes already live only on shown routes).
    ctx.lineWidth = 1;
    for (const pl of planes) {
      if (!paused) { pl.t += pl.sp; if (pl.t >= 1) { respawn(pl); continue; } }
      const r = routes[pl.ri];
      const head = r.interp(pl.t);
      if (d3.geoDistance(head, center) > horizon) continue;
      ctx.strokeStyle = cssRGBA(rgbOf(r.oCountry, r.oCont), 0.34);
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
      const head = r.interp(pl.t);
      if (d3.geoDistance(head, center) > horizon) continue;
      const p0 = projection(head);
      const pa = projection(r.interp(Math.min(1, pl.t + 0.012)));
      const ang = Math.atan2(pa[1] - p0[1], pa[0] - p0[0]);
      ctx.fillStyle = cssRGB(rgbOf(r.oCountry, r.oCont));
      ctx.save();
      ctx.translate(p0[0], p0[1]);
      ctx.rotate(ang);
      ctx.scale(glyphScale, glyphScale);
      planeGlyph();
      ctx.restore();
    }
    ctx.restore();
  }

  // Airport location markers for selected countries (small glowing rings).
  function drawMarks(center, horizon) {
    if (!markAirports.length) return;
    const rr = Math.max(2, Math.min(5, scale * 0.012));
    for (const ai of markAirports) {
      const a = airports[ai];
      if (d3.geoDistance([a.lon, a.lat], center) > horizon) continue;
      const p = projection([a.lon, a.lat]);
      const col = cssRGB(rgbOf(a.cty, a.cont));
      ctx.beginPath();
      ctx.arc(p[0], p[1], rr, 0, Math.PI * 2);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p[0], p[1], rr * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }
  }

  function liveShown(pl) {
    if (depSel.size === 0 && arrSel.size === 0) return true;
    return depSel.has(pl.country) || arrSel.has(pl.country);
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
    drawMarks(center, horizon);
    for (const pl of livePlanes) {
      if (pl.vel > 0 && !paused) { const np = destination(pl.lon, pl.lat, pl.track, pl.vel * secs); pl.lon = np[0]; pl.lat = np[1]; }
      if (!liveShown(pl)) continue;
      const pos = [pl.lon, pl.lat];
      if (d3.geoDistance(pos, center) > horizon) continue;
      const p0 = projection(pos);
      const ahead = destination(pl.lon, pl.lat, pl.track, 30000);
      const pa = projection(ahead);
      const ang = Math.atan2(pa[1] - p0[1], pa[0] - p0[0]);
      ctx.fillStyle = cssRGB(rgbOf(pl.country, pl.cont));
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
      rebuildShown();
      buildSummary();
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
    const r0 = scale * 0.96;
    const r1 = scale * (neonOn ? 1.35 : 1.18);
    const halo = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    if (neonOn) {
      const A = pal().atmo;
      halo.addColorStop(0, A[0].replace(/[\d.]+\)$/, "0)"));
      halo.addColorStop(0.4, A[0]);
      halo.addColorStop(0.7, A[1]);
      halo.addColorStop(1, A[1].replace(/[\d.]+\)$/, "0)"));
    } else {
      // Thin realistic blue limb haze.
      halo.addColorStop(0, "rgba(120, 170, 230, 0)");
      halo.addColorStop(0.6, "rgba(120, 175, 235, 0.12)");
      halo.addColorStop(1, "rgba(120, 175, 235, 0)");
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawOcean() {
    const oc = ctx.createRadialGradient(
      cx - scale * 0.3, cy - scale * 0.3, scale * 0.1,
      cx, cy, scale
    );
    if (neonOn) {
      oc.addColorStop(0, "#241159"); oc.addColorStop(0.55, "#12104a"); oc.addColorStop(1, "#070a33");
    } else {
      // Realistic sea: lit blue near the sub-solar highlight → dark at the limb.
      oc.addColorStop(0, "#3f86c4"); oc.addColorStop(0.55, "#1d5a90"); oc.addColorStop(1, "#0a2740");
    }
    ctx.beginPath();
    path(sphere);
    ctx.fillStyle = oc;
    ctx.fill();
  }

  function drawGraticule() {
    if (!neonOn) return; // realistic globe has no neon grid
    ctx.beginPath();
    path(graticule);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = pal().grat;
    ctx.stroke();
    ctx.restore();
  }

  // Approximate biome/terrain bands for the realistic (neon-off) globe.
  const lonlatBox = (b) => ({ type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] });
  const BIOMES = [
    ["#eef4f8", -180, -90, 180, -63], ["#eef4f8", -55, 60, -18, 84],
    ["#eef4f8", -140, 72, -60, 84], ["#eef4f8", 60, 72, 180, 84],          // ice
    ["#cdb27a", -16, 15, 35, 30], ["#cdb27a", 35, 15, 58, 30], ["#cdb27a", 58, 25, 78, 35],
    ["#cdb27a", 90, 38, 112, 46], ["#cdb27a", 118, -30, 142, -20], ["#cdb27a", 12, -28, 25, -18],
    ["#cdb27a", -116, 24, -104, 36], ["#cdb27a", -71, -26, -68, -19],       // desert
    ["#2e6b34", -74, -10, -50, 3], ["#2e6b34", 11, -5, 30, 5], ["#2e6b34", 96, -6, 120, 7], // jungle
    ["#998b76", 74, 27, 96, 36], ["#998b76", -74, -38, -67, 2], ["#998b76", -122, 36, -108, 54], ["#998b76", 6, 45, 15, 48], // mountains
  ];
  const RIVERS = [
    [[31, 31], [31, 24], [32, 16], [31, 9], [30, 4]],
    [[-49, -1], [-58, -3], [-67, -4], [-73, -5]],
    [[-90, 29], [-91, 35], [-90, 39], [-93, 44], [-95, 47]],
    [[121, 31], [114, 30], [106, 30], [99, 28]],
    [[12, -6], [18, -4], [24, 0], [27, 2]],
  ];
  function drawTerrain() {
    lctx.save();
    lctx.beginPath(); lpath(land); lctx.clip();
    for (const bi of BIOMES) { lctx.beginPath(); lpath(lonlatBox(bi.slice(1))); lctx.fillStyle = bi[0]; lctx.fill(); }
    lctx.lineWidth = Math.max(0.8, scale * 0.0016);
    lctx.strokeStyle = "#3f7fb0";
    for (const rv of RIVERS) { lctx.beginPath(); lpath({ type: "LineString", coordinates: rv }); lctx.stroke(); }
    lctx.restore();
  }

  // ---- realistic textured globe (neon off) -------------------------------
  function ensureTexCanvas() {
    if (!texCanvas) { texCanvas = document.createElement("canvas"); texCtx = texCanvas.getContext("2d"); }
    if (texCanvas.width !== width || texCanvas.height !== height) {
      texCanvas.width = width; texCanvas.height = height; texKey = "";
    }
  }
  function reprojectKey() {
    const r = projection.rotate();
    return r[0].toFixed(1) + "_" + r[1].toFixed(1) + "_" + scale.toFixed(0);
  }
  function reproject(step) {
    const img = texCtx.createImageData(width, height);
    const od = img.data;
    const R2 = scale * scale, invert = projection.invert;
    for (let y = 0; y < height; y += step) {
      const dy = y - cy;
      for (let x = 0; x < width; x += step) {
        const dx = x - cx;
        if (dx * dx + dy * dy > R2) continue;
        const ll = invert([x, y]);
        if (!ll) continue;
        let u = (((ll[0] + 180) / 360) * texW) | 0; if (u < 0) u = 0; else if (u >= texW) u = texW - 1;
        let v = (((90 - ll[1]) / 180) * texH) | 0; if (v < 0) v = 0; else if (v >= texH) v = texH - 1;
        const si = (v * texW + u) << 2;
        const r = texData[si], g = texData[si + 1], b = texData[si + 2];
        for (let yy = 0; yy < step; yy++) {
          const Y = y + yy; if (Y >= height) break;
          for (let xx = 0; xx < step; xx++) {
            const X = x + xx; if (X >= width) break;
            const di = (Y * width + X) << 2;
            od[di] = r; od[di + 1] = g; od[di + 2] = b; od[di + 3] = 255;
          }
        }
      }
    }
    texCtx.putImageData(img, 0, 0);
  }
  function drawTexturedGlobe() {
    if (!texData) { // texture not loaded yet → plain ocean disc
      ctx.beginPath(); path(sphere); ctx.fillStyle = "#11385e"; ctx.fill(); return;
    }
    ensureTexCanvas();
    const wantStep = dragging ? 2 : 1;
    const key = reprojectKey();
    if (key !== texKey || wantStep < texStep) { reproject(wantStep); texKey = key; texStep = wantStep; }
    ctx.drawImage(texCanvas, 0, 0, width, height);
  }

  function drawLand() {
    if (!land) return;

    // Draw land once onto the offscreen layer — solid body + bright coastline,
    // no per-path shadow (which is what made it crawl).
    lctx.clearRect(0, 0, width, height);

    lctx.beginPath();
    lpath(land);
    if (neonOn) {
      const P = pal().land;
      const sheen = lctx.createLinearGradient(cx - scale, cy - scale, cx + scale, cy + scale);
      sheen.addColorStop(0, P[0]);
      sheen.addColorStop(0.5, P[1]);
      sheen.addColorStop(1, P[2]);
      lctx.fillStyle = sheen;
      lctx.fill();
    } else {
      // Realistic land: base green, then terrain (desert/forest/ice/mountain/rivers).
      lctx.fillStyle = "#4f7d3c";
      lctx.fill();
      drawTerrain();
    }

    lctx.beginPath();
    lpath(land);
    lctx.lineWidth = Math.max(0.6, scale * 0.0018);
    lctx.strokeStyle = neonOn ? pal().coast : "rgba(40, 70, 35, 0.5)";
    lctx.stroke();

    // Country borders.
    if (borders) {
      lctx.beginPath();
      lpath(borders);
      lctx.lineWidth = Math.max(0.7, scale * 0.0014);
      lctx.strokeStyle = neonOn ? pal().border : "rgba(70, 95, 60, 0.45)";
      lctx.stroke();
    }

    ctx.save();
    if (neonOn) {
      // Bloom: additive blurred copy + sharp copy on top.
      ctx.globalCompositeOperation = "lighter";
      const blur = Math.max(4, Math.min(14, scale * 0.018)); // cap so deep zoom stays fast
      if ("filter" in ctx) {
        ctx.filter = "blur(" + blur.toFixed(1) + "px)";
        ctx.globalAlpha = 0.85;
        ctx.drawImage(layer, 0, 0, width, height);
        ctx.filter = "none";
      }
      ctx.globalAlpha = 1;
      ctx.drawImage(layer, 0, 0, width, height);
    } else {
      // Flat: no glow, just the sharp land.
      ctx.drawImage(layer, 0, 0, width, height);
    }
    ctx.restore();
  }

  function drawRim() {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (neonOn) {
      ctx.shadowColor = pal().rim; ctx.shadowBlur = 18;
      ctx.lineWidth = 1.4; ctx.strokeStyle = pal().rim;
    } else {
      ctx.shadowColor = "#aacdf0"; ctx.shadowBlur = 6;
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(150, 185, 225, 0.45)";
    }
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
    if (neonOn) {
      drawOcean();
      drawGraticule();
      drawLand();
    } else {
      drawTexturedGlobe(); // Natural Earth hypso texture (ocean + land + relief)
    }
    drawFlights(frameDt);
    drawRim();
  }

  function frame(t) {
    const dt = t - lastFrame;
    lastFrame = t;
    frameDt = dt;
    lastSpin = t; // auto-rotation disabled — globe only turns when dragged
    if (flyAnim) {
      const e = Math.min(1, (t - flyAnim.t0) / flyAnim.dur);
      const ease = e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2;
      rotation[0] = flyAnim.fromLon + flyAnim.dLon * ease;
      rotation[1] = flyAnim.fromLat + (flyAnim.toLat - flyAnim.fromLat) * ease;
      scale = flyAnim.fromS + (flyAnim.toS - flyAnim.fromS) * ease;
      if (e >= 1) flyAnim = null;
    }
    if (!paused && !liveMode && daily) {
      playAccum += dt;
      const msPerDay = BASE_MS_PER_DAY / speed;
      while (playAccum >= msPerDay) {
        playAccum -= msPerDay;
        if (dayIndex + 1 >= daily.counts.length) { playAccum = 0; break; } // reached today — hold
        setDay(dayIndex + 1);
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
  let lastX = 0, lastY = 0, downX = 0, downY = 0;
  let spinResume = null;

  function pointerDown(e) {
    dragging = true;
    autoSpin = false;
    flyAnim = null; // a drag cancels any in-progress fly-to
    if (spinResume) clearTimeout(spinResume);
    lastX = e.clientX;
    lastY = e.clientY;
    downX = e.clientX;
    downY = e.clientY;
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
    // A tap (no real drag, single pointer) tries to select a route line.
    if (active.size === 0 && Math.hypot(e.clientX - downX, e.clientY - downY) < 5) {
      routeClick(e.clientX, e.clientY);
    }
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
    paused = !paused;
    elPlay.textContent = paused ? "▶" : "❚❚";
    elPlay.title = paused ? "재생 (비행기·자전 재개)" : "일시정지 (화면 멈춤)";
  });
  if (elLive) elLive.addEventListener("click", () => setLiveMode(!liveMode));

  if (elDatePick) {
    elDatePick.addEventListener("change", () => {
      if (liveMode || !daily) return;
      const t = Date.parse(elDatePick.value + "T00:00:00Z");
      if (!isNaN(t)) setDay(Math.round((t - START_MS) / DAY_MS));
    });
  }

  // Speed buttons (1× / 2× / 4× / 8× / 16×).
  document.querySelectorAll("#speeds button").forEach((b) => {
    b.addEventListener("click", () => {
      speed = +b.dataset.sp;
      document.querySelectorAll("#speeds button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });

  // Neon color presets.
  document.querySelectorAll("#neon-colors button").forEach((b) => {
    b.addEventListener("click", () => {
      neonColor = b.dataset.nc;
      document.querySelectorAll("#neon-colors button").forEach((x) => x.classList.toggle("on", x === b));
    });
  });

  // International / domestic / all flow filter.
  document.querySelectorAll("#flowbar button").forEach((b) => {
    b.addEventListener("click", () => {
      flowType = b.dataset.flow;
      document.querySelectorAll("#flowbar button").forEach((x) => x.classList.toggle("on", x === b));
      focusRoute = null; hideRoutePopup(); applyFilter();
    });
  });

  // Route-list pagination.
  const rlPrev = document.getElementById("rl-prev");
  const rlNext = document.getElementById("rl-next");
  const rlClose = document.getElementById("rl-close");
  if (rlPrev) rlPrev.addEventListener("click", () => { rlPage--; renderRouteList(); });
  if (rlNext) rlNext.addEventListener("click", () => { rlPage++; renderRouteList(); });
  if (rlClose) rlClose.addEventListener("click", () => { document.getElementById("routelist").hidden = true; });

  // ---- departure / arrival filter UI -------------------------------------
  const LEGEND_ORDER = [3, 4, 1, 2, 0, 5];
  let curPanel = null; // { mode, cont }

  function treeOf(mode) { return mode === "dep" ? depTree : arrTree; }
  function selOf(mode) { return mode === "dep" ? depSel : arrSel; }
  function countriesOf(mode, cont) {
    const m = treeOf(mode)[cont];
    return m ? [...m.keys()].sort((a, b) => koName(a).localeCompare(koName(b), "ko")) : [];
  }

  function buildLegends() {
    buildLegend("dep", document.getElementById("dep-items"));
    buildLegend("arr", document.getElementById("arr-items"));
  }

  function buildLegend(mode, host) {
    if (!host) return;
    host.innerHTML = "";
    const sel = selOf(mode);
    for (const c of LEGEND_ORDER) {
      const cties = countriesOf(mode, c);
      if (!cties.length) continue;
      const item = document.createElement("div");
      item.className = "lg-item";
      if (curPanel && curPanel.mode === mode && curPanel.cont === c) item.classList.add("active");
      item.innerHTML = '<i style="background:' + CONT_FILL[c] + ";color:" + CONT_FILL[c] + '"></i><span class="lg-name">' + CONT_NAME[c] + "</span>";
      const selCount = cties.reduce((k, n) => k + (sel.has(n) ? 1 : 0), 0);
      if (selCount > 0 && selCount < cties.length) item.classList.add("partial");
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "lg-chk";
      chk.checked = selCount === cties.length;
      chk.indeterminate = selCount > 0 && selCount < cties.length;
      chk.title = "이 대륙 전체 선택/해제";
      chk.addEventListener("click", (e) => e.stopPropagation());
      chk.addEventListener("change", () => {
        if (chk.checked) cties.forEach((n) => sel.add(n)); else cties.forEach((n) => sel.delete(n));
        focusRoute = null; focusCountry = null; hideRoutePopup();
        applyFilter(); refreshUI();
      });
      item.appendChild(chk);
      item.addEventListener("click", () => openCountryPanel(mode, c));
      host.appendChild(item);
    }
  }

  function openCountryPanel(mode, c) {
    curPanel = { mode, cont: c };
    const panel = document.getElementById("countrypanel");
    if (!panel) return;
    document.getElementById("cp-title").textContent = (mode === "dep" ? "출발" : "도착") + " · " + CONT_NAME[c];
    const list = document.getElementById("cp-list");
    list.innerHTML = "";
    const sel = selOf(mode);
    const tree = treeOf(mode)[c];
    for (const name of countriesOf(mode, c)) {
      const row = document.createElement("div");
      row.className = "cp-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = sel.has(name);
      cb.addEventListener("change", () => {
        if (cb.checked) sel.add(name); else sel.delete(name);
        focusRoute = null; focusCountry = null; hideRoutePopup();
        applyFilter(); refreshLegendsOnly();
      });
      const sw = document.createElement("input");
      sw.type = "color"; sw.className = "cp-color";
      sw.value = rgbToHex(rgbOf(name, c));
      sw.title = "이 국가 색상 지정 (클릭하면 팔레트)";
      sw.addEventListener("input", () => { countryRGB[name] = hexToRgb(sw.value); });
      const nm = document.createElement("span");
      nm.className = "cp-cty"; nm.textContent = koName(name);
      nm.title = "클릭: 항공 흐름 분석 + 공항 목록";
      nm.addEventListener("click", () => { focusCountry = name; buildSummary(); showAirportWindow(name); showRouteList(name); });
      const go = document.createElement("button");
      go.className = "go-btn"; go.textContent = "⊕"; go.title = "이 국가로 이동";
      go.addEventListener("click", (e) => { e.stopPropagation(); const ce = countryCentroid(name); if (ce) flyTo(ce[0], ce[1], 2.6); });
      row.appendChild(cb); row.appendChild(sw); row.appendChild(nm); row.appendChild(go);
      list.appendChild(row);
    }
    panel.hidden = false;
  }

  // Separate window listing a country's airports (item: 공항 이름 별도 창).
  function showAirportWindow(name) {
    const win = document.getElementById("airportwin");
    if (!win) return;
    document.getElementById("aw-title").textContent = koName(name) + " 공항";
    const list = (countryAirports[name] || []).map((i) => airports[i])
      .sort((a, b) => (a.iata || "").localeCompare(b.iata || ""));
    const host = document.getElementById("aw-list");
    host.innerHTML = "";
    if (!list.length) { host.innerHTML = '<div class="aw-row">공항 정보 없음</div>'; }
    for (const a of list) {
      const row = document.createElement("div");
      row.className = "aw-row";
      row.innerHTML = "<b>" + (a.iata || "—") + "</b> <span>" + (KO_AIR[a.iata] || a.name) + "</span>";
      const go = document.createElement("button");
      go.className = "go-btn"; go.textContent = "⊕"; go.title = "이 공항으로 이동";
      go.addEventListener("click", () => flyTo(a.lon, a.lat, 6));
      row.appendChild(go);
      host.appendChild(row);
    }
    win.hidden = false;
  }

  // Right-side paginated route list for a clicked country (sorted by traffic).
  function showRouteList(country) {
    rlCountry = country;
    rlRoutes = routes.filter((r) => r.oCountry === country || r.dCountry === country)
      .sort((a, b) => b.w - a.w);
    rlPage = 0;
    renderRouteList();
    const rl = document.getElementById("routelist");
    if (rl) rl.hidden = false;
  }
  function renderRouteList() {
    const total = rlRoutes.length;
    const pages = Math.max(1, Math.ceil(total / RL_PER));
    rlPage = Math.max(0, Math.min(pages - 1, rlPage));
    document.getElementById("rl-title").textContent = koName(rlCountry) + " 노선 " + total + "개";
    const slice = rlRoutes.slice(rlPage * RL_PER, rlPage * RL_PER + RL_PER);
    document.getElementById("rl-body").innerHTML = slice.map((r) => {
      const o = r.oAir.iata || r.oAir.name, d = r.dAir.iata || r.dAir.name;
      return '<div class="rl-row"><span class="rl-rt">' + o + " → " + d + '</span><span class="rl-w">' + r.w.toLocaleString("ko-KR") + "</span></div>";
    }).join("") || '<div class="rl-row">노선 없음</div>';
    document.getElementById("rl-page").textContent = (rlPage + 1) + " / " + pages;
  }

  function refreshLegendsOnly() { buildLegends(); }
  function refreshUI() { buildLegends(); if (curPanel) openCountryPanel(curPanel.mode, curPanel.cont); }

  const cpCloseBtn = document.getElementById("cp-close");
  if (cpCloseBtn) cpCloseBtn.addEventListener("click", () => {
    document.getElementById("countrypanel").hidden = true;
    const aw = document.getElementById("airportwin"); if (aw) aw.hidden = true;
    const rl = document.getElementById("routelist"); if (rl) rl.hidden = true;
    curPanel = null; buildLegends();
  });
  const awCloseBtn = document.getElementById("aw-close");
  if (awCloseBtn) awCloseBtn.addEventListener("click", () => { document.getElementById("airportwin").hidden = true; });

  // Bottom-left: neon toggle + always-show-airports.
  const elNeon = document.getElementById("neon-toggle");
  if (elNeon) elNeon.addEventListener("click", () => {
    neonOn = !neonOn;
    elNeon.classList.toggle("off", !neonOn);
    elNeon.textContent = neonOn ? "네온효과: 켜짐" : "네온효과: 꺼짐";
  });
  const elAlwaysAir = document.getElementById("always-airports");
  if (elAlwaysAir) elAlwaysAir.addEventListener("change", () => {
    alwaysAirports = elAlwaysAir.checked;
    computeMarks();
  });

  // ---- route click → record-count popup ----------------------------------
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function treeHas(tree, cty) { for (const c in tree) if (tree[c].has(cty)) return true; return false; }
  function contInTree(tree, cty) { for (const c in tree) if (tree[c].has(cty)) return +c; return -1; }

  // Clicking a country on the globe toggles it into departure (or arrival) selection.
  function toggleCountrySelection(cty) {
    const inDep = treeHas(depTree, cty), inArr = treeHas(arrTree, cty);
    if (!inDep && !inArr) return false;
    const mode = inDep ? "dep" : "arr";
    const sel = mode === "dep" ? depSel : arrSel;
    if (sel.has(cty)) sel.delete(cty); else sel.add(cty);
    focusRoute = null; focusCountry = cty; hideRoutePopup();
    applyFilter();
    const c = contInTree(mode === "dep" ? depTree : arrTree, cty);
    if (c >= 0) openCountryPanel(mode, c);
    buildLegends();
    buildSummary(); showAirportWindow(cty); showRouteList(cty);
    return true;
  }

  function routeClick(x, y) {
    if (liveMode) return;
    const rot = projection.rotate();
    const center = [-rot[0], -rot[1]];
    const horizon = Math.PI / 2 - 0.02;
    let bestRi = null, bestD = 9;
    for (const ri of shown) {
      const pts = routes[ri].lineCoords;
      for (let i = 0; i < pts.length - 1; i++) {
        if (d3.geoDistance(pts[i], center) > horizon || d3.geoDistance(pts[i + 1], center) > horizon) continue;
        const pa = projection(pts[i]), pb = projection(pts[i + 1]);
        const d = segDist(x, y, pa[0], pa[1], pb[0], pb[1]);
        if (d < bestD) { bestD = d; bestRi = ri; }
      }
    }
    if (bestRi != null) {
      // Focus the clicked route: only that route, ≤5 planes.
      focusRoute = bestRi; focusCountry = null;
      maxPlanes = selectionCap();
      rebuildShown(); computeMarks(); buildSummary();
      if (daily && !liveMode) setPlaneCount(Math.round((daily.counts[dayIndex] / maxCount) * maxPlanes));
      showRoutePopup(0, 0, routes[bestRi]);
      return;
    }
    // No route line hit → did the user click a country?
    const ll = projection.invert([x, y]);
    const cty = ll ? countryOfLive(ll[0], ll[1]) : null;
    if (cty && toggleCountrySelection(cty)) return;
    if (focusRoute != null) { focusRoute = null; hideRoutePopup(); applyFilter(); }
    else hideRoutePopup();
  }

  function showRoutePopup(x, y, r) {
    const pop = document.getElementById("routepop");
    if (!pop) return;
    const o = (r.oAir.iata || r.oAir.name) + " · " + koName(r.oCountry);
    const d = (r.dAir.iata || r.dAir.name) + " · " + koName(r.dCountry);
    pop.innerHTML =
      '<div class="rp-route"><span>' + o + "</span> → <span>" + d + "</span></div>" +
      '<div class="rp-count">운항 기록 약 <b>' + r.w.toLocaleString("ko-KR") + "</b>건 <span>(항공사·노선 수 기준)</span></div>";
    pop.hidden = false; // position is fixed top-right via CSS
  }
  function hideRoutePopup() { const pop = document.getElementById("routepop"); if (pop) pop.hidden = true; }

  // ---- default selection from visitor geo --------------------------------
  let geoName = null, geoTried = false, routesReady = false, defaultApplied = false;
  function applyDefault() {
    if (defaultApplied || !routesReady || !geoTried) return;
    defaultApplied = true;
    // Preselect the visitor country as DEPARTURE (per chosen default).
    if (geoName) {
      let found = false;
      for (const c in depTree) if (depTree[c].has(geoName)) { found = true; break; }
      if (found) {
        depSel.add(geoName);
        applyFilter();
        // Open its departure panel for context.
        for (const c of LEGEND_ORDER) if (depTree[c] && depTree[c].has(geoName)) { openCountryPanel("dep", c); break; }
      }
    }
    buildLegends();
  }

  window.addEventListener("resize", resize);

  // ---- boot ---------------------------------------------------------------

  resize();
  scale = baseScale;

  // Start the render loop immediately so the ocean, stars and atmosphere
  // appear right away; land pops in once its data finishes loading.
  lastSpin = performance.now();
  requestAnimationFrame(frame);

  fetch("countries-110m.json?v=3")
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

  fetch("routes.json?v=6")
    .then((r) => r.json())
    .then((d) => {
      buildRoutes(d);
      buildLegends();
      if (daily) setDay(dayIndex);
      routesReady = true;
      applyDefault();
    })
    .catch((err) => { console.error("Failed to load routes:", err); });

  fetch("daily.json?v=4")
    .then((r) => r.json())
    .then((d) => {
      daily = d;
      maxCount = d.counts.reduce((m, c) => (c > m ? c : m), 1);
      elSlider.max = d.counts.length - 1;
      if (elDatePick) { elDatePick.min = fmtISO(0); elDatePick.max = fmtISO(d.counts.length - 1); }
      setDay(d.counts.length - 1); // start at the most recent day
    })
    .catch((err) => { console.error("Failed to load daily data:", err); });

  // Visitor country → default departure selection (Vercel geo header).
  fetch("/api/geo")
    .then((r) => r.json())
    .then((g) => { geoName = g && g.name; })
    .catch(() => {})
    .finally(() => { geoTried = true; applyDefault(); });
})();
