// Glass Control Room: the far side of the glass.
// Sky, clouds, town, rain, snow, fog, lightning and the beads on the window, all driven by
// state.weather and the sun (today's sunrise and sunset against state.t). Textures are generated
// once per change of weather or light; everything that moves is a transform on a pre-rendered
// layer, driven by one Kiln.loop. Nothing here blurs per frame.
//
// The frosted panes do not use backdrop-filter. #frost holds ONE quarter-scale canvas, composed
// from small pre-blurred copies of the scene (1/8-scale sky and town, 1/12-scale clouds, 1/4-scale
// beads) at most twice a second, and clipped to the pane shapes. It used to be six full-screen
// layers moved by the same transforms as the sharp ones; small canvases (under WebKit's
// accelerated-canvas area) composite as painted layers at css size x 2, so those six cost about
// 100 MB of graphics memory. Under 18 px of blur, a frost that trails the sharp drift by half a
// second cannot be seen.
//
// What moves, and how often (README 8a: frames, not data, are the cost):
// - rain, snow, beads and lightning run on one Kiln.loop (30 fps rain, 20 snow, 10 while the
//   glass dries), and only while they exist;
// - cloud and fog drift step at the slowest rate that keeps each step under STEP css px (a third
//   of a cloud texel), at most 12 fps; when the feed updates that often, they step on its
//   updates and no loop runs at all;
// - layers that show nothing (the sun at night, stars under cloud, lightning between flashes)
//   are display: none, so they hold no texture.
//
// Dev: ?weather=clear|partly|cloudy|fog|drizzle|rain|snow|storm, ?day=1|0, ?alt=-1..1 (sun).
(function () {
  "use strict";
  const W = 1512, H = 982, HORIZON = 868, TOWN_TOP = 560;
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const Q = new URLSearchParams(location.search);
  // development: ?bare takes the window column's type and panes away, for a diff of the sky
  if (Q.has("bare")) document.documentElement.classList.add("bare");
  const CFG = window.GLASS_CONFIG || {};
  const PRECIP = CFG.precipitation !== false;
  const world = document.getElementById("world");
  // The host's appearance menu (Kiln.appearance): "light" pins the day glass, "dark" the night
  // glass; "auto" leaves the sun (and config.js) in charge; a dev ?theme= wins. It is the glass
  // only. The sky, sun, stars, town and weather are always the real ones (README, Preferences:
  // "Weather and sky are never fabricated"); only the dev ?day= / ?alt= move the sun.
  const forced = () => (Q.has("theme") ? null
    : Kiln.appearance === "light" ? "day" : Kiln.appearance === "dark" ? "night" : null);

  /* ---------------- small tools ---------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sstep = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const rgba = (c, a) => `rgba(${c.map((v) => Math.round(v)).join(",")},${a == null ? 1 : +a.toFixed(3)})`;
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  function el(tag, cls, parent, style) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (style) Object.assign(e.style, style);
    (parent || world).appendChild(e);
    return e;
  }
  // A canvas whose bitmap is `bw x bh` shown at css size `cw x ch`: big layers stay cheap textures.
  // Keep on-screen bitmaps over 257 x 256 px in area: WebKit accelerates those and composites the
  // bitmap itself; a smaller one is painted into a layer at css size x 2.
  function cvs(parent, bw, bh, cw, ch, x, y, cls) {
    const c = el("canvas", "layer " + (cls || ""), parent, { width: cw + "px", height: ch + "px", left: x + "px", top: y + "px" });
    c.width = Math.max(1, Math.round(bw));
    c.height = Math.max(1, Math.round(bh));
    return c;
  }
  // An offscreen canvas: a source for the frost, never in the page.
  function off(bw, bh) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bw));
    c.height = Math.max(1, Math.round(bh));
    return c;
  }
  // Style writes only when the value changes (a same-value write still restyles in WebKit).
  function put(e, k, v) { const key = "_s_" + k; if (e[key] !== v) { e[key] = v; e.style[k] = v; } }
  // Interpolate a table of [alt, colours...] rows at the sun's altitude.
  function ramp(table, alt) {
    if (alt <= table[0][0]) return table[0].slice(1).map(hex);
    for (let i = 1; i < table.length; i++) {
      if (alt <= table[i][0]) {
        const k = sstep(table[i - 1][0], table[i][0], alt);
        return table[i].slice(1).map((c, j) => mix(hex(table[i - 1][j + 1]), hex(c), k));
      }
    }
    return table[table.length - 1].slice(1).map(hex);
  }

  /* ---------------- the weather the page shows (real, or the dev override) ---------------- */
  const DEV = {
    clear: { text: "Clear", cloud: 3 },
    partly: { text: "Partly cloudy", cloud: 45 },
    cloudy: { text: "Overcast", cloud: 97 },
    fog: { text: "Fog", cloud: 100, humidity: 99 },
    drizzle: { text: "Light drizzle", cloud: 95, precip_mm: 0.1, rain_mm: 0.1 },
    rain: { text: "Rain", cloud: 100, precip_mm: 2.4, rain_mm: 2.4 },
    snow: { text: "Snow", cloud: 100, precip_mm: 0.4, snow_cm: 0.6 },
    storm: { text: "Thunderstorm", cloud: 100, precip_mm: 5.5, rain_mm: 5.5, wind_kmh: 34 },
  };
  function weatherOf(s) {
    const real = s && s.weather;
    const k = Q.get("weather");
    if (!k || !DEV[k]) return real || null;
    const base = real || { place: "", temp_c: null, feels_c: null, humidity: null, wind_kmh: 0, wind_dir: 0,
      is_day: false, sunrise: null, sunset: null, observed_at: s.t };
    const o = Object.assign({}, base, { kind: k, precip_mm: 0, rain_mm: 0, snow_cm: 0 }, DEV[k]);
    if (Q.has("day")) o.is_day = Q.get("day") !== "0";
    return o;
  }

  // The sun's height as a proxy from -1 (deep night) to 1 (noon): a sine between today's sunrise
  // and sunset, and below the horizon the distance to the nearer of them (dark 90 min after).
  function sunOf(s, w) {
    const out = { alt: -1, frac: null };
    if (Q.has("alt")) { out.alt = clamp(+Q.get("alt"), -1, 1); out.frac = out.alt > 0 ? 0.62 : null; return out; }
    if (Q.has("day")) { out.alt = Q.get("day") === "0" ? -1 : 0.55; out.frac = out.alt > 0 ? 0.62 : null; return out; }
    if (!w || !w.sunrise || !w.sunset) { out.alt = w && w.is_day ? 0.5 : -1; return out; }
    const t = s.t, day = 86400;
    let sr = w.sunrise, ss = w.sunset;
    while (t - ss > day / 2) { sr += day; ss += day; }
    while (sr - t > day / 2) { sr -= day; ss -= day; }
    if (t >= sr && t <= ss) { out.frac = (t - sr) / (ss - sr); out.alt = Math.sin(Math.PI * out.frac); return out; }
    const d = Math.min(Math.abs(t - sr), Math.abs(t - ss), Math.abs(t - sr - day), Math.abs(t - ss + day));
    out.alt = -Math.min(1, d / 5400);
    out.frac = Math.abs(t - sr) < Math.abs(t - ss) ? -d / (ss - sr) : 1 + d / (ss - sr);
    return out;
  }

  /* ---------------- palettes by the sun's height: [alt, clear sky x5, overcast sky x5] ----------------
     Stops at 0, 45, 72, 86 and 90 % of the height (the horizon sits at 88 %). */
  const SKY = [
    [-1, "#04071a", "#0a1130", "#161d3c", "#2b2740", "#3d2e3c", "#090e1c", "#141a2b", "#272435", "#553a36", "#734a39"],
    [-0.35, "#0b1236", "#1f2a5c", "#3e3f72", "#6b4c6c", "#8a5a5e", "#10141f", "#1e2230", "#34303c", "#5a4240", "#6e4c42"],
    [-0.08, "#1c2f66", "#3f5694", "#8a7aa6", "#e09a7c", "#f4b27a", "#2a3040", "#464a5a", "#6c6670", "#8e7468", "#9c7c6c"],
    [0.08, "#3c6eb0", "#6d97c9", "#b9c0cc", "#f0c49a", "#f8d3a6", "#5c6573", "#7a8290", "#9a9da3", "#b4aca4", "#bdb2a6"],
    [0.35, "#2c6fbf", "#4f8fd3", "#8cbbe5", "#c3dcef", "#d8e6ef", "#69788a", "#8591a0", "#a2abb6", "#b6bdc5", "#bfc5cb"],
  ];
  // cloud body (shadowed), cloud lit underside (town at night, the low sun at dusk)
  const CLOUD = [
    [-1, "#2a3141", "#8e6553"],
    [-0.35, "#2d3047", "#6c5266"],
    [-0.08, "#4f4f6a", "#e0927a"],
    [0.08, "#8a8f9c", "#f4d0a8"],
    [0.35, "#a6aeb9", "#f3f5f8"],
  ];
  const FOG = { night: hex("#3a3a46"), day: hex("#c9cdd2") };

  /* ---------------- tileable value noise for the cloud decks ---------------- */
  const LAT = 256, lattice = (() => { const r = rng(91), g = new Float32Array(LAT * LAT); for (let i = 0; i < g.length; i++) g[i] = r(); return g; })();
  function vnoise(x, y, px) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % px) + px) % px, x1 = (x0 + 1) % px, y0 = yi & 255, y1 = (yi + 1) & 255;
    const a = lattice[y0 * LAT + x0], b = lattice[y0 * LAT + x1], c = lattice[y1 * LAT + x0], d = lattice[y1 * LAT + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, px, oct, seedY) {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) { s += amp * vnoise(x * f, y * f + seedY + o * 37, px * f); norm += amp; amp *= 0.5; f *= 2; }
    return s / norm;
  }

  /* ---------------- layers ---------------- */
  const TILE = 504, SCALE = 3, TW = TILE * SCALE;          // cloud tile: 504 px bitmap, 1512 css
  const DECKS = [                                          // top, css height, lattice cells, octaves, speed, seed
    { id: "a", top: 0, ch: 660, cells: 5, cy: 2.2, oct: 5, speed: 1, seed: 11 },
    { id: "b", top: 330, ch: 560, cells: 7, cy: 2.6, oct: 4, speed: 1.4, seed: 4 },
    { id: "c", top: -20, ch: 420, cells: 4, cy: 1.6, oct: 3, speed: 0.7, seed: 23 },
  ];
  const L = {};            // live elements
  let frostEl, built = false;

  function build() {
    L.sky = el("div", "", world, { position: "absolute", inset: "0" });
    L.sky.id = "sky";
    // Stars and town are painted into the root layer, not composited: a vector <svg> (crisp at
    // 2x for nothing) and an <img> of the town's 2x drawing. As canvases they were composited
    // layers under the room, and everything over them composited too (README 8a.5).
    L.stars = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    L.stars.setAttribute("class", "layer");
    L.stars.setAttribute("width", W); L.stars.setAttribute("height", 700);
    world.appendChild(L.stars);
    // the sun is a soft glow: a 1x texture is as sharp as it ever looks. It moves a pixel a
    // minute, so it is an <img> placed by a 2D transform (painted, not a layer); the canvas is
    // only its source, and the frost's.
    L.sun = off(640, 640);
    L.sunImg = el("img", "layer", world, { width: "640px", height: "640px", display: "none" });
    L.sunImg.alt = "";
    for (const d of DECKS) { d.el = cvs(world, TILE * 2, d.ch / SCALE, TW * 2, d.ch, 0, d.top, "mover"); d.x = 0; }
    // lightning inside the cloud: soft too, so half size, and shown only while it flashes
    L.bolt = cvs(world, 550, 380, 1100, 760, 0, 0, "mover");
    Object.assign(L.bolt.style, { display: "none", opacity: 0 });
    paintBolt();
    L.town = el("img", "layer", world, { width: W + "px", height: H - TOWN_TOP + "px", left: "0px", top: TOWN_TOP + "px" });
    L.town.alt = "";
    L.fog = cvs(world, TILE * 2, 90, TW * 2, 360, 0, 600, "mover");
    L.sheets = [0, 1, 2].map(() => null);
    L.beadViews = [];

    frostEl = el("div", "", world);
    frostEl.id = "frost";
    L.frost = cvs(frostEl, W / 4, H / 4, W, H, 0, 0);
    // While nothing behind the glass moves (no drift, rain, snow, beads or lightning) the frost is
    // shown as a still <img> of the same drawing: an accelerated canvas is always a composited
    // layer, and the room over it then has to be one too (measured: 103 -> see notes.md).
    L.frostImg = el("img", "layer", frostEl, { width: W + "px", height: H + "px", left: "0px", top: "0px", display: "none" });
    L.frostImg.alt = "";
    L.fbase = off(W / 8, H / 8);
    for (const d of DECKS) d.fel = off(TILE / 2, d.ch / SCALE / 4);
    L.ffog = off(TILE / 2, 24);
    L.fbeads = off(W / 4, H / 4);
    built = true;
  }
  function paintBolt() {
    const x = L.bolt.getContext("2d"), g = x.createRadialGradient(0, 0, 0, 0, 0, 190);
    // the old div's radial-gradient(closest-side, ...): an ellipse filling the box
    g.addColorStop(0, "rgba(225,232,255,.55)"); g.addColorStop(0.55, "rgba(190,205,255,.18)"); g.addColorStop(1, "rgba(190,205,255,0)");
    x.setTransform(275 / 190, 0, 0, 1, 275, 190);
    x.fillStyle = g; x.fillRect(-190, -190, 380, 380);
  }

  /* ---------------- the frost, composed ----------------
     Base, sun, cloud decks, lightning, fog and beads, in the order the old layers stacked.
     `due` marks a change; compose() runs at most twice a second unless `force` (a repaint, a
     flash frame, new frost beads). */
  const fr = { due: true, force: true, last: -1e9, flash: 0, ink: false };
  const sunAt = { vis: 0, x: 0, y: 0 }, boltAt = { x: 0, y: 0 };
  let cloudsShown = false, fogShown = false, fogX = 0;
  function compose() {
    const f = L.frost.getContext("2d"), qx = L.frost.width / W, qy = L.frost.height / H;
    f.globalAlpha = 1;
    f.drawImage(L.fbase, 0, 0, L.frost.width, L.frost.height);       // opaque: no clear needed
    if (sunAt.vis > 0) { f.globalAlpha = sunAt.vis; f.drawImage(L.sun, sunAt.x * qx, sunAt.y * qy, 640 * qx, 640 * qy); f.globalAlpha = 1; }
    if (cloudsShown) for (const d of DECKS) f.drawImage(d.fel, d.x * qx, d.top * qy, TW * 2 * qx, d.ch * qy);
    if (fr.flash > 0) { f.globalAlpha = fr.flash; f.drawImage(L.bolt, boltAt.x * qx, boltAt.y * qy, 1100 * qx, 760 * qy); f.globalAlpha = 1; }
    if (fogShown) f.drawImage(L.ffog, fogX * qx, 600 * qy, TW * 2 * qx, 360 * qy);
    if (fr.ink) f.drawImage(L.fbeads, 0, 0, L.frost.width, L.frost.height);
    stillFrost();
  }
  // Publish a still frame when the scene is still; show the live canvas the moment it is not.
  // A shown <img> is never handed a new src: WebKit leaves it empty for a frame or more while
  // the new bitmap decodes (load fires before that). The picture is decoded in a new <img> off
  // the page, which then takes the shown one's place in one task, with its class, inline style
  // and put() memo copied at that moment; the old blob URL goes after. A newer picture for the
  // same layer wins over an older one still decoding.
  const shownURL = {}, imgGen = {};
  function swapImg(key, url, onShown) {
    const gen = (imgGen[key] = (imgGen[key] || 0) + 1), n = new Image();
    n.src = url;
    const done = () => {
      if (gen !== imgGen[key] || !n.naturalWidth) { URL.revokeObjectURL(url); return; }
      const cur = L[key], old = shownURL[key];
      n.className = cur.className; n.style.cssText = cur.style.cssText; n.alt = "";
      for (const k of Object.keys(cur)) if (k.startsWith("_s_")) n[k] = cur[k];
      cur.replaceWith(n); L[key] = n; shownURL[key] = url;
      if (old) URL.revokeObjectURL(old);
      if (onShown) onShown();
    };
    n.decode().then(done, done);
  }
  function toImg(cv, key, onShown) {
    cv.toBlob((b) => { if (b) swapImg(key, URL.createObjectURL(b), onShown); });
  }
  let frostGen = 0;
  function stillFrost() {
    const sc = S, still = !!sc && !cloudsShown && !fogShown && !L.fall && !fr.flash && !fr.ink && !sc.wet && !sc.snow && !sc.storm;
    const gen = ++frostGen;
    // .scene-live makes the room one layer over the moving scene (index.html, Layers)
    const root = document.documentElement;
    if (!still) { put(L.frost, "display", ""); put(L.frostImg, "display", "none"); if (!root.classList.contains("scene-live")) root.classList.add("scene-live"); return; }
    // the canvas stays up until its still copy has loaded, so the swap never shows a gap
    toImg(L.frost, "frostImg", () => {
      if (gen !== frostGen) return;
      put(L.frostImg, "display", ""); put(L.frost, "display", "none");
      if (root.classList.contains("scene-live")) root.classList.remove("scene-live");
    });
  }
  function frostMaybe() {
    if (!fr.due) return;
    const t = performance.now() / 1000;
    if (!fr.force && t - fr.last < 0.5) return;
    fr.last = t; fr.due = fr.force = false;
    compose();
  }

  /* ---------------- the scene for one weather and light ---------------- */
  let S = null;            // current scene description
  let alphaCache = {};     // cloud alpha fields by cover bucket

  function describe(s) {
    const w = weatherOf(s);
    const sun = sunOf(s, w);
    const kind = w ? w.kind : "clear";
    const cover = w ? clamp((w.cloud == null ? 50 : w.cloud) / 100, 0, 1) : 0.5;
    const dir = w && w.wind_dir != null ? w.wind_dir : 270;
    const east = -Math.sin((dir * Math.PI) / 180);          // wind_dir is where it blows FROM
    const kmh = w && w.wind_kmh != null ? w.wind_kmh : 0;
    const wet = ["drizzle", "rain", "storm"].includes(kind);
    const mm = w ? Math.max(w.precip_mm || 0, w.rain_mm || 0) : 0;
    const intensity = kind === "drizzle" ? clamp(0.7 + mm * 3, 0.7, 1.4)
      : kind === "rain" ? clamp(0.6 + mm / 3, 0.6, 1.6)
      : kind === "storm" ? clamp(1 + mm / 8, 1, 1.8)
      : kind === "snow" ? clamp(0.6 + ((w.snow_cm || 0) + mm) / 1.5, 0.6, 1.6) : 0;
    const isDay = Q.has("day") || Q.has("alt") ? sun.alt > 0 : w ? !!w.is_day : sun.alt > 0;
    return { w, kind, cover: kind === "fog" ? 1 : cover, east, kmh, wet: wet && PRECIP, snow: kind === "snow" && PRECIP,
      fog: kind === "fog", storm: kind === "storm", intensity, alt: sun.alt, frac: sun.frac, isDay,
      humidity: w && w.humidity != null ? w.humidity : 70 };
  }

  function skyStops(sc) {
    const row = ramp(SKY, sc.alt);
    const clear = row.slice(0, 5), over = row.slice(5);
    let stops = clear.map((c, i) => mix(c, over[i], sstep(0.15, 0.95, sc.cover)));
    if (sc.fog) { const f = sc.alt > 0 ? FOG.day : FOG.night; stops = stops.map((c, i) => mix(c, f, 0.35 + i * 0.1)); }
    return stops;
  }

  function paintSky(sc) {
    const st = skyStops(sc), pos = [0, 45, 72, 86, 90];
    L.sky.style.background = `linear-gradient(180deg, ${st.map((c, i) => rgba(c) + " " + pos[i] + "%").join(", ")})`;
    // the frosted copy: 1/8 scale, so it is already as soft as a 16 px blur once scaled back up
    const f = L.fbase.getContext("2d"), fw = L.fbase.width, fh = L.fbase.height;
    const g = f.createLinearGradient(0, 0, 0, fh);
    st.forEach((c, i) => g.addColorStop(pos[i] / 100, rgba(c)));
    f.filter = "none";
    f.fillStyle = g;
    f.fillRect(0, 0, fw, fh);
    f.imageSmoothingQuality = "high";
    if (L.townC) f.drawImage(L.townC, 0, (TOWN_TOP / H) * fh, fw, ((H - TOWN_TOP) / H) * fh);
    if ("filter" in f) { f.filter = "blur(1px)"; f.drawImage(L.fbase, 0, 0); f.filter = "none"; }
    // day glass glows with the light it scatters; it also keeps dark ink legible over the tree
    // line (APCA measured in notes.md). A property of the glass, not of the sky: day glass under
    // a real night sky glows too, and night glass under a real day sky does not.
    if (glassOf(sc) === "day") { f.fillStyle = "rgba(255,255,255,0.45)"; f.fillRect(0, 0, fw, fh); }
  }

  function paintStars(sc) {
    const show = (1 - sstep(0.35, 0.85, sc.cover)) * (1 - sstep(-0.4, -0.1, sc.alt)) * (sc.fog ? 0 : 1);
    put(L.stars, "opacity", show.toFixed(2));
    put(L.stars, "display", show > 0.005 ? "" : "none");
    if (L.stars._done || show <= 0) return;
    // Vector, so a 0.4 px star is a real 0.8 device px point at 2x, not a smeared 1x texel. Most
    // stars are faint and white; some run warm or blue, as real ones do; a few bright ones carry
    // a small glow. They thin toward the horizon, where the town's haze swallows them.
    const r = rng(5);
    let g = `<defs><radialGradient id="starGlow"><stop offset="0" stop-color="#eef2ff" stop-opacity="0.55"/><stop offset="1" stop-color="#eef2ff" stop-opacity="0"/></radialGradient></defs>`;
    for (let i = 0; i < 640; i++) {
      const roll = r(), x = r() * W, y = Math.pow(r(), 1.25) * 700;
      const bright = roll < 0.02, mid = roll < 0.1;
      const rad = bright ? 1.3 + r() * 0.5 : mid ? 0.8 + r() * 0.4 : 0.35 + r() * 0.4;
      const tint = r(), col = tint < 0.14 ? "#ffe4c4" : tint < 0.24 ? "#cddcff" : "#eef1ff";
      const a = (bright ? 0.95 : mid ? 0.6 + r() * 0.3 : 0.3 + r() * 0.45) * (1 - y / 820);
      // fill-opacity, not opacity: the same pixels for a lone fill, without a transparency layer
      // per star each time the root repaints over them
      if (bright) g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(rad * 3.4).toFixed(1)}" fill="url(#starGlow)" fill-opacity="${(a * 0.7).toFixed(2)}"/>`;
      g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(2)}" fill="${col}" fill-opacity="${a.toFixed(2)}"/>`;
    }
    L.stars.innerHTML = g;
    L.stars._done = true;
  }
  // The town's drawing goes to its <img> as a PNG, once per change of light; the scratch canvas
  // is released after, so no 10 MB bitmap is kept for a picture already on screen.
  function publishTown() {
    const cv = L.townC;
    if (!cv) return;
    L.townC = null;
    cv.toBlob((b) => {
      cv.width = cv.height = 0;
      if (b) swapImg("town", URL.createObjectURL(b));   // decoded off the page, then swapped in
    });
  }

  let sunKey = "";
  function paintSun(sc) {
    const up = sc.frac != null && sc.alt > -0.2;
    const vis = up ? (1 - sstep(0.55, 0.98, sc.cover) * 0.85) * sstep(-0.2, 0.02, sc.alt) : 0;
    const op = vis.toFixed(2);
    put(L.sunImg, "display", +op > 0 ? "" : "none");
    put(L.sunImg, "opacity", op);
    if (+op !== sunAt.vis) { sunAt.vis = +op; fr.due = true; }
    if (!(+op > 0)) return;
    // the old div's radial-gradient(circle, ...): farthest-corner, so a radius of 320 * sqrt 2
    const warm = 1 - sstep(0, 0.3, sc.alt), key = warm.toFixed(3);
    if (key !== sunKey) {
      sunKey = key;
      const core = mix(hex("#fff7e6"), hex("#ffb26b"), warm), halo = mix(hex("#fff1c9"), hex("#ff8a4a"), warm);
      sunAt.core = core; sunAt.halo = halo;              // for ink()
      const x = L.sun.getContext("2d"), g = x.createRadialGradient(320, 320, 0, 320, 320, 320 * Math.SQRT2);
      g.addColorStop(0, rgba(core, 0.95)); g.addColorStop(0.032, rgba(core, 0.9)); g.addColorStop(0.09, rgba(halo, 0.35));
      g.addColorStop(0.3, rgba(halo, 0.1)); g.addColorStop(0.62, rgba(halo, 0));
      x.clearRect(0, 0, 640, 640); x.fillStyle = g; x.fillRect(0, 0, 640, 640);
      toImg(L.sun, "sunImg");
      fr.due = true;
    }
    if (up) {
      const f = clamp(sc.frac, -0.08, 1.08);
      const x = 120 + f * (W - 240) - 320, y = HORIZON - 30 - Math.sin(Math.PI * clamp(f, 0, 1)) * 640 - 320;
      put(L.sunImg, "transform", `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`);
      if (Math.abs(x - sunAt.x) + Math.abs(y - sunAt.y) > 1) { sunAt.x = x; sunAt.y = y; fr.due = true; }
    }
  }

  // Cloud alpha fields depend only on cover; colour on the light. Both are cached.
  function cloudAlpha(d, cover) {
    const key = d.id + Math.round(cover * 20);
    if (alphaCache[key]) return alphaCache[key];
    const bw = TILE, bh = Math.round(d.ch / SCALE), a = new Float32Array(bw * bh), n = new Float32Array(bw * bh);
    const th = 0.74 - cover * 0.6;
    for (let j = 0; j < bh; j++) {
      const fy = j / bh;
      for (let i = 0; i < bw; i++) {
        const v = fbm((i / bw) * d.cells, fy * d.cy, d.cells, d.oct, d.seed);
        n[j * bw + i] = v;
        a[j * bw + i] = sstep(th, th + 0.28, v);
      }
    }
    return (alphaCache[key] = { a, n, bw, bh });
  }

  function paintClouds(sc) {
    const [body, lit] = ramp(CLOUD, sc.alt);
    const show = sc.cover > 0.06;
    cloudsShown = show;
    for (const d of DECKS) {
      put(d.el, "display", show ? "" : "none");
      d.band = null;
      if (!show) continue;
      const { a, n, bw, bh } = cloudAlpha(d, sc.cover);
      const ctx = d.el.getContext("2d"), img = ctx.createImageData(bw, bh), px = img.data;
      const fogK = sc.fog ? 0.55 : 1;
      for (let j = 0; j < bh; j++) {
        const fy = j / bh;
        let la, lk;
        if (d.id === "a") { la = 0.9 * (1 - sstep(0.78, 1, fy)); lk = 0.12 + fy * 0.45; }
        else if (d.id === "b") { la = 0.85 * sstep(0, 0.35, fy) * (1 - sstep(0.8, 1, fy)); lk = 0.35 + fy * 0.6; }
        else { la = 0.8 * (1 - sstep(0.45, 1, fy)); lk = 0.02; }
        const dark = mix(body, [6, 9, 18], 0.45);
        for (let i = 0; i < bw; i++) {
          const k = j * bw + i, v = n[k], o = k * 4;
          if (d.id === "c") { px[o] = dark[0]; px[o + 1] = dark[1]; px[o + 2] = dark[2]; }
          else {
            const m = clamp(lk + (v - 0.5) * 0.5, 0, 1);
            px[o] = body[0] + (lit[0] - body[0]) * m; px[o + 1] = body[1] + (lit[1] - body[1]) * m; px[o + 2] = body[2] + (lit[2] - body[2]) * m;
          }
          px[o + 3] = 255 * a[k] * la * fogK * (0.55 + 0.45 * v);
        }
      }
      ctx.putImageData(img, 0, 0);
      ctx.putImageData(img, bw, 0);                       // two tiles side by side: the drift wraps
      // the rows behind the window's figures, kept for ink(): it reads the clouds' own pixels
      const r0 = clamp(Math.floor((INK_Y0 - d.top) / SCALE), 0, bh), r1 = clamp(Math.ceil((INK_Y1 - d.top) / SCALE), 0, bh);
      if (r1 > r0) d.band = { r0, r1, bw, px: px.slice(r0 * bw * 4, r1 * bw * 4) };
      const f = d.fel.getContext("2d");
      f.clearRect(0, 0, d.fel.width, d.fel.height);
      f.imageSmoothingQuality = "high";
      if ("filter" in f) f.filter = "blur(1.5px)";
      f.drawImage(d.el, 0, 0, d.fel.width, d.fel.height);
      f.filter = "none";
    }
  }

  // The town, ridge and trees (the concept's skyline, same seed), lit by the street lamps at
  // night and hazed by the day. Drawn once per light change into one 2x bitmap.
  function paintTown(sc) {
    // drawn on a scratch canvas: paintSky takes its frosted copy from it, then publishTown()
    // hands it to the <img> and lets it go
    L.townC = off(W * DPR, (H - TOWN_TOP) * DPR);
    const c = L.townC.getContext("2d");
    c.setTransform(DPR, 0, 0, DPR, 0, -TOWN_TOP * DPR);
    c.clearRect(0, TOWN_TOP, W, H - TOWN_TOP);
    const r = rng(7);
    const day = sstep(-0.25, 0.2, sc.alt), lamps = 1 - sstep(-0.12, 0.08, sc.alt);
    const low = skyStops(sc)[4];
    // the town's glow on the cloud base and the haze
    if (day < 1) {
      const g = c.createRadialGradient(760, HORIZON + 40, 0, 760, HORIZON + 40, 1000);
      g.addColorStop(0, `rgba(236,154,90,${(0.75 * (1 - day) * (sc.fog ? 0.6 : 1)).toFixed(2)})`);
      g.addColorStop(1, "rgba(224,145,85,0)");
      c.save(); c.translate(760, HORIZON + 40); c.scale(1, 0.3); c.translate(-760, -(HORIZON + 40));
      c.fillStyle = g; c.fillRect(-300, HORIZON + 40 - 1000, 2200, 2000); c.restore();
    }
    // ridge: farthest, lightest, softest
    const ridge = mix(mix(hex("#3b2b30"), low, 0.25), mix(hex("#7d8794"), low, 0.45), day);
    c.beginPath(); c.moveTo(0, HORIZON - 30);
    for (let x = 0; x <= W; x += 40) c.lineTo(x, HORIZON - 34 - Math.sin(x / 190) * 9 - Math.sin(x / 71) * 4);
    c.lineTo(W, HORIZON); c.lineTo(0, HORIZON); c.closePath();
    if ("filter" in c) c.filter = "blur(1.6px)";
    c.fillStyle = rgba(ridge, 0.85); c.fill();
    c.filter = "none";
    // buildings: a cupola, a spire, a water tower, lit windows
    const bld = mix(hex("#15121b"), mix(hex("#56606d"), low, 0.3), day);
    const wins = [];
    c.fillStyle = rgba(bld);
    const roofs = [[120, 46, 70], [214, 30, 52], [520, 58, 44], [610, 40, 90], [880, 36, 66], [990, 52, 48], [1210, 44, 80], [1330, 28, 60]];
    for (const [x, hh, w] of roofs) {
      c.beginPath(); c.moveTo(x, HORIZON); c.lineTo(x, HORIZON - hh); c.lineTo(x + w / 2, HORIZON - hh - hh * 0.35);
      c.lineTo(x + w, HORIZON - hh); c.lineTo(x + w, HORIZON); c.fill();
      for (let i = 0; i < 3; i++) if (r() > 0.45) wins.push([x + 8 + i * (w / 3.2), HORIZON - hh + 10 + r() * 10, 5, 7, 0.5 + r() * 0.4]);
    }
    c.fillRect(700, HORIZON - 74, 64, 74); c.fillRect(712, HORIZON - 96, 40, 22);
    c.beginPath(); c.moveTo(716, HORIZON - 96); c.quadraticCurveTo(732, HORIZON - 126, 748, HORIZON - 96); c.fill();
    c.fillRect(731, HORIZON - 132, 2, 14);
    c.fillRect(846, HORIZON - 64, 30, 64);
    c.beginPath(); c.moveTo(846, HORIZON - 64); c.lineTo(861, HORIZON - 146); c.lineTo(876, HORIZON - 64); c.fill();
    c.fillRect(380, HORIZON - 62, 6, 62); c.fillRect(406, HORIZON - 62, 6, 62);
    c.beginPath(); c.moveTo(368, HORIZON - 62); c.lineTo(424, HORIZON - 62); c.lineTo(424, HORIZON - 88);
    c.quadraticCurveTo(396, HORIZON - 104, 368, HORIZON - 88); c.fill();
    if (lamps > 0) {
      c.fillStyle = `rgba(255,216,160,${(0.8 * lamps).toFixed(2)})`;
      c.beginPath(); c.roundRect ? c.roundRect(722, HORIZON - 70, 20, 14, 7) : c.rect(722, HORIZON - 70, 20, 14); c.fill();
      for (const [x, y, w, hh, o] of wins) { c.fillStyle = `rgba(255,199,122,${(o * lamps).toFixed(2)})`; c.fillRect(x, y, w, hh); }
    }
    // the tree line: nearest, darkest, sharpest
    c.fillStyle = rgba(mix(hex("#06070c"), mix(hex("#1f262d"), low, 0.12), day));
    for (let x = -20; x < W + 30; x += 9 + r() * 12) {
      const tall = r() < 0.18 ? 40 + r() * 34 : 10 + r() * 26, rad = 10 + r() * 16;
      c.beginPath(); c.arc(x, HORIZON + 6 - tall, rad, 0, 7); c.fill();
      c.fillRect(x - 1.5, HORIZON - tall, 3, tall);
    }
    c.fillRect(0, HORIZON, W, H - HORIZON);
    // street lamps, and on wet nights their light smeared down the road
    for (let x = 60; x < W; x += 170 + r() * 60) {
      if (lamps <= 0) continue;
      if (sc.wet) {
        const g = c.createLinearGradient(0, HORIZON + 18, 0, H);
        g.addColorStop(0, `rgba(255,196,122,${(0.5 * lamps).toFixed(2)})`); g.addColorStop(1, "rgba(255,196,122,0)");
        if ("filter" in c) c.filter = "blur(2.5px)";
        c.fillStyle = g; c.fillRect(x - 3, HORIZON + 18, 6, H - HORIZON - 18);
        c.filter = "none";
      }
      const g = c.createRadialGradient(x, HORIZON + 14, 0, x, HORIZON + 14, 26);
      g.addColorStop(0, `rgba(255,213,154,${(0.95 * lamps).toFixed(2)})`);
      g.addColorStop(0.25, `rgba(255,180,92,${(0.35 * lamps).toFixed(2)})`);
      g.addColorStop(1, "rgba(255,180,92,0)");
      c.fillStyle = g; c.fillRect(x - 26, HORIZON - 12, 52, 52);
      c.fillStyle = `rgba(255,244,220,${lamps.toFixed(2)})`; c.beginPath(); c.arc(x, HORIZON + 14, 1.8, 0, 7); c.fill();
    }
    // ground mist from the humidity; fog buries the far planes first
    const mistC = sc.alt > 0 ? FOG.day : hex("#d9c8bd");
    const mist = sc.fog ? 0.55 : (sc.humidity / 100) * 0.1;
    const mg = c.createLinearGradient(0, sc.fog ? TOWN_TOP : HORIZON - 40, 0, H);
    mg.addColorStop(0, rgba(mistC, 0)); mg.addColorStop(sc.fog ? 0.5 : 0.35, rgba(mistC, mist)); mg.addColorStop(1, rgba(mistC, mist * 0.4));
    c.fillStyle = mg; c.fillRect(0, sc.fog ? TOWN_TOP : HORIZON - 40, W, H);
  }

  function paintFog(sc) {
    put(L.fog, "display", sc.fog ? "" : "none");
    fogShown = sc.fog;
    if (!sc.fog) return;
    const ctx = L.fog.getContext("2d"), bw = TILE, bh = L.fog.height, img = ctx.createImageData(bw, bh);
    const col = sc.alt > 0 ? FOG.day : hex("#8d8a92");
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      const v = fbm((i / bw) * 6, (j / bh) * 1.4, 6, 4, 61), fy = j / bh, o = (j * bw + i) * 4;
      px(img.data, o, col, 255 * sstep(0.3, 0.75, v) * Math.sin(Math.PI * fy) * 0.55);
    }
    ctx.putImageData(img, 0, 0); ctx.putImageData(img, bw, 0);
    const f = L.ffog.getContext("2d");
    f.clearRect(0, 0, L.ffog.width, L.ffog.height);
    f.drawImage(L.fog, 0, 0, L.ffog.width, L.ffog.height);
  }
  function px(d, o, c, a) { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = a; }

  /* ---------------- falling weather: three sheared-periodic sheets per kind ----------------
     Each sheet repeats every T px down its own slant, so translating it by (slant*T, T) lands on
     the same picture: the loop only ever moves three textures. */
  const T = 300;
  const FALL = {
    drizzle: { speed: [170, 240, 320], len: [5, 8, 12], n: [520, 260, 90], a: [0.12, 0.18, 0.24], w: [0.6, 0.8, 1.0], scale: [0.5, 0.75, 1] },
    rain: { speed: [430, 610, 830], len: [12, 20, 32], n: [700, 380, 140], a: [0.11, 0.17, 0.25], w: [0.6, 0.8, 1.1], scale: [0.5, 0.75, 1] },
    storm: { speed: [560, 800, 1100], len: [16, 28, 44], n: [1000, 560, 220], a: [0.13, 0.2, 0.3], w: [0.7, 0.9, 1.2], scale: [0.5, 0.75, 1] },
    snow: { speed: [26, 42, 66], len: [0.8, 1.4, 2.4], n: [700, 300, 90], a: [0.55, 0.75, 0.9], w: [6, 10, 16], scale: [0.5, 0.75, 1] },
  };
  function paintFall(sc) {
    const kind = sc.wet ? sc.kind : sc.snow ? "snow" : null;
    const P = kind && FALL[kind];
    const snow = kind === "snow";
    const slant = P ? clamp((sc.east * sc.kmh) / (snow ? 22 : 50), snow ? -1 : -0.6, snow ? 1 : 0.6) : 0;
    const col = sc.alt > 0 && !snow ? hex("#56657a") : snow ? hex("#f4f7ff") : hex("#d6e2fa");
    L.fall = P ? { kind, slant, speed: P.speed, sway: snow ? P.w : [0, 0, 0], off: [0, 0, 0] } : null;
    for (let li = 0; li < 3; li++) {
      if (L.sheets[li]) { L.sheets[li].remove(); L.sheets[li] = null; }
      if (!P) continue;
      const sway = snow ? P.w[li] : 0, mx = Math.abs(slant) * T + sway * 2 + 4;
      const cw = W + mx, ch = H + T, k = P.scale[li];
      const left = (slant > 0 ? -Math.abs(slant) * T : 0) - sway - 2;
      const c = cvs(world, cw * k, ch * k, cw, ch, left, -T, "mover");
      // the beads canvases sit in front of the falling weather
      world.insertBefore(c, L.beadViews.length ? L.beadViews[0].c : frostEl);
      const x = c.getContext("2d"), r = rng(100 + li);
      x.scale(k, k);
      const count = Math.round(P.n[li] * sc.intensity * (cw * ch) / 1e6);
      const flake = snow ? flakeSprite(P.len[li]) : null;
      for (let i = 0; i < count; i++) {
        const x0 = r() * cw, y0 = r() * T, a = P.a[li] * (0.6 + r() * 0.4);
        const len = snow ? 0 : P.len[li] * (0.7 + r() * 0.6);
        for (let y = y0 - T; y < ch + T; y += T) {
          const xx = x0 + ((y - y0) / T) * slant * T;
          if (snow) {
            x.globalAlpha = a; const s = P.len[li] * (0.7 + r() * 0.6) * 2;
            x.drawImage(flake, xx - s, y - s, s * 2, s * 2);
          } else {
            x.strokeStyle = rgba(col, a); x.lineWidth = P.w[li]; x.lineCap = "round";
            x.beginPath(); x.moveTo(xx, y); x.lineTo(xx + len * slant, y + len); x.stroke();
          }
        }
      }
      x.globalAlpha = 1;
      L.sheets[li] = c;
    }
  }
  function flakeSprite(r) {
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const x = c.getContext("2d"), g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(244,247,255,0.85)"); g.addColorStop(1, "rgba(244,247,255,0)");
    x.fillStyle = g; x.fillRect(0, 0, 32, 32);
    return c;
  }

  /* ---------------- beads on the window glass ----------------
     Each drop is a tiny lens: the scene upside down inside it (warm town at its top at night),
     a dark meniscus on the upper rim, a lit lower rim and caustic, one specular point. Drops land
     one at a time, merge, and now and then one grows heavy and runs, leaving a trail. Sharp
     where the glass is clear; under the panes only the 1/4-scale frosted copy shows them. */
  const beads = [], runs = [], trails = [];
  let atlas = null, beadClock = 0, nextRun = 0, frostDirty = true, lastDraw = 0, lastFrost = 0, lastFade = 0;
  // What changed on the glass since the last draw: small rects in css px, or `whole` for
  // everything. Each rect is redrawn alone, clipped, so a landing costs a 20 px patch, not a
  // view. (The old build trimmed every new drop in the step it landed to avoid redraws, so the
  // glass never gained a drop: an open review item.)
  let dirty = [], whole = false;
  function mark(x0, y0, x1, y1) {
    if (x0 == null) { whole = true; return; }
    dirty.push([x0, y0, x1, y1]);
  }
  const near = (b, m) => mark(b.x - m, b.y - m, b.x + m, b.y + m);
  function makeAtlas(sc) {
    const night = sc.alt < 0;
    const sizes = [];
    for (let r = 1.25; r <= 6.01; r += 0.25) sizes.push(r);
    const cell = Math.ceil((6 * 2 + 6) * DPR);
    const c = document.createElement("canvas"); c.width = cell * sizes.length; c.height = cell;
    const x = c.getContext("2d");
    sizes.forEach((r, i) => {
      const cx = i * cell + cell / 2, cy = cell / 2, R = r * DPR;
      const g = x.createLinearGradient(0, cy - R, 0, cy + R);
      g.addColorStop(0, night ? "rgba(255,201,142,0.30)" : "rgba(255,255,255,0.32)");
      g.addColorStop(0.5, night ? "rgba(140,138,160,0.06)" : "rgba(160,176,196,0.08)");
      g.addColorStop(1, night ? "rgba(214,222,239,0.26)" : "rgba(70,86,106,0.22)");
      x.fillStyle = g; x.beginPath(); x.ellipse(cx, cy, R, R * 1.05, 0, 0, 7); x.fill();
      x.lineWidth = Math.min(1, r * 0.22) * DPR; x.strokeStyle = night ? "rgba(3,5,10,0.4)" : "rgba(30,40,55,0.35)";
      x.beginPath(); x.ellipse(cx, cy, R, R * 1.05, 0, Math.PI * 1.11, Math.PI * 1.89); x.stroke();
      x.lineWidth = Math.min(0.9, r * 0.2) * DPR; x.strokeStyle = "rgba(255,236,210,0.55)";
      x.beginPath(); x.ellipse(cx, cy, R * 0.92, R * 0.97, 0, Math.PI * 0.17, Math.PI * 0.83); x.stroke();
      const cg = x.createRadialGradient(cx, cy + R * 0.5, 0, cx, cy + R * 0.5, R * 0.5);
      cg.addColorStop(0, "rgba(255,241,220,0.75)"); cg.addColorStop(1, "rgba(255,241,220,0)");
      x.fillStyle = cg; x.beginPath(); x.ellipse(cx, cy + R * 0.5, R * 0.5, R * 0.22, 0, 0, 7); x.fill();
      x.fillStyle = "rgba(255,255,255,0.9)"; x.beginPath(); x.arc(cx - R * 0.32, cy - R * 0.4, Math.max(0.45 * DPR, R * 0.17), 0, 7); x.fill();
    });
    atlas = { c, cell, sizes };
  }
  function addBead(r, x, y) { const b = { x: x == null ? Math.random() * W : x, y: y == null ? Math.random() * H : y, r }; beads.push(b); return b; }
  function seedBeads(sc) {
    const k = sc.intensity;
    for (let i = 0; i < 1100 * k; i++) addBead(0.5 + Math.random() * 0.8);
    for (let i = 0; i < 190 * k; i++) addBead(1.4 + Math.random() * 2.6);
    mark(); frostDirty = true;
  }
  function beadStep(sc, t, dt) {
    if (!dt) return;
    beadClock += dt;
    if (sc.wet) {
      const k = sc.intensity, smallCap = 1100 * k, bigCap = 190 * k;
      // drops land: mostly fine spray, now and then a bigger one; a landing on a bead merges
      const land = (sc.kind === "drizzle" ? 6 : sc.kind === "rain" ? 16 : 26) * k * dt;
      for (let i = 0; i < land + Math.random() - 0.5; i++) {
        const x = Math.random() * W, y = Math.random() * H, r = Math.random() < 0.12 ? 1.4 + Math.random() * 1.2 : 0.5 + Math.random() * 0.8;
        const hit = r > 1 ? beads.find((b) => b.r > 1.3 && Math.abs(b.x - x) < b.r + r && Math.abs(b.y - y) < b.r + r) : null;
        if (hit) { hit.r = Math.min(6, Math.sqrt(hit.r * hit.r + r * r)); near(hit, 10); frostDirty = true; }
        else { const b = addBead(r, x, y); near(b, 10); if (r >= 1) frostDirty = true; }
      }
      // Over the cap, the OLDEST give way, so new drops stay. Fine spray (faint specks) simply
      // goes; the oldest big drops, as many as are over the cap, thin toward a speck over about
      // two seconds, so nothing large blinks out, and the speck each becomes goes next.
      let small = 0, big = 0;
      for (const b of beads) b.r > 1.3 ? big++ : small++;
      for (let i = 0, over = big - bigCap; i < beads.length && over > 0; i++) {
        const b = beads[i];
        if (b.r <= 1.3) continue;
        over--;
        b.r = Math.max(1.2, b.r - 1.5 * dt); near(b, 10); frostDirty = true;
        if (b.r <= 1.3) small++;
      }
      for (let i = 0; i < beads.length && small > smallCap; ) {
        const b = beads[i];
        if (b.r <= 1.3) { beads.splice(i, 1); small--; near(b, 4); } else i++;
      }
      // one grows heavy and runs: every 20-60 s in drizzle, more often in rain
      if (beadClock > nextRun && runs.length < 2) {
        const gap = sc.kind === "drizzle" ? [20, 60] : sc.kind === "rain" ? [6, 16] : [3, 9];
        nextRun = beadClock + gap[0] + Math.random() * (gap[1] - gap[0]);
        const cands = beads.filter((b) => b.r > 2.6 && b.y < H * 0.6);
        const b = cands.length ? cands[(Math.random() * cands.length) | 0] : null;
        if (b) { beads.splice(beads.indexOf(b), 1); near(b, 10); frostDirty = true; runs.push({ x: b.x, y: b.y, r: Math.max(3.6, b.r), vy: 30, pts: [[b.x, b.y]], left: 0 }); }
      }
    } else if (beads.length || runs.length) {
      // dry: the glass clears over about a minute
      const n = Math.ceil(beads.length * 0.05 * dt) + (Math.random() < dt ? 1 : 0);
      for (let i = 0; i < n && beads.length; i++) beads.splice((Math.random() * beads.length) | 0, 1);
      if (n) { mark(); frostDirty = true; }
    }
    for (let i = runs.length - 1; i >= 0; i--) {
      const u = runs[i], ox = u.x, oy = u.y;
      u.vy = Math.min(150, u.vy + 90 * dt);
      u.y += u.vy * dt;
      u.x += (Math.random() - 0.5) * 6 * dt * 10 * 0.25;
      const last = u.pts[u.pts.length - 1];
      if (u.y - last[1] > 14) {
        u.pts.push([u.x, u.y]);
        // it sweeps up what lies in its path and leaves a bead-chain behind
        for (let j = beads.length - 1; j >= 0; j--) { const b = beads[j]; if (Math.abs(b.x - u.x) < u.r + b.r && Math.abs(b.y - u.y) < 14) { beads.splice(j, 1); u.r = Math.min(5.4, u.r + b.r * 0.06); frostDirty = true; } }
        if (Math.random() < 0.3) addBead(0.6 + Math.random() * 0.7, u.x + (Math.random() - 0.5) * 3, u.y - 8);
        u.r -= 0.05;
      }
      // the drop, its sweep and its new trail segment, from where it was to where it is
      mark(Math.min(ox, u.x) - 16, oy - 22, Math.max(ox, u.x) + 16, u.y + 16);
      if (u.y > H + 10 || u.r < 2.4) {
        if (u.y <= H) { addBead(u.r, u.x, u.y); frostDirty = true; }
        trails.push({ pts: u.pts.concat([[u.x, u.y]]), born: beadClock });
        runs.splice(i, 1);
      }
    }
    for (let i = trails.length - 1; i >= 0; i--) if (beadClock - trails[i].born > 30) { trails.splice(i, 1); mark(); }
    // a trail fades over 30 s; a step every 2 s is under 0.01 alpha, too small to see
    if (trails.length && beadClock - lastFade >= 2) { lastFade = beadClock; mark(); }
    drawBeads(t);
  }
  function drawBeads(t) {
    const live = runs.length ? 1 / 15 : 1 / 8;
    if ((whole || dirty.length) && t - lastDraw >= live) {
      lastDraw = t;
      for (const v of L.beadViews) {
        if (whole) { drawView(v); continue; }
        const hits = dirty.filter(([x0, y0, x1, y1]) => x1 >= v.x && x0 <= v.x + v.w && y1 >= v.y && y0 <= v.y + v.h);
        // past a few dozen patches one full redraw is cheaper than many clipped ones
        if (hits.length > 40) drawView(v);
        else for (const [x0, y0, x1, y1] of hits) drawView(v, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
      dirty = []; whole = false;
    }
    if (frostDirty && t - lastFrost >= 0.5) {
      lastFrost = t; frostDirty = false;
      const f = L.fbeads.getContext("2d");
      f.setTransform(0.25, 0, 0, 0.25, 0, 0);
      f.clearRect(0, 0, W, H);
      let ink = false;
      for (const b of beads) {
        if (b.r < 1) continue;
        ink = true;
        f.fillStyle = `rgba(220,228,244,${Math.min(0.5, 0.06 * b.r).toFixed(2)})`;
        f.beginPath(); f.arc(b.x, b.y, b.r * 2.4, 0, 7); f.fill();
      }
      fr.ink = ink; fr.due = fr.force = true;
    }
  }
  // Redraws one view, or only `clip` (a css-px rect) of it.
  function drawView(v, clip) {
    const x = v.c.getContext("2d"), a = clip || v;
    x.save();
    x.setTransform(DPR, 0, 0, DPR, -v.x * DPR, -v.y * DPR);
    if (clip) { x.beginPath(); x.rect(a.x, a.y, a.w, a.h); x.clip(); }
    x.clearRect(a.x, a.y, a.w, a.h);
    const inV = (b, m) => b.x > a.x - m && b.x < a.x + a.w + m && b.y > a.y - m && b.y < a.y + a.h + m;
    for (const tr of trails.concat(runs.map((u) => ({ pts: u.pts.concat([[u.x, u.y]]), born: beadClock })))) {
      const fade = 1 - (beadClock - tr.born) / 30;
      if (fade <= 0 || !tr.pts.some((p) => inV({ x: p[0], y: p[1] }, 6))) continue;
      x.lineCap = "round"; x.lineJoin = "round";
      x.beginPath(); tr.pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])));
      x.strokeStyle = `rgba(214,224,244,${(0.07 * fade).toFixed(3)})`; x.lineWidth = 3.4; x.stroke();
      x.strokeStyle = `rgba(214,224,244,${(0.12 * fade).toFixed(3)})`; x.lineWidth = 0.8; x.stroke();
    }
    x.setTransform(1, 0, 0, 1, -v.x * DPR, -v.y * DPR);
    const draw = (b, ry) => {
      if (!inV(b, 8)) return;
      if (b.r < 1.3) {
        x.fillStyle = `rgba(226,232,246,${(0.12 + (b.r - 0.5) * 0.2).toFixed(2)})`;
        x.beginPath(); x.arc(b.x * DPR, b.y * DPR, b.r * DPR, 0, 7); x.fill();
        return;
      }
      const i = clamp(Math.round((b.r - 1.25) / 0.25), 0, atlas.sizes.length - 1), cl = atlas.cell;
      x.drawImage(atlas.c, i * cl, 0, cl, cl, b.x * DPR - cl / 2, b.y * DPR - cl / 2 * (ry || 1), cl, cl * (ry || 1));
    };
    for (const b of beads) draw(b);
    for (const u of runs) draw(u, 1.25);
    x.restore();
  }
  // Where the glass is clear: the window column, the strip under the Dock, the strip above the panes.
  function beadRegions() {
    const room = document.getElementById("room").getBoundingClientRect();
    const wings = [...document.querySelectorAll(".wing")].map((w) => w.getBoundingClientRect());
    const leftEdge = wings[0] ? wings[0].right : room.left;
    const vis = [...document.querySelectorAll(".wing.right .glass")].filter((g) => g.offsetParent);
    const rightEdge = vis.length ? Math.min(...vis.map((g) => g.getBoundingClientRect().left)) : W;
    return [
      { x: Math.floor(leftEdge), y: 0, w: Math.ceil(rightEdge - leftEdge), h: H },
      { x: 0, y: 0, w: Math.ceil(room.left), h: H },
      { x: Math.ceil(room.left), y: 0, w: W - Math.ceil(room.left), h: Math.ceil(room.top) },
    ];
  }
  function layoutBeads() {
    for (const v of L.beadViews) v.c.remove();
    L.beadViews = beadRegions().map((r) => {
      const c = cvs(world, r.w * DPR, r.h * DPR, r.w, r.h, r.x, r.y);
      world.insertBefore(c, frostEl);
      return Object.assign({ c }, r);
    });
    mark();
  }

  /* ---------------- frost clip and the pane-edge flash, from the live layout ---------------- */
  function rr(x, y, w, h, r) {
    return `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}` +
      `H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;
  }
  function layout() {
    if (!built) return;
    // the wings' panes and the window's (the slip, the plate, and a figure's pane while it shows)
    const rects = [...document.querySelectorAll(".glass, .slip, .wx .plate, .figcard")].filter((g) => g.offsetParent)
      .map((g) => { const b = g.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: g.matches(".glass") ? 22 : 16 }; });
    frostEl.style.clipPath = `path('${rects.map((b) => rr(b.x, b.y, b.w, b.h, b.r)).join("")}')`;
    document.getElementById("edgeflash").innerHTML = rects.filter((b) => b.r === 22).map((b) =>
      `<i style="position:absolute;left:${b.x + 14}px;top:${b.y}px;width:${b.w - 28}px;height:2px;border-radius:1px;background:linear-gradient(90deg,transparent,#eef3ff 50%,transparent);box-shadow:0 0 12px 2px rgba(220,230,255,.7)"></i>`).join("");
    layoutBeads();
  }

  /* ---------------- everything that moves ---------------- */
  const pos = { a: 0, b: 0, c: 0, fog: 0 };
  // Cloud textures are 1/3 scale and soft, so a step under STEP css px (a third of a texel)
  // reads as a glide. Drift steps only as often as that needs, at most 12 fps.
  const STEP = 1.25, DRIFT_MAX = 12;
  let stopLoop = null, loopFps = 0, flashAt = -1, nextFlash = 0, lastT = 0;
  let driftFps = 0, driftInLoop = false, lastDrift = 0;
  function setLoop(fps) {
    if (Kiln.reduced) fps = 0;
    if (fps === loopFps) return;
    if (stopLoop) stopLoop();
    stopLoop = fps ? Kiln.loop(tick, { fps }) : null;
    loopFps = fps;
  }
  // Clouds drift at the real wind, nearer decks faster; the fog band creeps even in still air.
  function driftRate(sc) {
    const vx = Math.abs(sc.east * sc.kmh * 0.16);
    const deck = sc.cover > 0.06 && vx > 0.08 ? vx * Math.max(...DECKS.map((d) => d.speed)) : 0;
    const fog = sc.fog ? Math.abs(sc.east * sc.kmh * 0.16 * 0.6 + 3) : 0;
    const fast = Math.max(deck, fog);
    return fast ? Math.min(DRIFT_MAX, fast / STEP) : 0;
  }
  // Which clock moves what: a loop only while something falls, the glass is wet, or the
  // drift needs more steps than the feed's own updates give it.
  function plan() {
    const sc = S;
    if (!sc) return;
    const glassWet = beads.length || runs.length || trails.length;
    const fall = sc.wet || sc.storm ? 30 : sc.snow ? 20 : glassWet ? 10 : 0;
    driftFps = driftRate(sc);
    const onUpdates = driftFps <= 1000 / Kiln.period + 0.01;
    driftInLoop = !!fall || !onUpdates;
    setLoop(fall || (onUpdates ? 0 : Math.ceil(driftFps)));
    for (const v of L.beadViews) put(v.c, "display", glassWet ? "" : "none");
    if (!sc.storm && flashAt >= 0) { flashAt = -1; endFlash(); }
  }
  function drift(t) {
    const sc = S;
    const dt = lastDrift ? Math.min(t - lastDrift, 1.5) : 0;
    lastDrift = t;
    if (!dt || !sc) return;
    const vx = sc.east * sc.kmh * 0.16;
    if (cloudsShown) for (const d of DECKS) {
      pos[d.id] += vx * d.speed * dt;
      d.x = (((pos[d.id] % TW) + TW) % TW) - TW;
      put(d.el, "transform", `translate3d(${d.x.toFixed(2)}px,0,0)`);
    }
    if (sc.fog) {
      pos.fog += (vx * 0.6 + 3) * dt;
      fogX = (((pos.fog % TW) + TW) % TW) - TW;
      put(L.fog, "transform", `translate3d(${fogX.toFixed(2)}px,0,0)`);
    }
    fr.due = true;
  }
  function tick(t, dt) {
    lastT = t;
    dt = Math.min(dt, 0.1);
    const sc = S;
    if (!sc) return;
    if (dt && driftFps && t - lastDrift >= 1 / driftFps - 0.004) drift(t);
    const F = L.fall;
    if (F) for (let i = 0; i < 3; i++) {
      F.off[i] = (F.off[i] + F.speed[i] * dt) % T;
      const sway = F.sway[i] ? Math.sin(t * (0.5 + i * 0.17) + i * 2) * F.sway[i] : 0;
      put(L.sheets[i], "transform", `translate3d(${(F.slant * F.off[i] + sway).toFixed(2)}px,${F.off[i].toFixed(2)}px,0)`);
    }
    if (sc.wet || beads.length || runs.length || trails.length) beadStep(sc, t, dt);
    if (sc.storm) lightning(t);
    frostMaybe();
  }
  // Storm: lightning lights the clouds from inside, then each pane's top edge flashes once.
  // Between flashes the bolt and the edge lines are display: none and hold no texture.
  function endFlash() {
    const edge = document.getElementById("edgeflash");
    put(L.bolt, "display", "none"); put(edge, "display", "none");
    fr.flash = 0; fr.due = fr.force = true;
  }
  function lightning(t) {
    if (!nextFlash) nextFlash = t + 2 + Math.random() * 6;
    const edge = document.getElementById("edgeflash");
    if (flashAt < 0 && t >= nextFlash) {
      flashAt = t; nextFlash = t + 4 + Math.random() * 10;
      boltAt.x = -250 + Math.random() * (W - 600); boltAt.y = -120 + Math.random() * 200;
      put(L.bolt, "transform", `translate3d(${boltAt.x.toFixed(1)}px,${boltAt.y.toFixed(1)}px,0)`);
      put(L.bolt, "display", ""); put(edge, "display", "");
    }
    if (flashAt < 0) return;
    const k = t - flashAt;
    const env = k < 0.06 ? k / 0.06 : k < 0.15 ? 1 - ((k - 0.06) / 0.09) * 0.8 : k < 0.21 ? 0.2 + ((k - 0.15) / 0.06) * 0.65 : k < 0.75 ? 0.85 * (1 - (k - 0.21) / 0.54) : 0;
    put(L.bolt, "opacity", env.toFixed(3));
    put(edge, "opacity", (k < 0.4 ? env : 0).toFixed(3));
    fr.flash = env; fr.due = fr.force = true;
    if (k >= 0.75) { flashAt = -1; endFlash(); }
  }

  /* ---------------- apply a scene ---------------- */
  let keyLight = "", keyCover = "", keyFall = "";
  // The glass the panes are cut from: "day" (pale frost, dark ink) or "night" (smoked, light
  // ink). dev ?theme= > the appearance menu > config.js > the sun; "system" follows the system.
  function glassOf(sc) {
    const pin = Q.get("theme") || forced() || CFG.theme || "sun";
    if (pin === "day" || pin === "night") return pin;
    if (pin === "system") return matchMedia("(prefers-color-scheme: light)").matches ? "day" : "night";
    return sc.isDay ? "day" : "night";
  }
  function theme(sc) {
    const pin = Q.get("theme") || forced() || CFG.theme || "sun";
    const root = document.documentElement;
    // a write to the root restyles the whole page, so write only a change
    const set = (k, v) => { if (v == null) { if (k in root.dataset) delete root.dataset[k]; } else if (root.dataset[k] !== v) root.dataset[k] = v; };
    set("theme", pin === "system" ? null : glassOf(sc));
    // the real light outside (never the appearance): under a pinned glass that disagrees with it
    // the panes thicken their tint and the window's plate follows the sky (index.html)
    set("light", sc.isDay ? "day" : "night");
    document.body.classList.toggle("snowy", sc.snow || sc.kind === "snow");
    // the window's ink (data-sky) is chosen by ink(), from the sky as painted
  }

  /* ---------------- the window's ink, from the sky actually painted behind it ----------------
     Only the clock and the temperature sit straight on the sky (README, Preferences, "No veils on
     the sky": nothing is laid over the sky to help them; the words are on panes). Their ink is
     chosen from what is painted behind each figure: the gradient, the sun's glow and the three
     cloud decks (their own pixels), at 16 drift positions, each deck at its own offset since they
     drift at different speeds. White or dark figures, whichever has the higher 5th-percentile APCA
     Lc behind the weaker of the two. No hysteresis: the sampling is fixed, so the choice is a
     function of the sky alone, the same in either appearance. If even that ink is under the
     target there (60 for large type, +2: with nothing laid over the sky the model lands within
     0.4 Lc of the rendered pixels, 62.9 against 63.3 on a clear day; the decks, read at 3 px,
     can move it a little more), both figures get panes of their own (index.html .figcard,
     .window.cards) and take the panes' ink. Once per scene: a weather or light change, a sun step
     of 4 px, an appearance change. Never per line. Measured against rendered pixels in notes.md
     (No veils). */
  const INK_Y0 = 78, INK_Y1 = 332;   // the rows of deck pixels kept for it (paintClouds)
  // page css px: x0, x1, y0, y1, Lc target
  const INK_BOX = [
    [616, 896, 80, 164, 62],   // clock
    [692, 820, 271, 329, 62],  // temperature
  ];
  const sY = (c) => 0.2126729 * Math.pow(c[0] / 255, 2.4) + 0.7151522 * Math.pow(c[1] / 255, 2.4) + 0.072175 * Math.pow(c[2] / 255, 2.4);
  const LIN = Float64Array.from({ length: 256 }, (_, i) => Math.pow(i / 255, 2.4));   // APCA's linearisation, by 8-bit level
  function apca(yt, yb) {                  // APCA 0.0.98G-4g, |Lc|
    const cl = (y) => (y < 0.022 ? y + Math.pow(0.022 - y, 1.414) : y);
    yt = cl(yt); yb = cl(yb);
    if (Math.abs(yb - yt) < 0.0005) return 0;
    if (yb > yt) { const s = (Math.pow(yb, 0.56) - Math.pow(yt, 0.57)) * 1.14; return s < 0.1 ? 0 : (s - 0.027) * 100; }
    const s = (Math.pow(yb, 0.65) - Math.pow(yt, 0.62)) * 1.14; return s > -0.1 ? 0 : -(s + 0.027) * 100;
  }
  // the figures' Y per sky: a "dark" sky takes white figures, a "light" one #0a111c (--wink)
  const INKS = { dark: 1, light: sY(hex("#0a111c")) };
  let inkKey = "", inkInfo = null;
  const winEl = document.getElementById("window");
  function ink(sc) {
    const key = keyLight + "|" + keyCover + "|" + sunAt.vis + "|" + Math.round(sunAt.x / 4) + "," + Math.round(sunAt.y / 4);
    if (key === inkKey) return;
    inkKey = key;
    const st = skyStops(sc), pos = [0, 45, 72, 86, 90].map((p) => (p / 100) * H);
    const skyAt = (y) => {
      if (y <= pos[0]) return st[0];
      for (let i = 1; i < 5; i++) if (y <= pos[i]) return mix(st[i - 1], st[i], (y - pos[i - 1]) / (pos[i] - pos[i - 1]));
      return st[4];
    };
    // the sun's glow (paintSun's gradient), as drawn at sunAt with opacity sunAt.vis
    const SUN = [[0, 0.95], [0.032, 0.9], [0.09, 0.35], [0.3, 0.1], [0.62, 0]];
    const glow = (x, y) => {
      if (!(sunAt.vis > 0) || !sunAt.core) return null;
      const r = Math.hypot(x - sunAt.x - 320, y - sunAt.y - 320) / (320 * Math.SQRT2);
      if (r >= 0.62) return null;
      let i = 1; while (SUN[i][0] < r) i++;
      const k = (r - SUN[i - 1][0]) / (SUN[i][0] - SUN[i - 1][0]);
      const a = (SUN[i - 1][1] + (SUN[i][1] - SUN[i - 1][1]) * k) * sunAt.vis;
      return [r < 0.032 ? sunAt.core : mix(sunAt.core, sunAt.halo, clamp((r - 0.032) / 0.058, 0, 1)), a];
    };
    // 16 drift positions; each deck steps through its tile by its own irrational stride
    const N = 16, STEP = 4, G = [0.618034, 0.414214, 0.302776], OFF = [0, 0.31, 0.73];
    const decks = DECKS.map((d, k) => ({ d, B: d.band, o: Array.from({ length: N }, (_, i) => ((i * G[k] + OFF[k]) % 1) * TW) })).filter((e) => e.B);
    const boxY = INK_BOX.map(() => []);
    INK_BOX.forEach((b, bi) => {
      for (let y = b[2] + STEP / 2; y < b[3]; y += STEP) {
        const row = skyAt(y);
        for (let x = b[0] + STEP / 2; x < b[1]; x += STEP) {
          let base = row;
          const s = glow(x, y);
          if (s) base = mix(base, s[0], s[1]);
          for (let i = 0; i < N; i++) {
            let r = base[0], g = base[1], bl = base[2];
            for (const { d, B, o } of decks) {
              const j = Math.floor((y - d.top) / SCALE) - B.r0;
              if (j < 0 || j >= B.r1 - B.r0) continue;
              const col = Math.floor(((x + o[i]) % TW) / SCALE), p = (j * B.bw + col) * 4, a = B.px[p + 3] / 255;
              if (a > 0) { r += (B.px[p] - r) * a; g += (B.px[p + 1] - g) * a; bl += (B.px[p + 2] - bl) * a; }
            }
            const R8 = r + 0.5 | 0, G8 = g + 0.5 | 0, B8 = bl + 0.5 | 0;
            boxY[bi].push(0.2126729 * LIN[R8] + 0.7151522 * LIN[G8] + 0.072175 * LIN[B8]);
          }
        }
      }
    });
    // per figure, the Lc each ink holds behind 95% of what passes behind it; the ink is the one
    // whose weaker figure holds more, and a figure under its target sends both onto panes
    const p5 = (k, bi) => { const a = boxY[bi].map((y) => apca(INKS[k], y)).sort((p, q) => p - q); return a[Math.floor(a.length * 0.05)] || 0; };
    const lc = { dark: INK_BOX.map((_, bi) => p5("dark", bi)), light: INK_BOX.map((_, bi) => p5("light", bi)) };
    const sky = Math.min(...lc.light) > Math.min(...lc.dark) ? "light" : "dark";
    const cards = INK_BOX.some((b, bi) => lc[sky][bi] < b[4]);
    const root = document.documentElement;
    if (root.dataset.sky !== sky) root.dataset.sky = sky;
    if (winEl && winEl.classList.contains("cards") !== cards) { winEl.classList.toggle("cards", cards); layout(); }
    inkInfo = { sky, cards, clock: +lc[sky][0].toFixed(1), temp: +lc[sky][1].toFixed(1),
      white: lc.dark.map((v) => +v.toFixed(1)), darkInk: lc.light.map((v) => +v.toFixed(1)) };
    if (winEl) winEl.dataset.lc = `${inkInfo.clock} ${inkInfo.temp}`;
  }
  // README 8a.6b: the scene depends on the weather block (kept by identity while unchanged) and
  // on the sun, which moves slowly: so it is worked out again only when the block changes or a
  // minute turns. Every line still steps the drift.
  let seenW, seenMin = -1;
  Kiln.on(scene);
  // The appearance menu, live: the glass changes now (the theme and the frost's glow), not on the
  // next line, which a slow period or a still page would leave showing the old glass. The sky is
  // the real one either way, so it repaints only if the light key moved (the glass is part of
  // it). The unit menu does not touch the scene.
  let seenApp = Kiln.appearance;
  Kiln.onPrefs((p) => {
    if (p.appearance === seenApp) return;
    seenApp = p.appearance;
    seenW = undefined;
    if (built && Kiln.state) scene(Kiln.state);
  });
  function scene(s) {
    if (!built) build();
    const prev = S, min = Math.floor(s.t / 60);
    if (S && s.weather === seenW && min === seenMin) { perLine(); return; }
    seenW = s.weather; seenMin = min;
    const sc = describe(s);
    S = sc;
    theme(sc);
    // repaint only when the light or the weather has really changed
    const light = Math.round(sc.alt * 24) + "|" + sc.kind + "|" + sc.wet + "|" + glassOf(sc);
    const cover = Math.round(sc.cover * 20) + "|" + sc.fog;
    const fall = sc.kind + "|" + Math.round(sc.intensity * 10) + "|" + Math.round(sc.east * sc.kmh / 4) + "|" + (sc.alt > 0);
    if (light !== keyLight || cover !== keyCover) {
      // the town first: the frosted sky copy is drawn from it
      paintTown(sc); paintSky(sc); publishTown(); paintStars(sc); paintClouds(sc); paintFog(sc); makeAtlas(sc);
      keyLight = light; keyCover = cover; mark(); frostDirty = true; fr.due = fr.force = true;
    }
    if (fall !== keyFall) { paintFall(sc); keyFall = fall; }
    paintSun(sc);
    ink(sc);
    if (!prev && sc.wet) seedBeads(sc);
    if (!prev) { layoutBeads(); if (Kiln.reduced) { drawBeads(1e9); } }
    perLine();
  }
  function perLine() {
    plan();   // cheap: which clock moves what, now that the glass may have dried
    // the feed's own updates are the drift clock when they come often enough
    if (!Kiln.reduced && driftFps && !driftInLoop) drift(performance.now() / 1000);
    if (Kiln.reduced || loopFps === 0) tick(lastT, 0);
    frostMaybe();
  }
  Kiln.onPeriod(plan);

  // ink: what ink() last decided (sky, mean Lc of each ink on the bare sky, the two shades), for dev
  window.GlassSky = { weather: weatherOf, layout, get ink() { return inkInfo; } };
})();
