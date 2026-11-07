// horizon.js: the live Horizon wallpaper.
//
// A still camera on a wet plain at night. Near is now: the last hour of every session runs
// in a lane from the lit "now" edge back toward the horizon, and the data slides away as
// time passes. Where the lanes vanish, the past fortnight stands along the horizon as a far
// range, oldest at the left. The weekly limit is a gate beyond it; the sky is the real sky.
// Every figure is read from Kiln.state on every update, and "now" is state.t.
//
// Layers, back to front, each repainted only when its inputs change:
//   #stage    the sky as CSS backgrounds: gradient,     each minute at most, or on a weather
//             sun, stars, town glow (root tiles)        change; #moon is a 28 px canvas
//   clouds    a pre-rendered deck, drifted by the wind  translate only, once per update;
//                                                       absent under a clear sky
//   c-gate    the arc gate, sized to the arc            on a limits change, or the time mark moving
//   band      the lit "used" band, drawn once           rotated (a transform transition) per change
//   c-far     the fortnight range, GitHub posts         on an analytics/github change, each minute
//   c-ground  the plain and its reflections (1x)        on a weather or limits change
//   c-live    lane floors, ridges, trails, the now pane when the data changes, else once a second
//                                                       (the land recedes about 0.3 px a second)
//   cols      running agents' light columns (DOM)       rise and sink on the compositor
//   c-fx      rain rings (1x, only while it rains)      Kiln.loop at 15 fps
//   precip    rain or snow, two 1x canvases             translate only (Kiln.loop, 30 fps)
// Measured in the host (2026-11-04) the first build cost 11.7% WebContent, 8.8% GPU and
// 261 MB of graphics at 300 ms: the live canvas repainted every frame of every tween, and
// the precipitation layers were 4 screens of 2x tiles. Nothing here animates per frame now
// except falling rain or snow.
(function () {
  "use strict";
  const W = 1512, H = 982, YH = 468;
  const q = new URLSearchParams(location.search);
  const hosted = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.kiln);
  const dev = !hosted && q.has("fixture");
  const CONF = window.HORIZON_CONFIG || {};
  const presetName = (dev && q.get("preset")) || CONF.preset || "auto";
  const PRE = Object.assign({ sky: "sun", motion: true, focus: false }, (CONF.presets || {})[presetName]);
  const MOTION = PRE.motion && !Kiln.reduced;
  // No motion (quiet, reduced) and headless stills (?still): CSS transitions and Web
  // Animations are skipped, so a screenshot shows the landed state.
  const SNAP = !MOTION || (!hosted && q.has("still"));
  const tw = (key, from, to, fn, ms, ease) => (SNAP ? fn(to) : Kiln.tweenKey(key, from, to, fn, ms, ease));
  const WX_OVERRIDE = !hosted ? q.get("weather") : null;
  const root = document.documentElement;
  if (SNAP) root.classList.add("snap");
  if (q.has("bare")) root.classList.add("bare");
  if (q.has("ghost")) root.classList.add("ghost");   // dev: text drawn transparent, halos kept
  if (PRE.focus) root.classList.add("focus");

  // ---------- stage and surfaces ------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H) || 1;
    const tx = (innerWidth - W * s) / 2, ty = (innerHeight - H * s) / 2;
    // At the wallpaper's own size the stage takes no transform at all: a transformed stage
    // over composited canvases was given a full-screen backing of its own.
    stage.style.transform = s === 1 && !tx && !ty ? "none" : `translate(${tx}px,${ty}px) scale(${s})`;
  }
  addEventListener("resize", fit);
  fit();
  const DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  // A canvas sized to its content: every 2x full-screen surface costs about 24 MB of GPU
  // memory, so each one covers only the box it draws in. Coordinates stay stage px.
  function surface(id, top, h, dpr = DPR, left = 0, w = W) {
    const c = $(id);
    c.style.left = left + "px"; c.style.top = top + "px"; c.style.width = w + "px"; c.style.height = h + "px";
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext("2d");
    return { c, g, top, h, reset() { g.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr); g.clearRect(left, top, w, h); } };
  }
  const GATE = surface("c-gate", 56, 432, DPR, 330, 852);      // the arc and its time ring
  const FAR = surface("c-far", 340, 200);
  // Soft gradients only, so 1x; it starts exactly at the horizon, because a 1x edge inside
  // the canvas would be blurred by the upscale and soften the horizon line.
  const GROUND = surface("c-ground", YH, H - YH, 1);
  // the lane field's drawn extent (measured: x 103–1369, y 472–981, grid lines included)
  const LIVE = surface("c-live", 468, H - 468, DPR, 100, 1272);
  const FX = surface("c-fx", 456, H - 456, 1);                  // allocated only while it rains
  FX.c.width = FX.c.height = 0;
  if (PRE.focus) for (const id of ["c-far", "c-live", "cols"]) $(id).classList.add("unfocus");

  // ---------- small helpers -----------------------------------------------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const line = (g, pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
  let seed = 7;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const F = Kiln.fmt;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const pad2 = (n) => String(n).padStart(2, "0");
  // "6 d 21 h 05 m 09 s": the reset countdown ticks every update, so it carries seconds.
  function spanS(sec) {
    if (sec == null || !isFinite(sec)) return "–";
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d) return `${d} d ${h} h ${pad2(m)} m ${pad2(s)} s`;
    if (h) return `${h} h ${pad2(m)} m ${pad2(s)} s`;
    return `${m} m ${pad2(s)} s`;
  }
  // "1 h 43 m", "22 s": ages, two units. A missing or non-numeric age reads "–", never NaN.
  // The second unit is zero-padded, as in the countdown, so an age keeps its width for
  // hours ("3 h 09 m" to "3 h 10 m") and the text beside it holds still.
  function age(sec) {
    if (sec == null || !isFinite(sec)) return "–";
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d} d ${pad2(h)} h`;
    if (h) return `${h} h ${pad2(m)} m`;
    if (m) return `${m} m`;
    return `${sec} s`;
  }
  const dt = (t) => new Date(t * 1000);
  const WD = (t) => dt(t).toLocaleDateString("en-US", { weekday: "short" });
  const MO = (t) => dt(t).toLocaleDateString("en-US", { month: "short" });
  const dayLbl = (t) => `${WD(t)} ${dt(t).getDate()} ${MO(t)}`;
  const at12 = (t) => F.clock(t);
  const dateT = (iso, h = 0) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d, h).getTime() / 1000; };
  const midnightOf = (t) => { const d = dt(t); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
  function model(m) {
    const r = /claude-([a-z]+)-(\d+)-(\d+)/.exec(m || "");
    return r ? r[1][0].toUpperCase() + r[1].slice(1) + " " + r[2] + "." + r[3] : m || "";
  }
  const compass = (deg) => ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(deg / 22.5) % 16];
  function nice(v) {
    for (const n of [5e3, 1e4, 2e4, 3e4, 4e4, 6e4, 8e4, 1e5, 1.5e5, 2e5, 3e5, 4e5, 6e5, 8e5, 1e6, 2e6, 4e6]) if (v <= n) return n;
    return Math.ceil(v / 1e6) * 1e6;
  }
  const kfmt = (v) => (v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(Math.round(v)));

  // DOM writes happen only when the string or the position changes.
  const LB = $("labels");
  function mk(cls, parent = LB, tag = "div") { const e = document.createElement(tag); if (cls) e.className = cls; parent.appendChild(e); return e; }
  function txt(e, s) { if (e._s !== s) { e._s = s; e.textContent = s; } }
  function html(e, s) { if (e._h !== s) { e._h = s; e.innerHTML = s; } }
  function place(e, x, y, ax = 0, ay = 0) {
    const k = `${x.toFixed(1)} ${y.toFixed(1)} ${ax} ${ay}`;
    if (e._p === k) return;
    e._p = k;
    e.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(${-ax * 100}%,${-ay * 100}%)`;
  }
  function show(e, on) { const v = on ? "" : "none"; if (e.style.display !== v) e.style.display = v; }
  // A keyed set of labels: get() marks a key as present; sweep() removes the rest.
  function pool(cls, parent = LB) {
    const m = new Map();
    return {
      get(key) { let e = m.get(key); if (!e) { e = mk("lb " + cls, parent); m.set(key, e); } e._seen = true; return e; },
      sweep() { for (const [k, e] of m) { if (!e._seen) { e.remove(); m.delete(k); } else e._seen = false; } },
    };
  }

  // ---------- the camera --------------------------------------------------------
  // One pinhole projection draws the plain. The time axis is yawed so the past recedes to
  // the right toward a vanishing point at x 1120, where the fortnight range takes over.
  const CAM = { f: 640, eye: 1 };
  const TH = 0.95, VPX = 1120;
  const DIR = [Math.sin(TH), Math.cos(TH)], BACK = [-Math.cos(TH), Math.sin(TH)];
  CAM.cx = VPX - CAM.f * Math.tan(TH);
  const NOW0 = [660, 876];                                   // the front lane's now point
  const BZ = (CAM.f * CAM.eye) / (NOW0[1] - YH);
  const BASE = [((NOW0[0] - CAM.cx) * BZ) / CAM.f, BZ];
  // Screen px between lanes' now points: up to LANE_GAP, and never more than LANES_SPAN in
  // all. With one or two sessions the field used to sit small in the middle of the plain;
  // it now opens up to 64 px a lane, and closes to 40 at six rows as before.
  const LANE_GAP = 64, LANES_SPAN = 200;
  const EF = 0.03, EB = 0.05;                                // the now edge overhangs the outer lanes
  const KM = 4.2 / 60;                                       // world units per minute of age
  const HMAX = 0.34;                                         // world height of the scale's top
  const proj = (x, y, z) => [CAM.cx + (CAM.f * x) / z, YH + (CAM.f * (CAM.eye - y)) / z];
  const gnd = (m, b) => { const t = m * KM; return [BASE[0] + DIR[0] * t + BACK[0] * b, BASE[1] + DIR[1] * t + BACK[1] * b]; };
  const at = (m, b, h = 0) => { const [x, z] = gnd(m, b); return proj(x, h, z); };
  const FOG = [72, 84, 96];
  let fogDist = 9;
  const fogK = (z) => 1 - Math.exp(-z / fogDist);

  // ---------- weather look --------------------------------------------------------
  const KIND_CLOUD = { clear: 6, partly: 45, cloudy: 97, fog: 100, drizzle: 96, rain: 100, snow: 100, storm: 100 };
  function look(s) {
    const w = s.weather;
    const kind = WX_OVERRIDE || (w && w.kind) || "clear";
    const cloud = WX_OVERRIDE ? KIND_CLOUD[kind] ?? 50 : w ? w.cloud ?? KIND_CLOUD[kind] : 30;
    const rmm = w && !WX_OVERRIDE ? w.rain_mm || w.precip_mm || 0 : 0;
    const scm = w && !WX_OVERRIDE ? w.snow_cm || 0 : 0;
    const rain = kind === "drizzle" ? 0.3 + Math.min(0.2, rmm / 2) : kind === "rain" ? 0.62 + Math.min(0.38, rmm / 6) : kind === "storm" ? 1 : 0;
    const snow = kind === "snow" ? 0.55 + Math.min(0.45, scm / 3) : 0;
    const wind = w ? w.wind_kmh || 0 : 8, wdir = w ? w.wind_dir || 0 : 270;
    return { kind, cloud, rain, snow, fog: kind === "fog" ? 1 : 0, storm: kind === "storm", wind, wdir, snowCover: kind === "snow" ? Math.min(1, 0.4 + scm / 4) : 0 };
  }
  function sunAlt(A, s) {
    if (PRE.sky === "night") return -30;
    if (PRE.sky === "day") return 28;
    if (A) return A.sun.alt;
    return s.weather && s.weather.is_day ? 25 : -25;
  }

  // ---------- the sky -----------------------------------------------------------
  // Keyframes by the sun's altitude: zenith, middle, horizon. The type is light, so even
  // day stays a deep sky: measured, light ink keeps Lc 75 on values only while the sky
  // behind them stays under about (60,66,72), and Lc 60 on footnotes under (72,78,84).
  const SKYK = [
    [-90, [8, 12, 17], [16, 22, 29], [44, 50, 56]],
    [-12, [8, 12, 17], [16, 22, 29], [44, 50, 56]],
    [-6, [13, 19, 29], [24, 30, 42], [60, 55, 58]],
    [0, [20, 28, 42], [38, 44, 56], [82, 68, 62]],
    [8, [26, 38, 53], [42, 54, 68], [70, 74, 78]],
    [25, [28, 41, 57], [44, 57, 72], [64, 72, 80]],
    [90, [28, 41, 57], [44, 57, 72], [64, 72, 80]],
  ];
  function skyCols(alt, cloud) {
    let i = 0;
    while (i < SKYK.length - 2 && alt > SKYK[i + 1][0]) i++;
    const [a0, ...c0] = SKYK[i], [a1, ...c1] = SKYK[i + 1];
    const k = clamp((alt - a0) / (a1 - a0), 0, 1);
    const cols = c0.map((c, j) => mix(c, c1[j], k));
    // Overcast flattens the gradient toward one grey of the same lightness.
    const ov = clamp((cloud - 40) / 60, 0, 1) * 0.75;
    return cols.map((c) => { const l = Math.round(c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15); return mix(c, [l, l + 3, l + 6], ov); });
  }
  const skyXY = (az, alt) => [756 + az * (756 / 80), YH - alt * 8.6];
  const STARS = (() => { seed = 41; return Array.from({ length: 320 }, () => [rnd() * W, rnd() * (YH - 30), 0.35 + rnd() * 0.9, rnd()]); })();
  function drawMoon(g, x, y, r, frac, rot, a) {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.fillStyle = `rgba(70,78,90,${0.55 * a})`;
    g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
    g.beginPath();
    g.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    const ex = r * Math.abs(1 - 2 * frac);
    if (frac < 0.5) g.ellipse(0, 0, ex, r, 0, Math.PI / 2, -Math.PI / 2, true);
    else g.ellipse(0, 0, ex, r, 0, Math.PI / 2, (3 * Math.PI) / 2, false);
    g.fillStyle = `rgba(236,238,232,${a})`; g.fill();
    g.restore();
  }
  let SKYC = null;   // the current sky colours, shared with the fog band and the plain
  // The sky is the stage's own CSS background, not a canvas. A 2x canvas is kept by WebKit in
  // two or three surfaces (measured in the host with `footprint`: 12.8 MB each, three for the
  // old sky canvas); the stage's background paints into the page's root tiles, which exist
  // anyway. Stars are 4 px gradient tiles, one per star; the moon's disc, the one shape CSS
  // cannot draw, is a 28 px canvas. Repainted only when the string changes (each minute at
  // most, through dusk and dawn; at night not at all).
  const moonC = $("moon"), MOON_R = 14;
  moonC.width = moonC.height = 2 * MOON_R * DPR;
  const rg = (x, y, r0, r1, c, a, box = `0 0 / ${W}px ${YH + 62}px`) =>
    `radial-gradient(circle ${r1.toFixed(1)}px at ${x.toFixed(1)}px ${y.toFixed(1)}px, ${rgba(c, +a.toFixed(3))} ${r0}px, ${rgba(c, 0)} ${r1.toFixed(1)}px) ${box} no-repeat`;
  function paintSky(L, A, alt) {
    const cf = L.cloud / 100;
    const [z, m, h] = skyCols(alt, L.cloud);
    const hz = L.fog ? mix(h, [70, 78, 84], 0.6) : h;
    SKYC = { z, m, h: hz };
    const bg = [];                                   // top first
    const night = clamp((-alt - 4) / 10, 0, 1);
    let moon = null;
    if (A) {
      const [sx, sy] = skyXY(A.sun.az, alt);
      const mo = A.moon;
      if (mo.alt > -0.5) {
        const [mx, my] = skyXY(mo.az, mo.alt);
        const vis = (1 - 0.85 * cf) * (L.fog ? 0.3 : 1) * (0.55 + 0.45 * night);
        if (mx > 20 && mx < W - 20 && vis > 0.04) {
          bg.push(rg(mx, my, 3, 70 + 40 * cf, [214, 222, 232], 0.22 * vis * (0.3 + mo.fraction)));
          if (cf < 0.92) moon = { mx, my, f: mo.fraction, rot: Math.atan2(sy - my, sx - mx), a: clamp(vis * 1.1, 0, 1) };
        }
      }
      // The sun: a disc when the deck lets it through, and a glow while it is near or above the horizon.
      if (alt > -0.5 && cf < 0.9 && sx > -20 && sx < W + 20) {
        const a = 1 - cf;
        bg.push(`radial-gradient(circle 40px at ${sx.toFixed(1)}px ${sy.toFixed(1)}px, rgba(255,248,236,${(0.95 * a).toFixed(3)}) 6.4px, rgba(255,246,228,${(0.5 * a).toFixed(3)}) 7.4px, rgba(255,246,228,0) 40px) 0 0 / ${W}px ${YH + 62}px no-repeat`);
      }
      const glow = clamp((alt + 9) / 12, 0, 1) * (alt > 14 ? 0.6 : 1) * (1 - 0.5 * cf);
      if (glow > 0.01) bg.push(rg(sx, Math.max(sy, YH - 30), 4, 460, alt < 8 ? [255, 176, 120] : [255, 236, 214], 0.36 * glow));
    }
    // Stars where the sky is dark and clear: each a 4 px tile, its edge soft over a pixel.
    const sv = night * clamp((80 - L.cloud) / 60, 0, 1) * (L.fog ? 0 : 1);
    if (sv > 0.02) {
      for (const [x, y, r, b] of STARS) {
        const k = sv * (0.25 + 0.75 * b) * clamp((YH - 20 - y) / 120, 0, 1);
        if (k < 0.04) continue;
        const c = `226,232,240,`;
        bg.push(`radial-gradient(circle ${(r + 0.5).toFixed(2)}px at 2px 2px, rgba(${c}${k.toFixed(2)}) ${Math.max(0, r - 0.5).toFixed(2)}px, rgba(${c}0) ${(r + 0.5).toFixed(2)}px) ${(x - 2).toFixed(1)}px ${(y - 2).toFixed(1)}px / 4px 4px no-repeat`);
      }
    }
    // Town light under the deck: low and wide, stronger the thicker the cloud.
    const town = night * (0.35 + 0.65 * cf) * (L.fog ? 1.3 : 1);
    if (town > 0.02) bg.push(rg(1000, YH + 40, 10, 700, [150, 128, 104], 0.2 * town));
    bg.push(`linear-gradient(${rgba(z, 1)} 0, ${rgba(m, 1)} ${0.55 * YH}px, ${rgba(hz, 1)} ${0.93 * YH}px, ${rgba(mix(hz, FOG, 0.35), 1)} ${YH}px) 0 0 / ${W}px ${YH + 62}px no-repeat`);
    const css = bg.join(",");
    if (stage._bg !== css) { stage._bg = css; stage.style.background = css + ", #080b0e"; }
    // the moon's disc
    show(moonC, !!moon);
    if (moon) {
      const g = moonC.getContext("2d");
      g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, 2 * MOON_R, 2 * MOON_R);
      drawMoon(g, MOON_R, MOON_R, 9, moon.f, moon.rot, moon.a);
      moonC.style.transform = `translate(${(moon.mx - MOON_R).toFixed(1)}px,${(moon.my - MOON_R).toFixed(1)}px)`;
    }
  }

  // The cloud deck: value noise that tiles across 1512 px, drawn at half resolution.
  let cloudKey = "";
  function makeClouds(L, alt) {
    // Under 15% cover the deck draws almost nothing: no layer at all, and nothing to drift.
    const on = !!L.fog || L.cloud >= 15, c = $("clouds").firstElementChild;
    show($("clouds"), on);
    if (!on) { if (c.width) c.width = c.height = 0; cloudKey = ""; return; }
    const key = `${L.kind}|${Math.round(L.cloud / 10)}|${alt > 4 ? "d" : alt > -8 ? "t" : "n"}`;
    if (key === cloudKey) return;
    cloudKey = key;
    const w = 756, h = 240;
    c.width = w * 2; c.height = h;
    const x = c.getContext("2d"), img = x.createImageData(w, h);
    seed = 11;
    const oct = [[8, 0.55], [16, 0.3], [32, 0.15]].map(([s, wt]) => ({ s, wt, a: Array.from({ length: s * (s + 2) }, rnd) }));
    const sm = (t) => t * t * (3 - 2 * t);
    const cover = L.cloud / 100;
    const thr = L.fog ? 0.15 : 0.78 - cover * 0.5;
    const col = alt > 4 ? [132, 140, 148] : alt > -8 ? [140, 126, 118] : [120, 126, 132];
    const cap = L.fog ? 100 : alt > 4 ? 95 : 150;
    for (let yy = 0; yy < h; yy++) {
      const ky = yy / h;
      for (let xx = 0; xx < w; xx++) {
        let v = 0;
        for (const o of oct) {
          const fx = (xx / w) * o.s, fy = ky * o.s * 0.35, ix = fx | 0, iy = fy | 0, tx = sm(fx - ix), ty = sm(fy - iy);
          const i0 = ix % o.s, i1 = (ix + 1) % o.s, r0 = iy * o.s, r1 = (iy + 1) * o.s;
          const a = o.a[r0 + i0], b = o.a[r0 + i1], cc = o.a[r1 + i0], d = o.a[r1 + i1];
          v += o.wt * (a + (b - a) * tx + (cc - a) * ty + (a - b - cc + d) * tx * ty);
        }
        const i = (yy * w + xx) * 4;
        img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2];
        const band = L.fog ? Math.pow(ky, 2.2) * 1.4 : 0.3 + ky * 0.9;
        img.data[i + 3] = clamp((v - thr) * 260 * band, 0, cap);
      }
    }
    x.putImageData(img, 0, 0);
    x.drawImage(c, 0, 0, w, h, w, 0, w, h);
  }

  // ---------- the gate ----------------------------------------------------------
  // The weekly limit as an arc standing beyond the horizon: 0% at the left foot, 100% at the
  // right. Outside it runs the week's own time, reset to reset, with a tick at each midnight
  // and the elapsed part lit; the gap between the two is the pace, without a forecast.
  const GC = { cx: 756, cy: YH + 18, r: 400 };
  const gAng = (f) => Math.PI + Math.PI * f;
  const onG = (f, rr) => [GC.cx + Math.cos(gAng(f)) * rr, GC.cy + Math.sin(gAng(f)) * rr];
  const gateLbl = pool("f gl");
  let gateKey = "";
  // The canvas holds the arc, its ticks and the week's time ring; the lit band is its own
  // layer (below), so a new percentage repaints nothing.
  function paintGate(W7, t) {
    const el = W7 ? clamp((t - W7.start) / (7 * 86400), 0, 1) : 0;
    const key = `${(el * 2400).toFixed(0)}|${W7 ? W7.lastClose : ""}|${W7 ? W7.start : ""}`;
    if (key === gateKey) return;
    gateKey = key;
    const g = GATE.g; GATE.reset();
    const { cx, cy, r } = GC;
    g.lineCap = "butt";
    g.strokeStyle = "rgba(170,186,200,.05)"; g.lineWidth = 28;
    g.beginPath(); g.arc(cx, cy, r, Math.PI, 2 * Math.PI); g.stroke();
    g.strokeStyle = "rgba(200,212,224,.42)"; g.lineWidth = 1.2;
    g.beginPath(); g.arc(cx, cy, r + 5, Math.PI, 2 * Math.PI); g.stroke();
    g.strokeStyle = "rgba(200,212,224,.24)"; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, r - 5, Math.PI, 2 * Math.PI); g.stroke();
    for (let p = 0; p <= 100; p += 5) {
      const major = p % 25 === 0, L = major ? 16 : 7;
      g.strokeStyle = major ? "rgba(223,230,236,.72)" : "rgba(200,212,224,.36)";
      g.lineWidth = major ? 1.4 : 1;
      line(g, [onG(p / 100, r - 5), onG(p / 100, r - 5 - L)]); g.stroke();
    }
    // the week's time, outside the arc
    g.strokeStyle = "rgba(200,212,224,.16)"; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, r + 12, Math.PI, 2 * Math.PI); g.stroke();
    if (W7) {
      g.strokeStyle = "rgba(232,238,243,.8)"; g.lineWidth = 1.6;
      g.beginPath(); g.arc(cx, cy, r + 12, gAng(0), gAng(el)); g.stroke();
      for (let d = midnightOf(W7.start) + 86400; d < W7.start + 7 * 86400; d = midnightOf(d + 86400 + 7200)) {
        const f = (d - W7.start) / (7 * 86400);
        g.strokeStyle = "rgba(214,222,230,.55)"; g.lineWidth = 1;
        line(g, [onG(f, r + 8), onG(f, r + 17)]); g.stroke();
      }
      // now: a small blade pointing in at the time ring
      const a = gAng(el), [nx, ny] = onG(el, r + 13);
      g.save(); g.translate(nx, ny); g.rotate(a + Math.PI / 2);
      g.fillStyle = "rgba(244,247,250,.95)";
      g.beginPath(); g.moveTo(0, 3); g.lineTo(-4, -8); g.lineTo(4, -8); g.closePath(); g.fill();
      g.restore();
    }
    if (W7 && W7.lastClose != null) {
      g.strokeStyle = "rgba(223,230,236,.6)"; g.setLineDash([2, 3]); g.lineWidth = 1.2;
      line(g, [onG(W7.lastClose / 100, r + 4), onG(W7.lastClose / 100, r - 30)]); g.stroke();
      g.setLineDash([]);
    }
    // labels; each keeps its box, so the "used" label can find room and these can yield to it
    const box = (e, x, y, w, h, ax, ay) => { e._box = [x - ax * w, y - ay * h, x + (1 - ax) * w, y + (1 - ay) * h]; };
    for (const p of [25, 50, 75]) {
      const [x, y] = onG(p / 100, r - 34), e = gateLbl.get("p" + p);
      txt(e, p + "%"); place(e, x, y, 0.5, 0.5); box(e, x, y, textW(p + "%", 11), 14, 0.5, 0.5);
    }
    if (W7) {
      for (let d = midnightOf(W7.start); d < W7.start + 7 * 86400; d = midnightOf(d + 86400 + 7200)) {
        const s0 = Math.max(d, W7.start), s1 = Math.min(midnightOf(d + 86400 + 7200), W7.start + 7 * 86400);
        if (s1 - s0 < 5 * 3600) continue;            // too short a sliver to name
        const f = ((s0 + s1) / 2 - W7.start) / (7 * 86400), [x, y] = onG(f, r + 29);
        const e = gateLbl.get("d" + d); txt(e, WD(d + 3600)); place(e, x, y, 0.5, 0.5); box(e, x, y, textW(WD(d + 3600), 11), 14, 0.5, 0.5);
      }
      if (W7.lastClose != null) {
        const [x, y] = onG(W7.lastClose / 100, r + 22);
        const e = gateLbl.get("close"); e.className = "lb f gl";
        html(e, `last week<br>closed at ${W7.lastClose}%`); place(e, x + 10, y, 0, 0.5); box(e, x + 10, y, textW(`closed at ${W7.lastClose}%`, 11), 30, 0, 0.5);
      }
    }
    gateLbl.sweep();
    usedKey = "";                                    // the yielding labels were re-placed
  }

  // The lit band: drawn once as the LOWER half of the ring, on its own layer, then rotated
  // about the gate's centre by pct × 180°. The layer is clipped at the horizon, so what
  // shows is exactly the arc from the left foot to the percentage; a change of value is a
  // rotate transition on the compositor (var(--kiln-tween)), never a repaint. The canvas
  // reaches BM px past the tip so the glow around the band's end is kept.
  const bandBox = $("band"), bandC = bandBox.firstElementChild, BR = GC.r + 30, BM = 28;
  {
    bandBox.style.cssText = `left:${GC.cx - BR}px;top:${GC.cy - BR}px;width:${2 * BR}px;height:${YH - (GC.cy - BR)}px`;
    bandC.style.cssText = `top:${BR - BM}px;width:${2 * BR}px;height:${BR + BM}px;transform-origin:50% ${BM}px`;
    bandC.width = 2 * BR * DPR; bandC.height = (BR + BM) * DPR;
    const g = bandC.getContext("2d");
    g.setTransform(DPR, 0, 0, DPR, 0, BM * DPR); g.lineCap = "butt";
    g.shadowColor = "rgba(244,189,110,.85)"; g.shadowBlur = 20;
    g.strokeStyle = "#f4bd6e"; g.lineWidth = 9;
    g.beginPath(); g.arc(BR, 0, GC.r, 0, Math.PI); g.stroke();
    g.shadowBlur = 0;
    g.strokeStyle = "rgba(255,238,206,.95)"; g.lineWidth = 2;
    g.beginPath(); g.arc(BR, 0, GC.r, 0, Math.PI); g.stroke();
  }
  function setBand(pct) {
    const k = `rotate(${(clamp(pct, 0, 100) * 1.8).toFixed(2)}deg)`;
    if (bandC._k !== k) { bandC._k = k; bandC.style.transform = k; }
    show(bandBox, pct > 0.05);
  }

  // ---------- the "used" label: at the band's tip, clear of every text block ------------
  // Text widths come from canvas measureText (no layout reads), padded 10% for the
  // stretched face. Hard obstacles are every block that may not move; the scale numerals,
  // day names and last week's note yield (hide) when the label needs their place.
  const MC = document.createElement("canvas").getContext("2d");
  const widths = new Map();
  function textW(s, px, wt = 400) {
    const k = `${wt} ${px}|${s}`;
    let w = widths.get(k);
    if (w == null) {
      MC.font = `${wt} ${px}px Archivo, sans-serif`;
      w = MC.measureText(s).width * 1.1;
      if (document.fonts && document.fonts.check(`${wt} ${px}px Archivo`)) { if (widths.size > 4000) widths.clear(); widths.set(k, w); }
    }
    return w;
  }
  const plain = (h) => h.replace(/<br>/g, "\n").replace(/<[^>]+>/g, "");
  // the fixed blocks, in stage px (measured from the rendered page; see notes.md)
  const FIXED = [[86, 40, 425, 150], [86, 170, 334, 470], [1190, 40, 1512, 336], [1335, 346, 1512, 982], [663, 0, 848, 34]];
  const used = mk("lb v warm gl used"), leader = mk("ldr");
  show(leader, false);
  let usedKey = "", obstacles = [];
  const hit = (a, b, m = 4) => a[0] < b[2] + m && a[2] > b[0] - m && a[1] < b[3] + m && a[3] > b[1] - m;
  // The label's box at fraction f, inside the arc (out = false) or beyond the time ring:
  // its nearest corner or edge touches the circle, on the radial line (a square-normalised
  // normal, so it slides smoothly from beside the tip on the flanks to below it at the top).
  function usedBox(f, out, w, h) {
    const a = gAng(f), ux = Math.cos(a), uy = Math.sin(a), s = out ? 1 : -1;
    const rr = out ? GC.r + 22 : GC.r - 24, m = Math.max(Math.abs(ux), Math.abs(uy));
    const cx = GC.cx + ux * rr + (s * ux / m) * (w / 2), cy = Math.min(GC.cy + uy * rr + (s * uy / m) * (h / 2), YH - 40);
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  }
  function placeUsed(pct) {
    const s = `${Math.round(pct)}% used`, w = textW(s, 14, 500), h = 16, p = clamp(pct, 0, 100) / 100;
    // keyed coarsely: the countdown's width wobbles every second by a pixel or two
    const key = `${s}|${p.toFixed(4)}|${obstacles.map((b) => b.map((v) => Math.round(v / 6)).join()).join(";")}`;
    if (key === usedKey) return;
    usedKey = key;
    txt(used, s);
    // The hairline from the tip to the label's nearest point, drawn when the label had to
    // move along the arc; sampled every 4 px, so it can be tested against text boxes.
    const leaderOf = (b, f, out) => {
      const [tx, ty] = onG(p, out ? GC.r + 20 : GC.r - 22);
      const nx = clamp(tx, b[0], b[2]), ny = clamp(ty, b[1], b[3]), len = Math.hypot(nx - tx, ny - ty);
      return { tx, ty, nx, ny, len, drawn: Math.abs(f - p) > 0.005 && len > 8 };
    };
    const crosses = (L, bx, m = 2) => {
      const n = Math.ceil(L.len / 4);
      for (let i = 0; i <= n; i++) {
        const x = lerp(L.tx, L.nx, i / n), y = lerp(L.ty, L.ny, i / n);
        if (x > bx[0] - m && x < bx[2] + m && y > bx[1] - m && y < bx[3] + m) return true;
      }
      return false;
    };
    // nearest free spot to the tip, trying the inside first: 0, -0.25%, +0.25%, -0.5%...
    // A spot whose hairline would run through fixed text is not free either (in the host a
    // leader grazed the start of "forecasts start …").
    let pick = null;
    for (let k = 0; k <= 160 && !pick; k++) {
      const f = p + (k ? (k & 1 ? -1 : 1) * Math.ceil(k / 2) * 0.0025 : 0);
      if (f < 0 || f > 1) continue;
      for (const out of [false, true]) {
        const b = usedBox(f, out, w, h);
        if (b[0] < 70 || b[2] > W - 8 || b[1] < 36) continue;
        if (obstacles.some((o) => hit(b, o))) continue;
        const L = leaderOf(b, f, out);
        if (L.drawn && obstacles.some((o) => crosses(L, o))) continue;
        pick = { f, out, b }; break;
      }
    }
    if (!pick) pick = { f: p, out: false, b: usedBox(p, false, w, h) };
    const { b, f, out } = pick, ux = Math.cos(gAng(f));
    // anchor on the edge nearest the arc, so a short estimate never pulls the text away
    const ax = Math.abs(ux) < 0.3 ? 0.5 : (ux < 0) !== out ? 0 : 1;
    place(used, b[0] + ax * (b[2] - b[0]), (b[1] + b[3]) / 2, ax, 0.5);
    const { tx, ty, nx, ny, len, drawn } = leaderOf(b, f, out);
    const lk = drawn ? `translate(${tx.toFixed(1)}px,${ty.toFixed(1)}px) rotate(${Math.atan2(ny - ty, nx - tx).toFixed(4)}rad) scaleX(${((len - 3) / 100).toFixed(3)})` : "";
    if (leader._k !== lk) { leader._k = lk; if (lk) leader.style.transform = lk; show(leader, !!lk); }
    // the yielding labels under it, or crossed by its hairline, hide; the rest show
    const L = { tx, ty, nx, ny, len };
    for (const e of LB.querySelectorAll(".gl:not(.used)")) {
      const v = e._box && (hit(e._box, b, 3) || (drawn && crosses(L, e._box))) ? "hidden" : "";
      if (e.style.visibility !== v) e.style.visibility = v;
    }
  }

  // ---------- the far range: the fortnight along the horizon ------------------------
  // x runs from the first midnight of analytics.days (left) to now at the vanishing point.
  const PX0 = 84, RANGE_H = 46;
  const dayLbls = pool("f dl"), ghLbls = pool("k gh");
  let farKey = "", farBoxes = [], dayBoxes = [];
  function paintFar(s, L, W7) {
    const an = s.analytics, t = s.t;
    const key = `${an && an.built_at}|${s.github && s.github.fetched_at}|${Math.floor(t / 60)}|${L.kind}|${W7 && W7.start}|${SKYC && SKYC.h}`;
    if (key === farKey) return;
    farKey = key;
    const g = FAR.g; FAR.reset();
    // the fog band where the plain meets the sky
    const hz = SKYC ? SKYC.h : [44, 50, 56];
    const fb = g.createLinearGradient(0, YH - 28, 0, YH + 30);
    fb.addColorStop(0, rgba(mix(hz, FOG, 0.4), 0)); fb.addColorStop(0.5, rgba(mix(hz, FOG, 0.5), L.fog ? 0.55 : 0.4)); fb.addColorStop(1, rgba(FOG, 0));
    g.fillStyle = fb; g.fillRect(0, YH - 28, W, 58);
    const days = (an && an.days) || [];
    if (!days.length) { dayLbls.sweep(); ghLbls.sweep(); return; }
    const T0 = dateT(days[0].date), X = (u) => PX0 + ((u - T0) / (t - T0)) * (VPX - PX0);
    // hourly output as tokens a minute; the hour in progress over its own elapsed minutes
    const pts = [];
    for (const d of days) {
      (d.hours || []).forEach((v, h) => {
        const s0 = dateT(d.date, h);
        if (s0 >= t) return;
        const mins = Math.max(1, Math.min(60, (t - s0) / 60));
        pts.push([s0 + Math.min(3600, t - s0) / 2, v / mins]);
      });
    }
    const top = nice(Math.max(1, ...pts.map((p) => p[1])));
    const Y = (v) => YH - (v / top) * RANGE_H;
    const fogOld = (x) => clamp(1 - (x - PX0) / (VPX - PX0), 0, 1) * (L.fog ? 1 : 0.6);
    // silhouette
    g.beginPath(); g.moveTo(X(T0), YH);
    for (const [u, v] of pts) g.lineTo(X(u), Y(v));
    g.lineTo(VPX, YH); g.closePath();
    const sil = g.createLinearGradient(PX0, 0, VPX, 0);
    sil.addColorStop(0, rgba(mix([24, 30, 37], hz, 0.55), 1)); sil.addColorStop(1, rgba(mix([16, 21, 27], hz, 0.2), 1));
    g.fillStyle = sil; g.fill();
    // crest, brightening toward the present
    g.lineJoin = "round"; g.lineWidth = 1.1;
    for (let i = 1; i < pts.length; i++) {
      const x0 = X(pts[i - 1][0]), x1 = X(pts[i][0]);
      const k = fogOld(x1);
      g.strokeStyle = rgba(mix([226, 233, 240], FOG, k * 0.6), 0.9 - k * 0.35);
      line(g, [[x0, Y(pts[i - 1][1])], [x1, Y(pts[i][1])]]); g.stroke();
    }
    // midnights, and the two weekly resets inside the fortnight
    for (const d of days) {
      const x = X(dateT(d.date));
      g.strokeStyle = "rgba(200,212,224,.42)"; g.lineWidth = 1;
      line(g, [[x, YH - 4], [x, YH + 5]]); g.stroke();
    }
    if (W7) {
      for (const r of [W7.start, W7.start - 7 * 86400]) {
        if (r < T0 || r > t) continue;
        const x = X(r);
        g.strokeStyle = "rgba(244,189,110,.75)"; g.lineWidth = 1.2;
        line(g, [[x, YH + 4], [x, YH - RANGE_H - 12]]); g.stroke();
        g.fillStyle = "rgba(255,214,150,.95)"; g.fillRect(x - 1.5, YH - RANGE_H - 14, 3, 3);
      }
    }
    // day names and totals under the horizon
    const peak = days.slice(0, -1).reduce((a, b) => (b.out > (a ? a.out : -1) ? b : a), null);
    let prevR = -Infinity;                           // the right edge of the label before
    dayBoxes = [];
    days.forEach((d, i) => {
      const s0 = dateT(d.date), s1 = Math.min(t, dateT(d.date) + 86400);
      const today = i === days.length - 1;
      const e = dayLbls.get(d.date);
      const nm = today ? "today" : `${WD(s0 + 3600)} ${dt(s0 + 3600).getDate()}`, tot = F.tokens(d.out);
      html(e, `${nm}<br><span class="${today ? "warm" : d === peak ? "pk" : ""}">${tot}</span>`);
      // Centred on its day; just after midnight today's sliver is a few px wide and its
      // label ran into yesterday's (seen in the host at 12:52 am), so it steps right.
      const hw = Math.max(textW(nm, 11), textW(tot, 11)) / 2;
      const x = Math.max((X(s0) + X(s1)) / 2, prevR + 10 + hw);
      prevR = x + hw;
      place(e, x, YH + 9, 0.5, 0);
      dayBoxes.push([x - hw, YH + 9, x + hw, YH + 39]);
    });
    dayLbls.sweep();
    // GitHub events at their real times: posts above the range, the newest three named
    const gh = s.github;
    farBoxes = []; ghPlaced = [];
    const rec = ((gh && gh.recent) || []).filter((r) => r.at >= T0 && r.at <= t).sort((a, b) => b.at - a.at);
    rec.forEach((r, i) => {
      const x = X(r.at), ytop = YH - RANGE_H - 12 - (i < 3 ? (2 - i) * 16 : 0);
      g.strokeStyle = "rgba(214,222,230,.55)"; g.lineWidth = 1;
      line(g, [[x, YH - 2], [x, ytop]]); g.stroke();
      g.fillStyle = "rgba(240,244,248,.95)";
      g.beginPath(); g.moveTo(x, ytop - 3); g.lineTo(x + 3, ytop); g.lineTo(x, ytop + 3); g.lineTo(x - 3, ytop); g.closePath(); g.fill();
      if (i < 3) {
        const e = ghLbls.get(r.type + r.at), tail = `, ${age(t - r.at)} ago`;
        html(e, `${esc(r.text)}<span class="f">${tail}</span>`);
        place(e, x - 8, ytop, 1, 0.5);
        farBoxes.push([x - 8 - textW(String(r.text), 12) - textW(tail, 11), ytop - 8, x - 8, ytop + 8]);
        ghPlaced.push([e, farBoxes[farBoxes.length - 1]]);
      }
    });
    ghLbls.sweep();
    ghYield();
  }
  // A running agent's name over its column outranks a GitHub event's name: where the two
  // would overlap (the host, 2026-11-05: "designer, 13 m" struck through "created branch …")
  // the event's name hides, and comes back when the column moves or sinks. Its post stays.
  let ghPlaced = [];
  // st.box is sized when the column is placed, often from the type alone ("designer"); the
  // label then grows its age (", 13 m"), so the box is re-sized from the text it shows
  function nameBox(st) {
    const b = st.box, w = textW(st.lbl.textContent || st.type || "", 11);
    const x0 = st.side > 0 ? b[0] : st.side < 0 ? b[2] - w : (b[0] + b[2] - w) / 2;
    return [x0, b[1], x0 + w, b[3]];
  }
  function ghYield() {
    const boxes = [];
    for (const st of agentState.values()) {
      if (!st.alive || !st.box || st.lbl.style.visibility === "hidden") continue;
      boxes.push(nameBox(st));
    }
    for (const [e, b] of ghPlaced) {
      const v = boxes.some((c) => hit(c, b, 3)) ? "hidden" : "";
      if (e.style.visibility !== v) e.style.visibility = v;
    }
  }
  // The weekly forecast in the left wing outranks a running agent's name in turn: where a
  // name would sit on a wing row (the host, 2026-11-05: "reviewer, 5 m" over "runs out Sat
  // 7 Nov 1:16 am") the name hides, and comes back when the column moves or the wing
  // changes. Its column stays. Compared by the name's glyphs, not its 14.5 px line, so a
  // name that only touches the row under it keeps its place.
  let wingBoxes = [];
  function wingYield() {
    for (const st of agentState.values()) {
      if (!st.lbl) continue;
      const b = st.alive && st.box ? nameBox(st) : null, core = b && [b[0], b[1] + 3, b[2], b[3] - 3];
      const v = core && wingBoxes.some((c) => hit(c, core, 0)) ? "hidden" : "";
      if (st.lbl.style.visibility !== v) st.lbl.style.visibility = v;
    }
  }

  // ---------- the plain ---------------------------------------------------------
  // The plain itself: gradients and reflections only, so it lives on a 1x canvas. The lane
  // floors, grid and now edge are drawn with the ridges (paintLaneGround).
  let lanesN = 0, groundKey = "";
  function paintGround(L, pct) {
    const key = `${pct.toFixed(1)}|${L.kind}|${SKYC && SKYC.h}|${L.snowCover}|${L.rain > 0}`;
    if (key === groundKey) return;
    groundKey = key;
    const g = GROUND.g; GROUND.reset();
    const hz = SKYC ? SKYC.h : [44, 50, 56];
    const gg = g.createLinearGradient(0, YH, 0, H);
    gg.addColorStop(0, rgba(mix(hz, [54, 62, 70], 0.5), 1));
    gg.addColorStop(0.07, "rgb(27,33,39)"); gg.addColorStop(0.4, "rgb(14,18,23)"); gg.addColorStop(1, "rgb(8,10,13)");
    g.fillStyle = gg; g.fillRect(0, YH, W, H - YH);
    // standing water mirrors the town light and the lit part of the gate
    const wet = L.rain > 0 ? 1 : L.snow ? 0.3 : 0.6;
    const sh = g.createRadialGradient(1000, YH, 4, 1000, YH, 560);
    sh.addColorStop(0, `rgba(130,118,104,${0.18 * wet})`); sh.addColorStop(1, "rgba(130,118,104,0)");
    g.fillStyle = sh; g.fillRect(0, YH, W, H - YH);
    const [x0] = onG(0, GC.r), [x1, y1] = onG(clamp(pct, 0, 100) / 100, GC.r);
    if (pct > 0.05) {
      const dp = (YH - y1) * 1.1 * wet + 8;
      const rf = g.createLinearGradient(0, YH, 0, YH + dp);
      rf.addColorStop(0, `rgba(244,189,110,${0.3 * wet})`); rf.addColorStop(1, "rgba(244,189,110,0)");
      g.fillStyle = rf; g.fillRect(x0 - 4, YH + 1, Math.max(6, x1 - x0 + 10), dp);
    }
    if (L.snowCover) { g.fillStyle = `rgba(206,214,222,${0.1 * L.snowCover})`; g.fillRect(0, YH, W, H - YH); }
  }
  function paintLaneGround(g, ls) {
    const { bF, bB } = edges(ls), step = (bB - bF) / ls.length / 2;
    // the ground grid: lines along time, out to the horizon
    g.lineWidth = 1;
    for (let b = bF - step * 4; b <= bB + step * 6; b += step) {
      const pts = [];
      for (let m = 0; m <= 60; m += 2) pts.push(at(m, b));
      for (let m = 80; m <= 4000; m *= 1.5) pts.push(at(m, b));
      line(g, pts); g.strokeStyle = `rgba(150,166,180,${b >= bF - 0.01 && b <= bB + 0.01 ? 0.07 : 0.04})`; g.stroke();
    }
    // lane floors, alternately toned so each lane reads as a track
    ls.forEach(({ b, w }, i) => {
      const A = at(0, b - w / 2), B = at(0, b + w / 2), C = at(60, b + w / 2), D = at(60, b - w / 2);
      const fl = g.createLinearGradient(A[0], A[1], (C[0] + D[0]) / 2, (C[1] + D[1]) / 2);
      const a = i % 2 ? 0.035 : 0.065;
      fl.addColorStop(0, `rgba(170,186,200,${a})`); fl.addColorStop(1, "rgba(170,186,200,0)");
      g.fillStyle = fl; line(g, [A, B, C, D]); g.closePath(); g.fill();
      g.strokeStyle = "rgba(170,186,200,.13)";
      line(g, [A, D]); g.stroke();
    });
    g.strokeStyle = "rgba(170,186,200,.13)"; line(g, [at(0, bB), at(60, bB)]); g.stroke();
    // cross lines at fixed ages: the land slides through them
    for (const m of [5, 10, 15, 20, 30, 45, 60]) {
      const major = m === 15 || m === 30 || m === 60;
      g.strokeStyle = `rgba(190,202,214,${major ? 0.2 : 0.09})`;
      line(g, [at(m, bF - EF), at(m, bB)]); g.stroke();
    }
    // the now edge: a line of sodium light across the lanes, spilling forward onto the plain
    const n0 = at(0, bF - EF), n1 = at(0, bB + EB);
    const spill = g.createLinearGradient(0, n1[1] - 10, 0, n0[1] + 34);
    spill.addColorStop(0, "rgba(255,203,128,0)"); spill.addColorStop(0.5, "rgba(255,203,128,.05)"); spill.addColorStop(1, "rgba(255,203,128,0)");
    g.fillStyle = spill;
    line(g, [n1, n0, at(-2.2, bF - EF), at(-2.2, bB + EB)]); g.closePath(); g.fill();
    g.lineCap = "round";
    g.strokeStyle = "rgba(255,203,128,.18)"; g.lineWidth = 7; line(g, [n0, n1]); g.stroke();
    g.strokeStyle = "rgba(255,222,170,.95)"; g.lineWidth = 1.5; line(g, [n0, n1]); g.stroke();
    g.lineCap = "butt";
  }

  // ---------- lanes: state, tweens, and the live paint ---------------------------------
  const lanes = new Map();            // sid -> lane
  let order = [];                     // sids, front to back; TOTAL is always last
  const TOTAL = "~total";
  let HS = HMAX / 4e4, scaleTop = 4e4;
  let lastMinute = null, view = null; // the latest derived figures the painters read
  const laneLbls = pool("r lane fade"), markLbls = pool("f mk"), scaleLbls = pool("f sc");
  const COL_TOP = YH - RANGE_H - 22;   // agent columns stop just above the far range
  function laneOf(sid) { return lanes.get(sid); }
  // kind "bg": hosted by Claude Code's daemon, no window. A missing kind is interactive.
  const isBg = (x) => !!x && x.kind === "bg";
  const BG_WORD = { waiting: "waiting", failed: "failed", working: "working", background: "with agents running", idle: "idle" };
  function bgNote(bg) {
    if (!bg.length) return "";
    const c = {};
    bg.forEach((x) => { const k = BG_WORD[x.state] ? x.state : "idle"; c[k] = (c[k] || 0) + 1; });
    const ks = Object.keys(BG_WORD).filter((k) => c[k]);
    return ks.length === 1 ? `${bg.length} in the background, ${BG_WORD[ks[0]]}`
      : `${bg.length} in the background: ${ks.map((k) => `${c[k]} ${BG_WORD[k]}`).join(", ")}`;
  }

  function updateLanes(s) {
    const c = s.claude || {}, sess = (c.sessions || []).filter((x) => x && x.sid);
    const minute = Math.floor(s.t / 60);
    const shift = lastMinute == null ? 0 : clamp(minute - lastMinute, 0, 60);
    lastMinute = minute;
    // order: interactive sessions in front of background ones; the first sight sorts working
    // sessions first; a later arrival joins the back of its own kind
    const live = new Set(sess.map((x) => x.sid)), bgSid = new Set(sess.filter(isBg).map((x) => x.sid));
    if (!order.length) {
      order = sess.slice().sort((a, b) => isBg(a) - isBg(b) || (a.state === "working" ? 0 : 1) - (b.state === "working" ? 0 : 1) || (b.out_15m || 0) - (a.out_15m || 0) || String(a.name).localeCompare(b.name)).map((x) => x.sid);
    } else {
      for (const x of sess) {
        if (order.includes(x.sid)) continue;
        const firstBg = isBg(x) ? -1 : order.findIndex((sid) => bgSid.has(sid));
        if (firstBg < 0) order.push(x.sid); else order.splice(firstBg, 0, x.sid);
      }
    }
    order = order.filter((sid) => live.has(sid) || (lanes.get(sid) && lanes.get(sid).alive));
    const rows = order.filter((sid) => live.has(sid)).concat([TOTAL]);
    // Lanes are spaced evenly on screen, not in the world, so every label gets the same room:
    // lane i's now point sits LANE_GAP px above the one in front, and its depth follows.
    const n = rows.length, gap = n > 1 ? Math.min(LANE_GAP, LANES_SPAN / (n - 1)) : 0;
    const bAt = (i) => ((CAM.f * CAM.eye) / (NOW0[1] - i * gap - YH) - BZ) / BACK[1];
    const wAt = (i) => (n < 2 ? 0.3 : (bAt(i + 1) - bAt(i - 1)) / 2);
    const totalOpm = (c.tokens && c.tokens.out_per_min) || [];
    // targets
    for (const [sid, ln] of lanes) if (sid !== TOTAL && !live.has(sid)) { ln.alive = false; ln.aTo = 0; }
    rows.forEach((sid, i) => {
      let ln = lanes.get(sid);
      const src = sid === TOTAL ? { sid, out_per_min: totalOpm } : sess.find((x) => x.sid === sid);
      if (!ln) {
        ln = { sid, b: bAt(i), w: wAt(i), a: 0, aFrom: 0, aTo: 1, alive: true, cur: new Float32Array(60), from: new Float32Array(60), to: new Float32Array(60) };
        lanes.set(sid, ln);
      }
      ln.s = src; ln.alive = true; ln.aTo = 1; ln.bTo = bAt(i); ln.wTo = wAt(i); ln.idx = i;
    });
    // Values land once per update: a canvas redraw per frame was most of the measured cost.
    // At a minute rollover the series is shifted by the minutes that rolled, so nothing waves.
    for (const ln of lanes.values()) {
      ln.bFrom = ln.b; ln.aFrom = ln.a; ln.wFrom = ln.w; if (ln.wTo == null) ln.wTo = ln.w;
      const opm = (ln.s && ln.s.out_per_min) || [];
      for (let i = 0; i < 60; i++) ln.from[i] = i + shift < 60 ? ln.cur[i + shift] : 0;
      for (let i = 0; i < 60; i++) {
        ln.to[i] = ln.alive ? +opm[i] || 0 : ln.from[i];
        if (ln.to[i] !== ln.cur[i]) liveDirty = true;
      }
      ln.cur.set(ln.to);
    }
    // the height scale: grows at once, shrinks only when the hour has fallen well below it
    let mx = 1;
    for (const ln of lanes.values()) if (ln.alive) for (let i = 0; i < 60; i++) mx = Math.max(mx, ln.to[i]);
    const want = nice(mx);
    if (want > scaleTop || want < scaleTop * 0.45) scaleTop = want;
    if (HS !== HMAX / scaleTop) { HS = HMAX / scaleTop; liveDirty = true; }
    // A lane arriving or leaving re-spaces the field: the one motion left on the canvas, a
    // tween of a few frames, a few times an hour.
    const geomMoves = [...lanes.values()].some((ln) => Math.abs(ln.bFrom - ln.bTo) > 1e-4 || Math.abs(ln.wFrom - ln.wTo) > 1e-4 || Math.abs(ln.aFrom - ln.aTo) > 1e-3);
    if (geomMoves) {
      liveDirty = true;
      tw("geom", 0, 1, (k) => {
        for (const ln of lanes.values()) { ln.b = lerp(ln.bFrom, ln.bTo, k); ln.w = lerp(ln.wFrom, ln.wTo, k); ln.a = lerp(ln.aFrom, ln.aTo, k); }
        if (k >= 1) for (const [sid, ln] of [...lanes]) if (!ln.alive && ln.a <= 0.001) lanes.delete(sid);
        wantLive(k >= 1); placeRuler();
      }, MOTION ? 380 : 0);
    }
    lanesN = n;
  }
  let liveLast = 0, liveDirty = true, liveT = -1e9, liveSig = "", livePaints = 0;
  function wantLive(force) { const n = performance.now(); if (force || n - liveLast >= 50) { liveLast = n; paintLive(); } }
  // The live canvas is the largest paint per update, so it is rationed. A change of what is
  // drawn (weather, a session's state, the agents, the events) paints at once; new values
  // paint at most twice a second; the recession alone (16 px a minute at the now edge, about
  // one device pixel in 2 s) every 2 s. Measured in the host, painting it on every changed
  // line kept WebContent at 8.5% at 100 ms. Between paints the lane labels are rewritten once
  // a second.
  function maybePaintLive(t, newSec) {
    const sig = `${view.L.kind}|${(view.sessions || []).map((x) => x.sid + x.state).join()}|${view.agentSig}|${view.evSig}`;
    if (sig !== liveSig) { liveSig = sig; paintLive(); return; }
    if ((liveDirty && t - liveT >= 0.5) || t - liveT >= 2) paintLive();
    else if (newSec) paintLaneLabels(laneSet(), t);
  }
  function laneSet() { return [...lanes.values()].filter((ln) => ln.a > 0.001).sort((a, b) => a.b - b.b); }
  // the outer edges of the lane field, front (bF) and back (bB), in world units
  const edges = (ls) => ({ bF: ls[0].b - ls[0].w / 2, bB: ls[ls.length - 1].b + ls[ls.length - 1].w / 2 });

  // Age in minutes of the END of minute i (59 is the minute in progress, pinned to now).
  function ageOf(i, frac) { return i === 59 ? 0 : frac + (58 - i); }
  const WARM = [246, 200, 134], COOL = [208, 220, 232], CAUTION = [255, 166, 130];

  function paintLive() {
    if (!view) return;
    const g = LIVE.g; LIVE.reset();
    const t = view.t, frac = (t - Math.floor(t / 60) * 60) / 60;
    liveDirty = false; liveT = t; livePaints++;
    const ls = laneSet();
    if (!ls.length) return;
    const { bF, bB } = edges(ls);
    paintLaneGround(g, ls);
    g.lineJoin = "round";
    // ridges, back to front, so nearer silhouettes stand in front of farther ones
    for (let j = ls.length - 1; j >= 0; j--) {
      const ln = ls[j], b = ln.b, total = ln.sid === TOTAL;
      const warm = !total && ln.s && ln.s.state === "working";
      const col = total ? [196, 208, 220] : warm ? WARM : COOL;
      const top = [], base = [], vals = [];
      for (let i = 59; i >= 0; i--) {
        const m = ageOf(i, frac);
        if (m > 60) break;
        top.push(at(m, b, ln.cur[i] * HS)); base.push(at(m, b)); vals.push(ln.cur[i]);
      }
      if (top.length < 2) continue;
      const z = gnd(20, b)[1];
      g.globalAlpha = ln.a;
      const path = new Path2D();
      top.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
      for (let i = base.length - 1; i >= 0; i--) path.lineTo(base[i][0], base[i][1]);
      path.closePath();
      g.fillStyle = rgba(mix(total ? [26, 32, 40] : [12, 15, 19], FOG, fogK(z) * (total ? 0.9 : 0.6)), 0.96);
      g.fill(path);
      g.save(); g.clip(path);
      g.strokeStyle = rgba(col, warm ? 0.2 : 0.11); g.lineWidth = 12;
      line(g, top); g.stroke();
      g.restore();
      g.strokeStyle = rgba(col, 0.28); g.lineWidth = 1; line(g, base); g.stroke();
      // the crest: a soft under-stroke for glow, then the line; the minute in progress is dashed.
      // Only minutes with output are lit: a run of zero minutes is a dim floor line, so an idle
      // lane (or a "working" one that wrote nothing this hour) no longer draws a full-bright
      // stripe across the field (the host still at five sessions read as four white rails).
      // (a minute under 1% of the scale draws as flat as zero, and is drawn as zero)
      const runs = { lit: new Path2D(), flat: new Path2D() }, low = scaleTop * 0.01;
      let run = null;
      for (let k = 2; k < top.length; k++) {
        const kind = vals[k - 1] > low || vals[k] > low ? "lit" : "flat";
        if (kind !== run) { runs[kind].moveTo(top[k - 1][0], top[k - 1][1]); run = kind; }
        runs[kind].lineTo(top[k][0], top[k][1]);
      }
      g.strokeStyle = rgba(col, warm ? 0.22 : 0.12); g.lineWidth = warm ? 5 : 3.5; g.stroke(runs.lit);
      g.strokeStyle = rgba(col, 0.26); g.lineWidth = 1.1; g.stroke(runs.flat);
      g.strokeStyle = rgba(col, total ? 0.62 : warm ? 1 : 0.9); g.lineWidth = warm ? 1.8 : total ? 1.1 : 1.3;
      g.stroke(runs.lit);
      if (!(vals[0] > low || vals[1] > low)) g.strokeStyle = rgba(col, 0.26);
      g.setLineDash([2, 2]); line(g, top.slice(0, 2)); g.stroke(); g.setLineDash([]);
      // the peak minute of the hour, marked and valued
      let pi = -1, pv = 0;
      for (let i = 0; i < 59; i++) if (ln.cur[i] > pv) { pv = ln.cur[i]; pi = i; }
      ln.peak = pi >= 0 && pv > scaleTop * 0.12 ? { at: top[59 - pi], v: ln.to[pi], i: pi } : null;
      if (ln.peak && ln.peak.at) {
        g.fillStyle = rgba(col, 1); g.beginPath(); g.arc(ln.peak.at[0], ln.peak.at[1], 2.3, 0, 7); g.fill();
      }
      g.globalAlpha = 1;
    }
    // events on their lanes: finished turns as ground ticks, questions as posts
    const evs = view.events;
    for (const e of evs) {
      const ln = lanes.get(e.sid);
      if (!ln || ln.a < 0.01) continue;
      const m = (t - e.t) / 60;
      if (m < 0 || m > 60) continue;
      const b = ln.b - ln.w * 0.32, lw = ln.w;
      g.globalAlpha = ln.a * clamp((60 - m) / 4, 0, 1);
      if (e.kind === "done") {
        const [x, y] = at(m, b + lw * 0.1);
        g.fillStyle = "rgba(214,222,230,.5)"; g.beginPath(); g.arc(x, y, 1.1, 0, 7); g.fill();
      } else if (e.kind === "ask" || e.kind === "answered" || e.kind === "remind") {
        const [x, y] = at(m, b), [, yt] = at(m, b, e.kind === "remind" ? 0.04 : 0.09);
        g.strokeStyle = "rgba(223,230,236,.7)"; g.lineWidth = 1; line(g, [[x, y], [x, yt]]); g.stroke();
        g.fillStyle = e.kind === "answered" ? "rgba(236,241,245,.95)" : "#f4bd6e";
        g.fillRect(x - 1.5, yt - 1.5, 3, 3);
      }
    }
    // agents that finished inside the hour leave a faint trail on their lane
    for (const r of view.pastAgents) {
      const ln = lanes.get(r.sid);
      if (!ln || ln.a < 0.01) continue;
      const m0 = Math.min(60, (t - r.start) / 60), m1 = Math.max(0, (t - r.end) / 60);
      if (m1 > 60) continue;
      const b = ln.b - ln.w * 0.22, pts = [];
      for (let m = m1; m <= m0; m += 0.5) pts.push(at(m, b));
      pts.push(at(m0, b));
      g.globalAlpha = ln.a * 0.5;
      g.strokeStyle = r.gp ? rgba(CAUTION, 0.7) : "rgba(255,228,186,.6)"; g.lineWidth = 1.2; line(g, pts); g.stroke();
      g.globalAlpha = 1;
    }
    // running agents: a trail back to their start on the canvas; the column of light at now is
    // DOM (placeCol), so it rises and sinks on the compositor
    for (const ag of view.agentCols) {
      if (!ag.alive) continue;
      const ln = lanes.get(ag.sid) || ls[0];
      const b = ln.b - ln.w * 0.3 + ag.slot * ln.w * 0.16;
      placeCol(ag, at(0.35, b), COL_TOP - (ag.i % 3) * 17);
      if (ag.start == null) continue;                  // no start known: a column, no trail
      const col = ag.gp ? CAUTION : [255, 228, 186];
      const m0 = Math.min(60, Math.max(0, (t - ag.start) / 60));
      const trail = [];
      for (let m = 0; m <= m0; m += 0.5) trail.push(at(m, b));
      trail.push(at(m0, b));
      g.strokeStyle = rgba(col, 0.6); g.lineWidth = 1.8; line(g, trail); g.stroke();
      const [sx, sy] = at(m0, b);
      g.fillStyle = rgba(col, 0.95); g.beginPath(); g.arc(sx, sy, 2.4, 0, 7); g.fill();
    }
    wingYield(); ghYield();
    // the now pane: a sheet of glass standing on the now edge, ruled with the height scale
    const P0 = at(0, bF - EF), P1 = at(0, bB + EB), P2 = at(0, bB + EB, HMAX), P3 = at(0, bF - EF, HMAX);
    const pg = g.createLinearGradient(0, P3[1], 0, P0[1]);
    pg.addColorStop(0, "rgba(255,203,128,0)"); pg.addColorStop(1, "rgba(255,203,128,.07)");
    g.fillStyle = pg; line(g, [P0, P1, P2, P3]); g.closePath(); g.fill();
    const ticks = [0.25, 0.5, 0.75, 1].map((k) => k * scaleTop);
    for (const v of ticks) {
      const h = v * HS, a = at(0, bF - EF, h), b2 = at(0, bB + EB, h);
      g.strokeStyle = `rgba(255,222,170,${v === scaleTop ? 0.32 : 0.16})`; g.lineWidth = 1;
      line(g, [a, b2]); g.stroke();
      line(g, [a, [a[0] + 6, a[1]]]); g.strokeStyle = "rgba(255,222,170,.7)"; g.stroke();
      // numerals at the pane's back end, on open plain; the front lane's crest would cross them
      line(g, [b2, [b2[0] - 5, b2[1]]]); g.stroke();
      const e = scaleLbls.get("t" + v); txt(e, kfmt(v)); place(e, b2[0] - 8, b2[1], 1, 0.5);
    }
    scaleLbls.sweep();
    g.strokeStyle = "rgba(255,222,170,.5)"; g.lineWidth = 1; line(g, [P0, P3]); g.stroke();
    // labels that ride the lanes
    paintLaneLabels(ls, t);
  }

  function paintLaneLabels(ls, t) {
    // Two lines a lane: the name, then state, model, context and the last 15 minutes.
    for (const ln of ls) {
      const total = ln.sid === TOTAL, s = ln.s || {};
      const e = laneLbls.get(ln.sid), op = ln.a >= 0.995 ? "" : ln.a.toFixed(2);
      if (e._o !== op) { e._o = op; e.style.opacity = op; }
      const [x, y] = at(-0.9, ln.b);
      const rows = [];
      // No text may enter the Dock band (x < 66): a line that would is shortened. Widths are
      // estimated from the character count (measured: Archivo at this stretch runs up to
      // 7.6 px a character at 12 px and 8.2 at 14 px).
      const room = x - 6 - 74;
      if (total) {
        const p = view.totalPeak;
        rows.push(`<span class="v">all sessions</span>`);
        if (p) rows.push(`<span class="k">${room > 250 ? "last hour peak" : "peak"} ${F.int(p.v)} at ${at12(p.at)}</span>`);
      } else {
        const warm = s.state === "working";
        const name = String(s.name || s.sid.slice(0, 8));
        // a background session's quiet mark ends its name line; its kind never changes, so the
        // right-hung line keeps one width (the mark's room is taken from the name's)
        const bg = isBg(s), nroom = room - (bg ? 22 : 0);
        rows.push(`<span class="v${warm ? " warm" : ""}">${esc(name.length * 8.2 > nroom ? name.slice(0, Math.max(6, Math.floor(nroom / 8.2) - 1)) + "…" : name)}</span>${bg ? ` <span class="f bgk">bg</span>` : ""}`);
        const ask = view.asks.get(s.sid);
        // An idle session can have no model and no context yet: drop those parts rather
        // than print "idle, , context –%".
        const head = [s.state || "", model(s.model), s.ctx_pct != null ? `context ${s.ctx_pct.toFixed(0)}%` : ""]
          .filter(Boolean).join(", ");
        let tail;
        if (ask) {
          // what is asked, cut to the room the line has: "builder asked to run Bash: rm -r …, 2 m ago"
          const ago = `${age(t - ask.t)} ago`, who = ask.who ? ask.who + " " : "";
          const lead = !ask.text ? `${who}asked ${ask.what} ` : ask.q ? `${who}asked “` : `${who}asked to run ${ask.what}: `;
          const end = !ask.text ? ago : ask.q ? `”, ${ago}` : `, ${ago}`;
          let tx = ask.text;
          const fit = Math.floor(room / 7.6) - lead.length - end.length;
          if (tx.length > fit) tx = fit >= 8 ? tx.slice(0, fit - 1) + "…" : "";
          tail = tx ? lead + tx + end : `${who}asked ${ask.what} ${ago}`;
        } else tail = `${F.int(s.out_15m || 0)} out in 15 min${s.agents_running ? `, ${s.agents_running} agent${s.agents_running > 1 ? "s" : ""}` : ""}`;
        const both = `${head}, ${tail}`;
        const line2 = both.length * 7.6 <= room ? both : ask ? tail : head;
        rows.push(`<span class="k${ask && line2 !== head ? " warm" : ""}">${esc(line2)}</span>`);
      }
      html(e, rows.join("<br>"));
      place(e, x - 6, y, 1, 0.3);
      // the peak value on the crest
      const pk = markLbls.get(ln.sid);
      if (ln.peak && ln.peak.at && ln.a > 0.5) {
        show(pk, true); txt(pk, kfmt(ln.peak.v)); place(pk, ln.peak.at[0], ln.peak.at[1] - 5, 0.5, 1);
      } else show(pk, false);
    }
    laneLbls.sweep(); markLbls.sweep();
  }

  // time ruler along the front edge (DOM, placed when the lane set changes)
  const rulerLbls = pool("f ru");
  function placeRuler() {
    const ls = laneSet();
    if (!ls.length) return;
    const { bF } = edges(ls);
    for (const [m, s] of [[5, "5 min"], [15, "15 min"], [30, "30 min"], [45, "45 min"], [60, "1 h ago"]]) {
      const [x, y] = at(m, bF - EF);
      const e = rulerLbls.get(s); txt(e, s); place(e, x + 4, y + 2, 0, 0);
    }
    const [nx, ny] = at(0, bF - EF);
    const e = rulerLbls.get("now"); e.className = "lb k warm ru"; txt(e, "now"); place(e, nx + 6, ny + 2, 0, 0);
    rulerLbls.sweep();
  }

  // ---------- weather motion ------------------------------------------------------
  const precip = [...$("precip").children], flash = $("flash"), cloudsC = $("clouds").firstElementChild;
  let wxStop = null, wxKey = "", ripples = [], rippleAcc = 0, nextFlash = 0, cloudX = 0, cloudT = null, lastFx = 0, wxL = null;
  // A 256 px tile of streaks or flakes, at 1x: rain and snow are soft and in motion, and
  // at 2x the two layers cost about 4 screens of GPU memory.
  function tile(kind, n, len, a, wdt, slant) {
    const S = 256, c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d"); x.lineCap = "round";
    seed = kind === "near" ? 5 : 9;
    for (let i = 0; i < n; i++) {
      const px = rnd() * S, py = rnd() * S, l = len * (0.6 + rnd() * 0.8), al = a * (0.5 + rnd() * 0.7);
      for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
        if (wdt === 0) {   // snow: soft flakes
          const r = 0.7 + rnd() * len;
          const gr = x.createRadialGradient(px + dx, py + dy, 0, px + dx, py + dy, r);
          gr.addColorStop(0, `rgba(236,240,245,${al})`); gr.addColorStop(1, "rgba(236,240,245,0)");
          x.fillStyle = gr; x.fillRect(px + dx - r, py + dy - r, 2 * r, 2 * r);
        } else {
          x.strokeStyle = `rgba(200,212,224,${al})`; x.lineWidth = wdt;
          x.beginPath(); x.moveTo(px + dx, py + dy); x.lineTo(px + dx + l * slant, py + dy + l); x.stroke();
        }
      }
    }
    return c;
  }
  // Each precipitation layer is one 1x canvas a tile larger than the stage, filled with the
  // tile once and then only translated (mod 256). Dry weather frees both.
  const PW = W + 256, PH = H + 256;
  function fillPrecip(c, t) {
    if (c.width !== PW) { c.width = PW; c.height = PH; c.style.width = PW + "px"; c.style.height = PH + "px"; }
    const g = c.getContext("2d");
    g.clearRect(0, 0, PW, PH); g.fillStyle = g.createPattern(t, "repeat"); g.fillRect(0, 0, PW, PH);
  }
  function fxAlloc(on) {
    const w = on ? W : 0, h = on ? H - 456 : 0;
    if (FX.c.width !== w || FX.c.height !== h) { FX.c.width = w; FX.c.height = h; }
  }
  function setupWeather(L) {
    const key = `${L.kind}|${L.rain.toFixed(2)}|${L.snow.toFixed(2)}|${Math.round(L.wind / 5)}|${Math.round(L.wdir / 20)}`;
    if (key === wxKey) return;
    wxKey = key; wxL = L;
    // wind: "from" wdir; looking south, east is screen left
    const toAz = ((L.wdir + 180) % 360) * (Math.PI / 180);
    const vx = -Math.sin(toAz);
    L.slant = clamp(vx * L.wind / 60, -0.45, 0.45);
    L.cloudVx = vx * (0.6 + L.wind * 0.12);
    const motion = MOTION && !q.has("still"), wet = !!(L.rain || L.snow);
    if (L.rain) {
      fillPrecip(precip[0], tile("far", Math.round(260 * L.rain), 10, 0.16 + 0.1 * L.rain, 0.7, L.slant));
      fillPrecip(precip[1], tile("near", Math.round(70 * L.rain), 22 + 10 * L.rain, 0.2 + 0.08 * L.rain, 1, L.slant));
    } else if (L.snow) {
      fillPrecip(precip[0], tile("far", Math.round(90 * L.snow), 1.2, 0.5, 0, 0));
      fillPrecip(precip[1], tile("near", Math.round(26 * L.snow), 2.4, 0.75, 0, 0));
    } else for (const p of precip) p.width = p.height = 0;
    for (const p of precip) show(p, wet);
    fxAlloc(!!L.rain);
    root.classList.toggle("storm", !!L.storm && motion);   // the flash layer exists only in a storm
    if (wxStop) { wxStop(); wxStop = null; }
    ripples = [];
    FX.reset();
    // a still frame (reduced motion, quiet, or a screenshot): place the layers once
    wxFrame(motion ? 0 : 12.3, 0, true);
    // The loop runs only while something falls; cloud drift rides the updates (drift()).
    if (motion && wet) wxStop = Kiln.loop(wxFrame, { fps: 30 });
  }
  // The deck drifts with the wind once per update, by the time since the last one. From
  // 400 ms (Kiln.glide) the step is a linear transform transition over --kiln-tween; faster,
  // a step is under a pixel on a soft texture and is simply set.
  function drift(t) {
    const L = wxL;
    if (!L || !cloudsC.width) return;                // no deck under a clear sky
    const still = !MOTION || q.has("still");
    if (still) cloudX = 0;
    else if (cloudT != null) cloudX = (cloudX + clamp(t - cloudT, 0, 2) * L.cloudVx) % W;
    cloudT = t;
    const x = +(cloudX > 0 ? cloudX - W : cloudX).toFixed(2);
    const wrap = cloudsC._x != null && Math.abs(x - cloudsC._x) > W / 2;
    const tr = !still && Kiln.glide && !wrap ? "transform var(--kiln-tween) linear" : "none";
    if (cloudsC._tr !== tr) { cloudsC._tr = tr; cloudsC.style.transition = tr; }
    if (cloudsC._x !== x) { cloudsC._x = x; cloudsC.style.transform = `translate3d(${x}px,0,0)`; }
  }
  function wxFrame(T, dt, still) {
    const L = wxL;
    if (!L) return;
    if (L.rain || L.snow) {
      const sp = L.rain ? [520, 900 + 300 * L.rain] : [26, 52];
      precip.forEach((p, i) => {
        const vy = sp[i], sway = L.snow ? Math.sin(T * 0.6 + i) * 10 : 0;
        const vx = L.rain ? vy * L.slant : L.cloudVx * 6;
        const ox = (((T * vx + sway) % 256) + 256) % 256, oy = (T * vy) % 256;
        p.style.transform = `translate3d(${ox.toFixed(1)}px,${oy.toFixed(1)}px,0)`;
      });
    }
    // rings on the wet plain at 15 fps
    if (L.rain && (still || T - lastFx >= 1 / 15)) {
      const d = still ? 0.9 : T - lastFx;
      lastFx = T;
      rippleAcc += d * (L.storm ? 34 : L.kind === "rain" ? 22 : 9);
      seed = (seed + Math.floor(T * 1000)) | 0;
      while (rippleAcc >= 1) {
        rippleAcc--;
        const y = YH + 14 + Math.pow(rnd(), 0.7) * (H - YH - 14);
        ripples.push({ x: rnd() * W, y, s: (CAM.f * CAM.eye) / (y - YH), born: T - (still ? rnd() * 0.9 : 0) });
      }
      ripples = ripples.filter((r) => T - r.born < 0.9);
      const g = FX.g; FX.reset();
      g.lineWidth = 0.8;
      for (const r of ripples) {
        const k = (T - r.born) / 0.9, rx = (640 * 0.045 * (0.3 + k)) / r.s * 1.4;
        g.strokeStyle = `rgba(196,208,220,${(0.32 * (1 - k)).toFixed(3)})`;
        g.beginPath(); g.ellipse(r.x, r.y, rx * 2.2, rx * 0.5, 0, 0, 7); g.stroke();
      }
    }
    if (L.storm && !still && T > nextFlash) {
      if (nextFlash) flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 0.15, offset: 0.22 }, { opacity: 0.75, offset: 0.3 }, { opacity: 0 }], { duration: 760, easing: "ease-out" });
      nextFlash = T + 7 + Math.random() * 16;
    }
  }

  // ---------- fixed text blocks ----------------------------------------------------
  const clockT = $("clock").querySelector(".t span"), clockAp = $("clock").querySelector(".t small"), clockD = $("clock").querySelector(".d");
  const wx = $("wx");
  const gateBig = $("gatec").querySelector(".big b"), gateCd = $("gatec").querySelector(".cd"), gateRs = $("gatec").querySelector(".rs"), gateFh = $("gatec").querySelector(".fh");
  const pctNum = Kiln.num(gateBig, { fmt: (v) => String(Math.round(v)), snap: SNAP });
  const wingL = $("wingl"), wingR = $("wingr");
  const hero = $("hero");
  // the fifth line is the quiet background count; it always holds a line, so the block never resizes
  html(hero, `<div class="big"></div><div class="k"></div><div class="f"></div><div class="f"></div><div class="f">&nbsp;</div>`);
  const heroN = Kiln.num(hero.children[0], { fmt: F.int, snap: SNAP });
  const period = $("period"), periodDot = period.querySelector("i"), periodTx = period.querySelector("b");

  // the agents block, top left: running agents keyed by id, then today's spawns
  const agents = $("agents");
  html(agents, `<div class="hd"></div><div class="rows"></div><div class="f agm" style="display:none;margin:-4px 0 6px"></div><div class="k sph"></div><div class="sp"></div><div class="f gpf" style="margin-top:6px;line-height:1.4"></div>`);
  const agHd = agents.children[0], agRows = agents.children[1], agMore = agents.children[2], spHd = agents.children[3], spGrid = agents.children[4], gpF = agents.children[5];
  agRows.style.cssText = "display:flex;flex-direction:column";
  const agentEls = new Map();
  const AG_MAX = 3;

  // the rail, right: This Mac. Nothing in it moves sideways when a figure changes (README
  // rule 13): each big figure sits in a fixed slot, right-aligned (CSS `#rail .v b`), so the
  // units form one column; the footnotes are small ledgers, a label at the left and the
  // figure right-aligned against one unit column of fixed width (`#rail .g`), so every small
  // figure in the rail ends on the same edge. A row is [label, unit]; a null unit makes a
  // row of words ("pressure normal") across the whole ledger.
  const SW = 128;                                   // sparkline, core bars and ledgers
  const ledger = (rows) => `<div class="g">${rows.map(([k, un]) => un == null ? `<span class="gk w">${k}</span>`
    : `<span class="gk">${k}</span><span class="n"></span><span class="u">${un}</span>`).join("")}</div>`;
  const rail = $("rail");
  html(rail, `<div class="hd">This Mac</div>
    <div class="it"><span class="k">CPU</span><span class="v"><b></b><small>%</small></span><div class="cores">${"<i></i>".repeat(10)}</div>${ledger([["load", ""], ["GPU", "%"], ["", "%"]])}<div class="sw"><canvas></canvas></div></div>
    <div class="it"><span class="k">Memory</span><span class="v"><b></b><small></small></span>${ledger([["", null], ["swap", "GB"], ["compressed", "GB"]])}<div class="sw"><canvas></canvas></div></div>
    <div class="it"><span class="k">Network</span><span class="v"><b></b><small></small></span>${ledger([["out", ""], ["2 min peak", ""]])}<div class="sw"><canvas></canvas></div></div>
    <div class="it"><span class="k">Disk</span><span class="v"><b></b><small>GB free</small></span>${ledger([["size", "GB"], ["read", ""], ["write", ""]])}</div>
    <div class="it"><span class="k">Battery</span><span class="v"><b></b><small>%</small></span><span class="f"></span></div>`);
  const its = rail.querySelectorAll(".it");
  const cells = (it, sel) => [...it.querySelectorAll(".g " + sel)];
  // "6.0 KB" -> ["6.0", "KB"]: the figure and its unit go to separate cells
  const split = (s) => { const i = s.search(R.unitGap); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)]; };
  const R = {
    cpu: Kiln.num(its[0].querySelector("b"), { fmt: (v) => (v >= 99.95 ? "100" : v.toFixed(1)), snap: SNAP }),
    cores: [...its[0].querySelectorAll(".cores i")], cpuN: cells(its[0], ".n"), proc: cells(its[0], ".gk")[2],
    mem: Kiln.num(its[1].querySelector("b"), { fmt: (v) => (v / 2 ** 30).toFixed(v >= 100 * 2 ** 30 ? 0 : 1), snap: SNAP }), memS: its[1].querySelector("small"), memN: cells(its[1], ".n"), memP: cells(its[1], ".w")[0],
    // the unit follows the figure being drawn, so a glide across 1000 B/s stays truthful
    net: Kiln.num(its[2].querySelector("b"), { fmt: (v) => { const [n, u] = split(F.bytes(v)); txt(R.netS, u ? u + "/s in" : "in"); return n; }, snap: SNAP }),
    netS: its[2].querySelector("small"), netN: cells(its[2], ".n"), netU: cells(its[2], ".u"), netPk: cells(its[2], ".gk")[1],
    disk: Kiln.num(its[3].querySelector("b"), { fmt: (v) => Math.round(v / 1e9) + "", snap: SNAP }), diskN: cells(its[3], ".n"), diskU: cells(its[3], ".u"),
    bat: Kiln.num(its[4].querySelector("b"), { fmt: (v) => Math.round(v) + "", snap: SNAP }), batF: its[4].querySelector(".f"),
    sparks: [...rail.querySelectorAll(".sw canvas")],
    unitGap: / |[ ]/,   // a space or a thin space: where a figure meets its unit
  };
  const rateTo = (n, u, bps) => { const [a, b] = split(F.bytes(bps)); txt(n, a); txt(u, b ? b + "/s" : ""); };
  for (const c of R.sparks) { c.width = (SW + 12) * DPR; c.height = 22 * DPR; c.style.transform = "translate3d(-12px,0,0)"; }
  Kiln.track("cpu", (s) => s.sys && s.sys.cpu, 120);
  Kiln.track("mem", (s) => s.sys && s.sys.mem && s.sys.mem.used, 120);
  Kiln.track("rx", (s) => s.sys && s.sys.net && s.sys.net.rx_bps, 120);
  // A sparkline that scrolls: drawn once per update one step wider than its window. From
  // 400 ms (Kiln.glide) it then slides left by that step on the compositor; faster, the step
  // is under a third of a pixel and the redraw alone moves it.
  function spark(c, key, ser, max) {
    const g = c.getContext("2d"); g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, SW + 12, 22);
    if (ser.length < 2) return;
    const t1 = ser[ser.length - 1].t, span = 120;
    const X = (tt) => SW - ((t1 - tt) / span) * SW + 12;
    g.strokeStyle = "rgba(223,230,236,.88)"; g.lineWidth = 1.1; g.lineJoin = "round"; g.beginPath();
    ser.forEach((p, i) => { const x = X(p.t), y = 21 - (p.v / (max || 1)) * 19; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    if (SNAP || !Kiln.glide) return;
    const px = (SW / span) * (Kiln.period / 1000);
    c.animate([{ transform: `translate3d(${(px - 12).toFixed(2)}px,0,0)` }, { transform: "translate3d(-12px,0,0)" }], { duration: Kiln.tweenMs, easing: "linear" });
  }

  // ---------- derive: figures computed from the state, once per update ------------------
  function derive(s) {
    const c = s.claude || {}, t = s.t;
    const lim = (c.limits && c.limits.seven_day) || null;
    let W7 = null;
    if (lim && lim.resets_at) {
      const start = lim.resets_at - 7 * 86400;
      const before = ((c.limits && c.limits.history) || []).filter((h) => h[0] < start);
      W7 = { pct: lim.pct || 0, reset: lim.resets_at, start, burn: lim.burn_per_h, pace: lim.pace, projected: lim.projected, runout: lim.runout_at, lastClose: before.length ? before[before.length - 1][2] : null };
      if (dev && q.has("pct")) W7.pct = +q.get("pct");   // dev: force the weekly figure
    }
    // The event-derived sets change only with claude.events (a sticky block) or as the hour's
    // edge passes: worked out again on a new block or every 10 s, not on every line.
    const ek = Math.floor(t / 10);
    if (c.events !== derive.ev || ek !== derive.ek) {
      derive.ev = c.events; derive.ek = ek;
      const events = (c.events || []).filter((e) => e && t - e.t <= 3700);
      const evSig = `${events.length}|${events.length ? events[events.length - 1].t : 0}`;
      // agents that finished inside the hour: pair each agent_done with its agent_start
      const starts = (c.events || []).filter((e) => e.kind === "agent_start");
      const pastAgents = [];
      for (const e of c.events || []) {
        if (e.kind !== "agent_done" || t - e.t > 3600) continue;
        const st = starts.filter((x) => x.sid === e.sid && x.detail === e.detail && x.t <= e.t).pop();
        pastAgents.push({ sid: e.sid, start: st ? st.t : e.t, end: e.t, gp: /^general-purpose/.test(e.detail || "") });
      }
      derive.evd = { events, evSig, pastAgents };
    }
    const { events, evSig, pastAgents } = derive.evd;
    // open questions: the session's own ask, else the last unanswered ask event
    const asks = new Map();
    for (const x of c.sessions || []) {
      if (!x.ask) continue;
      // ask.since (the dialog's start, 2026-11-05); text is "" when the feed did not find it
      const a = x.ask, tt = a.since || a.t || a.at || a.start;
      if (tt) asks.set(x.sid, { t: tt, what: String(a.what || a.tool || a.detail || a.kind || "a question").replace(/^perm /, "to run "),
        q: a.kind === "question", text: String(a.text || "").trim(), who: a.agent_type ? String(a.agent_type) : "" });
    }
    const opm = (c.tokens && c.tokens.out_per_min) || [];
    let pi = -1, pv = 0;
    for (let i = 0; i < 59; i++) if ((opm[i] || 0) > pv) { pv = opm[i]; pi = i; }
    const m0 = Math.floor(t / 60) * 60;
    const totalPeak = pi >= 0 ? { v: pv, at: m0 - (59 - pi) * 60 } : null;
    const avg60 = opm.length >= 59 ? opm.slice(0, 59).reduce((a, b) => a + (b || 0), 0) / 59 : null;
    return { t, W7, events, evSig, pastAgents, asks, totalPeak, avg60, opm, m0, sessions: c.sessions || [] };
  }

  // ---------- the update ------------------------------------------------------------
  const agentState = new Map();   // id -> {slot, i, start, el, …}
  let astro = null, astroKey = "";
  function update(s) {
    const t = s.t, L = look(s);
    // the sun and moon move a fraction of a degree a minute: solved once a minute
    const ak = `${Math.floor(t / 60)}|${s.weather && s.weather.sunrise}|${s.weather && s.weather.sunset}`;
    if (ak !== astroKey) { astroKey = ak; astro = s.weather ? window.HorizonAstro.sky(t, s.weather.sunrise, s.weather.sunset) : null; }
    const A = astro, alt = sunAlt(A, s);
    fogDist = L.fog ? 3.2 : 9;
    const d = derive(s);
    const pct = d.W7 ? d.W7.pct : 0;
    view = Object.assign(view || {}, d, { L, pct });

    // sky, deck, gate, range, plain: each repaints only when its key changes
    const skyKey = `${Math.floor(t / 60)}|${L.kind}|${L.cloud}|${PRE.sky}`;
    if (skyKey !== paintSky.key) { paintSky.key = skyKey; paintSky(L, A, alt); makeClouds(L, alt); }
    setupWeather(L);
    drift(t);
    paintGate(d.W7, t);
    setBand(pct);
    paintFar(s, L, d.W7);
    updateFortnight(s);                              // before the columns, which keep clear of it
    paintGround(L, pct);

    // Rule 8a.6b: per line, only the fast figures (sys, sessions, the period) are worked out.
    // Everything else is redone when its block changes (sticky blocks keep their identity
    // between lines) or when the whole second turns, the finest unit any age or countdown
    // here shows. At 100 ms that skips nine lines in ten.
    const sec = Math.floor(t), newSec = sec !== update.sec;
    update.sec = sec;
    // agents first: the live paint reads their columns
    updateAgents(s, d, newSec);
    updateLanes(s);
    if (lanesN !== placeRuler.n) { placeRuler.n = lanesN; placeRuler(); }
    maybePaintLive(t, newSec);
    if (newSec) agentText(t);

    // clock: the text changes once a minute
    const mk60 = Math.floor(t / 60);
    if (mk60 !== update.min) {
      update.min = mk60;
      const now = dt(t), hm = at12(t).split(" ");
      txt(clockT, hm[0]); txt(clockAp, hm[1]);
      txt(clockD, now.toLocaleDateString("en-US", { weekday: "long" }) + " " + now.getDate() + " " + now.toLocaleDateString("en-US", { month: "long" }) + " " + now.getFullYear());
    }

    if (newSec || s.weather !== update.wx) { update.wx = s.weather; updateWeatherText(s, L, A, alt); }
    pctNum.set(pct);
    const c = s.claude || {};
    if (newSec || c.limits !== update.lim || c.tokens !== update.tok || s.analytics !== update.an) {
      update.lim = c.limits; update.tok = c.tokens; update.an = s.analytics;
      updateGateText(s, d, pct);
    }
    if (s.github !== update.gh) { update.gh = s.github; updateGitHub(s); }
    updateHero(s, d);
    updateLog(s);
    updateRail(s);
  }

  function updateWeatherText(s, L, A, alt) {
    const w = s.weather;
    if (!w) { html(wx, `<span class="k">Weather is offline; the sky shows the last kind it knew.</span>`); return; }
    const t = s.t;
    const kindTx = WX_OVERRIDE ? `${WX_OVERRIDE} (dev override)` : w.text || w.kind;
    const dayTx = PRE.sky === "sun" ? (alt > 0 ? "day" : alt > -6 ? "twilight" : "night") : PRE.sky;
    const rows = [
      `<span class="tp">${w.temp_c != null ? w.temp_c.toFixed(1) : "–"}<small>°C</small></span><span class="kd">${esc(kindTx)}, ${dayTx}</span>`,
      `feels ${w.feels_c != null ? w.feels_c.toFixed(1) : "–"} °C, humidity ${w.humidity ?? "–"}%, cloud ${w.cloud ?? "–"}%`,
      `wind ${Kiln.fmt.wind(w.wind_kmh || 0)} from the ${compass(w.wind_dir || 0)}, ${w.rain_mm ? `rain ${w.rain_mm} mm` : w.snow_cm ? `snow ${w.snow_cm} cm` : "no precipitation"}`,
    ];
    if (w.sunrise && w.sunset) {
      if (t < w.sunrise) rows.push(`sunrise ${at12(w.sunrise)}, in ${age(w.sunrise - t)}`);
      else if (t < w.sunset) rows.push(`sunset ${at12(w.sunset)}, in ${age(w.sunset - t)}`);
      else rows.push(`sunset was ${at12(w.sunset)}; sunrise ${at12(w.sunrise + 86400)}, in ${age(w.sunrise + 86400 - t)}`);
    }
    if (A) {
      const mo = A.moon, pctLit = Math.round(mo.fraction * 100);
      const when = mo.alt > 0 ? (mo.set ? `up, sets ${at12(mo.set)}` : "up") : mo.rise ? `rises ${at12(mo.rise)}` : "below the horizon";
      rows.push(`moon ${pctLit}% lit, ${mo.name}, ${when}`);
    }
    rows.push(`<span class="f">${esc(w.place || "")}, observed ${w.observed_at ? age(t - w.observed_at) + " ago" : "–"}</span>`);
    html(wx, rows.join("<br>"));
  }

  function updateGateText(s, d, pct) {
    const W7 = d.W7, t = s.t;
    show(used, !!W7);
    if (!W7) { txt(gateCd, "no weekly limit reported"); txt(gateRs, ""); html(wingL, ""); show(leader, false); leader._k = ""; wingBoxes = []; wingYield(); return; }
    txt(gateCd, `${spanS(W7.reset - t)} to the reset`);
    txt(gateRs, `${dayLbl(W7.reset)} at ${at12(W7.reset)}`);
    const rows = [
      `this week began`,
      `<span class="v">${age(t - W7.start)}</span> ago`,
      `${dayLbl(W7.start)} at ${at12(W7.start)}`,
      W7.burn != null ? `burning ${W7.burn.toFixed(1)}% an hour` : `no burn rate yet`,
    ];
    // The wing hangs from x 560 inside the arc, which leans in as the rows go up: a row
    // wider than the room left of 560 at its height ran onto the lit band ("on pace for
    // 303% by the reset", host 2026-11-05). That row drops its tail. The room ends 16 px
    // inside the arc's centre line: its inner rule and minor ticks reach r - 12.
    const arcRoom = (i) => { const dy = GC.cy - (255 + 19 * i); return 560 - (GC.cx - Math.sqrt(Math.max(0, (GC.r - 16) ** 2 - dy * dy))); };
    const rowW = (h) => {
      const v = /<span class="v">([^<]*)<\/span>/.exec(h), rest = plain(v ? h.replace(v[0], "") : h);
      return textW(rest, 12) + (v ? textW(v[1], 14, 500) : 0);
    };
    const fit = (...alts) => alts.find((h) => rowW(h) <= arcRoom(rows.length)) || alts[alts.length - 1];
    if (W7.pace == null || W7.projected == null) rows.push(`<span class="f">forecasts start ${WD(W7.start + 12 * 3600)} ${at12(W7.start + 12 * 3600)}</span>`);
    else rows.push(fit(`on pace for <span class="v">${Math.round(W7.projected)}%</span> by the reset`, `on pace for <span class="v">${Math.round(W7.projected)}%</span>`));
    if (W7.runout) rows.push(`<span class="gp">runs out ${dayLbl(W7.runout)} ${at12(W7.runout)}</span>`);
    html(wingL, rows.join("<br>"));
    // the five-hour window only while Claude Code reports a live one (the plan has none
    // since 2026-10-30): no "not reported" footnote, never a 0%
    const five = s.claude && s.claude.limits && s.claude.limits.five_hour;
    txt(gateFh, !five || five.pct == null || five.stale ? ""
      : `5-hour window ${Math.round(five.pct)}%${five.resets_at ? `, resets in ${age(five.resets_at - t)}` : ""}`);
    const td = (s.claude && s.claude.tokens && s.claude.tokens.today) || {}, an = s.analytics || {};
    const r2 = [
      `since midnight`,
      `<span class="v">${F.tokens(td.out)}</span> output tokens`,
      `${F.tokens(td.cache_read)} cache reads`,
      `${an.cache_hit_pct ? `${an.cache_hit_pct.today}% hit, ` : ""}${F.int(td.calls)} calls`,
      // the fortnight's own figures live in its caption under the far range (updateFortnight)
      `<span class="f">${an.prompts ? `${F.int(an.prompts.today)} prompt${an.prompts.today === 1 ? "" : "s"}, ` : ""}${F.tokens(td.cache_write)} cache writes</span>`,
    ];
    html(wingR, r2.join("<br>"));

    // The "used" label finds room among the blocks around the gate. Row geometry is the
    // rendered page's (measured with ?measure: wing rows every 19 px from y 256, the centre
    // block's lines at fixed heights); widths come from measureText.
    const rowBox = (h, i, x, ax) => {
      const tx = plain(h), w = /class="v"/.test(h) ? textW(tx, 14, 500) : /^<span class="f">/.test(h) ? textW(tx, 11) : textW(tx, 12);
      return [x - ax * w, 255 + 19 * i, x + (1 - ax) * w, 272 + 19 * i];
    };
    const mid = (w, y0, y1) => [GC.cx - w / 2, y0, GC.cx + w / 2, y1];
    wingBoxes = rows.map((h, i) => rowBox(h, i, 560, 1));
    wingYield(); ghYield();
    obstacles = [
      ...FIXED, ...farBoxes, ...colBoxes(),
      ...wingBoxes, ...r2.map((h, i) => rowBox(h, i, 952, 0)),
      mid(textW(String(Math.round(pct)), 112, 200) + 50, 152, 232), mid(textW("of this week's limit used", 14), 250, 267),
      mid(textW(gateCd._s || "", 19, 350), 275, 298), mid(textW(gateRs._s || "", 12), 302, 318), mid(textW(gateFh._s || "", 11), 326, 340),
    ];
    placeUsed(pct);
  }

  // GitHub's year, right of the gate: totals, then the 53 weeks as a strip, newest at the right.
  const ghBox = $("gh");
  html(ghBox, `<div></div><div class="sw2"><canvas></canvas></div><div class="f"></div>`);
  const ghTx = ghBox.children[0], ghC = ghBox.querySelector("canvas"), ghF = ghBox.children[2];
  ghC.width = 300 * DPR; ghC.height = 20 * DPR;
  let ghKey = "";
  function updateGitHub(s) {
    const gh = s.github;
    show(ghBox, !!gh);
    if (!gh) return;
    const t = s.t;
    html(ghTx, `<span class="k">GitHub, past year</span><br><span class="v">${F.int(gh.total_year)}</span> contributions; ${F.int(gh.today)} today, ${F.int(gh.week)} this week`);
    const days = gh.days || [], weeks = [];
    for (let i = days.length; i > 0; i -= 7) weeks.unshift(days.slice(Math.max(0, i - 7), i).reduce((a, d) => a + (d[1] || 0), 0));
    const mx = Math.max(1, ...weeks), pw = weeks.indexOf(mx);
    const key = weeks.join();
    if (key !== ghKey) {
      ghKey = key;
      const g = ghC.getContext("2d"); g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, 300, 20);
      const bw = 300 / weeks.length;
      weeks.forEach((v, i) => {
        const h = Math.max(1, (v / mx) * 18);
        g.fillStyle = i === weeks.length - 1 ? "rgba(255,214,150,.95)" : i === pw ? "rgba(240,244,248,.95)" : "rgba(214,222,230,.5)";
        g.fillRect(i * bw + 0.5, 20 - h, Math.max(1, bw - 1.5), h);
      });
    }
    const pk = days.length ? days[Math.min(days.length - 1, days.length - (weeks.length - pw) * 7 + 6)] : null;
    const best = gh.best ? `best day ${F.int(gh.best[1])}, ${dayLbl(dateT(gh.best[0]) + 3600)}` : "";
    html(ghF, `52 weeks; peak week ${F.int(mx)}${pk ? ` to ${dayLbl(dateT(pk[0]) + 3600)}` : ""}<br>${best}${gh.streak ? `; streak ${gh.streak} day${gh.streak > 1 ? "s" : ""}` : ""}`);
    void t;
  }

  function updateHero(s, d) {
    const opm = d.opm, t = s.t;
    // claude.tokens is sticky: the hero changes only with it, the minute, or the session set
    const sk = `${d.m0}|${(d.sessions || []).map((x) => (isBg(x) ? "b" : "i") + x.state).join()}`;
    if (s.claude && s.claude.tokens === updateHero.tok && sk === updateHero.sk) return;
    updateHero.tok = s.claude && s.claude.tokens; updateHero.sk = sk;
    heroN.set(opm.length >= 59 ? opm[58] || 0 : null);
    txt(hero.children[1], `tokens a minute, all sessions, ${at12(d.m0 - 60).replace(/ [ap]m$/, "")} to ${at12(d.m0)}`);
    // the figure ends the line, so its growth through the minute pushes nothing
    txt(hero.children[2], `so far this minute, as responses land: ${F.int(opm[59] || 0)}`);
    // How to count sessions (README): the count is of interactive sessions; background ones
    // (kind "bg", hosted by the daemon) get the quiet line under it, with their real state
    const all = (s.claude && s.claude.sessions) || [], open = all.filter((x) => !isBg(x));
    const working = open.filter((x) => x.state === "working").length;
    txt(hero.children[3], `last hour average ${d.avg60 != null ? F.int(d.avg60) : "–"}; ${open.length} open, ${working} working`);
    const back = bgNote(all.filter(isBg));
    txt(hero.children[4], back ? "+" + back : " ");
    void t;
  }

  // The fortnight's caption, under the far range's day labels: what those 14 days held that
  // nothing else on screen says. Rendered only when the analytics block changes (rule 8a.6b).
  const fort = $("fort");
  let fortBox = null, fortAn = null;
  function updateFortnight(s) {
    const an = s.analytics;
    if (an === fortAn) return;
    fortAn = an;
    const days = (an && an.days) || [];
    if (!days.length) { html(fort, ""); fortBox = null; return; }
    const nd = days.length, out = days.reduce((a, x) => a + (x.out || 0), 0);
    const spawns = Object.values((an.spawns && an.spawns.d14) || {}).reduce((a, b) => a + b, 0);
    const v = (x) => `<span class="v">${x}</span>`;
    const l1 = [an.prompts ? `${v(F.int(an.prompts.d14))} prompts` : "", `${v(F.tokens(out))} tokens out`, spawns ? `${v(F.int(spawns))} agents` : ""].filter(Boolean);
    const rows = [`<span class="k">${l1.slice(0, -1).join(", ")}${l1.length > 1 ? " and " : ""}${l1[l1.length - 1]} over these ${nd} days</span>`];
    const cc = an.concurrency, fl = an.fails, ch = an.cache_hit_pct, aw = an.ask_wait;
    const l2 = [];
    if (cc && cc.max) l2.push(`up to ${F.int(cc.max)} session${cc.max > 1 ? "s" : ""} at once, usually ${F.int(cc.median || 0)}`);
    if (ch && ch.d14 != null) l2.push(`cache hit ${ch.d14}%`);
    if (fl && fl.d14 != null) l2.push(fl.d14 ? `${F.int(fl.d14)} failure${fl.d14 > 1 ? "s" : ""}` : "no failures");
    if (l2.length) rows.push(l2.join("; "));
    if (aw && aw.count) rows.push(`${F.int(aw.count)} question${aw.count > 1 ? "s" : ""} waited on you: median ${age(aw.median_s)}${aw.p90_s != null ? `, p90 ${age(aw.p90_s)}` : ""}`);
    html(fort, rows.join("<br>"));
    // its box, for the agent columns to fade behind (no layout read: measured widths)
    const w = Math.max(textW(plain(rows[0]), 12), ...rows.slice(1).map((r) => textW(r, 11)));
    fortBox = [92, 520, 92 + Math.min(470, w), 520 + 4 + rows.length * 16];
  }

  // The latest events, newest first, on the open plain right of the lanes. Rows are keyed,
  // so an arrival slides the others down (a transform, 360 ms) and fades in; ages tick.
  // Rebuilt when claude.events changes; between, only the ages are written, once a second.
  const LOG_N = 5, LOG_ROW = 37, LOG_TOP = 25;
  const logBox = $("log");
  html(logBox, `<div class="hd"></div>`);
  const logHd = logBox.firstElementChild, logRows = new Map();
  let logEv = null, logSec = -1, logShown = [];
  // [subject, its colour, what happened]: the subject is the session, or the agent for agent
  // events, so a run of finished turns reads as a list of sessions, not one phrase repeated.
  function evLine(e) {
    const name = String(e.name || String(e.sid || "").slice(0, 8)), det = String(e.detail || "");
    switch (e.kind) {
      case "done": return [name, "", `finished ${e.n > 1 ? `${F.int(e.n)} turns` : "a turn"}`];
      case "fail": return [name, "gp", det ? `a turn failed: ${det}` : "a turn failed"];
      case "ask": return [name, "warm", `asked ${det ? det.replace(/^perm /, "to run ") : "a question"}`];
      case "answered": return [name, "", "you answered"];
      case "remind": return [name, "warm", "still waiting on you"];
      case "agent_start": case "agent_done": {
        const m = /^([^:]+):\s*(.*)$/.exec(det), type = m ? m[1] : "agent", desc = m ? m[2] : det;
        const verb = e.kind === "agent_start" ? "started" : "finished", full = `${verb} ${desc}, for ${name}`;
        // the session is dropped before the task is cut short
        return [type, type === "general-purpose" ? "gp" : e.kind === "agent_start" ? "warm" : "", !desc ? `${verb}, for ${name}` : textW(full, 11) <= 282 ? full : `${verb} ${desc}`];
      }
      default: return [name, "", String(e.kind || "event")];
    }
  }
  function updateLog(s) {
    const t = s.t, evs = (s.claude && s.claude.events) || null, sec = Math.floor(t);
    if (evs === logEv && sec === logSec) return;
    const fresh = evs !== logEv;
    logEv = evs; logSec = sec;
    const list = (evs || []).filter((e) => e && e.t != null);
    if (fresh) {
      // The header counts the last hour only when the list reaches back that far (the feed
      // keeps the last 40 events); otherwise it says how far back the list goes.
      const hour = list.filter((e) => t - e.t <= 3600), n = (k) => hour.filter((e) => e.kind === k).length;
      const turns = hour.filter((e) => e.kind === "done").reduce((a, e) => a + (e.n || 1), 0);
      const pl = (c, w) => `${F.int(c)} ${w}${c === 1 ? "" : "s"}`;
      const parts = [turns && pl(turns, "turn"), n("agent_start") && pl(n("agent_start"), "agent"),
        n("ask") && pl(n("ask"), "question"), n("fail") && pl(n("fail"), "failure")].filter(Boolean);
      const whole = list.length < 40 || t - list[0].t > 3600;
      txt(logHd, !list.length ? "No session events yet"
        : whole ? (parts.length ? `${parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " : ""}${parts[parts.length - 1]} in the last hour` : "Nothing in the last hour")
        : `The latest ${list.length} events, back to ${at12(list[0].t)}`);
      // newest first; a session's coalesced turns keep their key as their count grows
      const shown = list.slice(-LOG_N).reverse(), doneN = new Map(), seen = new Set();
      logShown = shown.map((e, i) => {
        let k;
        if (e.kind === "done") { const j = doneN.get(e.sid) || 0; doneN.set(e.sid, j + 1); k = `done|${e.sid}|${j}`; }
        else k = `${e.kind}|${e.sid}|${e.id || e.detail || ""}|${Math.round(e.t)}`;
        seen.add(k);
        let r = logRows.get(k);
        if (!r) {
          r = mk("er", logBox);
          r.innerHTML = `<span class="ew"></span><span class="ea"></span><span class="ed"></span>`;
          r._y = LOG_TOP + i * LOG_ROW; r.style.transform = `translateY(${r._y}px)`;
          if (!SNAP && logRows.size) r.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: "ease" });
          logRows.set(k, r);
        }
        const y = LOG_TOP + i * LOG_ROW;
        if (r._y !== y) { r._y = y; r.style.transform = `translateY(${y}px)`; }
        const [w, cls, d] = evLine(e), [ew, ea, ed] = r.children;
        txt(ew, w); const c = "ew" + (cls ? " " + cls : ""); if (ew.className !== c) ew.className = c;
        txt(ed, d);
        return { e, ea };
      });
      for (const [k, r] of logRows) if (!seen.has(k)) {
        logRows.delete(k);
        if (SNAP) r.remove();
        else r.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: "ease", fill: "forwards" }).onfinish = () => r.remove();
      }
    }
    for (const { e, ea } of logShown) txt(ea, age(t - e.t));
  }

  // agents_running items are {id, sid, session, type, desc, started, age_s, idle_s}. The start
  // is `started` (epoch seconds; ms or ISO tolerated) so ages tick with state.t, else t − age_s;
  // null when the feed gives neither, and every age built from it then reads "–".
  function agStart(a, t) {
    let v = a.started;
    if (typeof v === "string" && !isFinite(+v)) v = Date.parse(v) / 1000;
    v = +v;
    if (v > 0 && isFinite(v)) return v > 1e11 ? v / 1000 : v;
    const g = a.age_s == null ? NaN : +a.age_s;
    return isFinite(g) ? t - g : null;
  }
  const since = (t, t0) => (t0 == null ? null : t - t0);

  // A running agent's column of light: DOM, so it rises out of the ground and sinks back on
  // the compositor (380 ms, rule 5). Built from the canvas column it replaces: a 1.8 px shaft
  // graded up from the foot, a faint 14 px glow, a reflection and a foot on the wet plain.
  const cols = $("cols");
  function makeCol(st) {
    const e = mk("acol" + (st.gp ? " gp" : ""), cols);
    e.innerHTML = `<div class="rise"><i class="gl"></i><i class="sh"></i></div><i class="rf"></i><i class="ft"></i><div class="f cl ${st.gp ? "gp" : "warm"}"></div>`;
    st.el = e; st.rise = e.firstElementChild; st.lbl = e.lastElementChild;
    return e;
  }
  function placeCol(st, [bx, by], crown) {
    if (!st.el) return;
    const k = `translate(${bx.toFixed(1)}px,${by.toFixed(1)}px)`;
    if (st.el._k !== k) { st.el._k = k; st.el.style.transform = k; }
    const H = Math.round(by - crown);
    // The name stands centred over the column, unless there it would sit on the gate's ring
    // (the column near the arc's left foot did): then it hangs beside the column's top, on
    // the side facing into the arc.
    const w = textW(st.lbl._s || st.type || "", 11), cy = by - H - 4 - 7.5;
    const side = ringHit([bx - w / 2, cy - 7.5, bx + w / 2, cy + 7.5]) ? (bx < GC.cx ? 1 : -1) : 0;
    // The shaft passes behind text under the horizon: where it would cross a day label or
    // the fortnight's caption it fades out and back in (in the host three shafts struck
    // through "Fri 30 1.36M"). The gap is a mask on the column's own small layer, set only
    // when the column moves.
    const across = (b) => b && bx > b[0] - 5 && bx < b[2] + 5;
    const gy = [];
    if (dayBoxes.some(across)) gy.push(YH + 4, YH + 42);
    if (across(fortBox)) gy.push(fortBox[1] - 4, fortBox[3] + 4);
    const g0 = gy.length ? Math.min(...gy) : 0, g1 = gy.length ? Math.max(...gy) : 0;
    const lk = `${H}|${side}|${g0}|${g1}`;
    if (st.lk !== lk) {
      st.lk = lk; st.H = H; st.side = side;
      const d0 = Math.round(by - g1), d1 = Math.round(by - g0);
      const mask = gy.length ? `linear-gradient(to top, #000 ${d0 - 8}px, transparent ${d0}px, transparent ${d1}px, #000 ${d1 + 8}px)` : "";
      st.rise.style.webkitMaskImage = mask; st.rise.style.maskImage = mask;
      st.rise.style.height = H + "px"; st.rise.firstElementChild.style.height = Math.max(0, H - 30) + "px";
      st.lx = side > 0 ? "7px" : side < 0 ? "calc(-100% - 7px)" : "-50%";
      st.lbl.style.bottom = (side ? H - 14 : H + 4) + "px";
      st.lbl.style.transform = `translateX(${st.lx})`;
    }
    const lx0 = side > 0 ? bx + 7 : side < 0 ? bx - 7 - w : bx - w / 2, ly1 = by - (side ? H - 14 : H + 4);
    st.box = [lx0, ly1 - 15, lx0 + w, ly1];
    st.bx = bx; st.by = by;
    if (!st.risen) {
      st.risen = true;
      if (!SNAP) {
        const o = { duration: 380, easing: "cubic-bezier(.2,.7,.3,1)" };
        st.el.animate([{ opacity: 0 }, { opacity: 1 }], o);
        st.rise.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], o);
        st.lbl.animate([{ transform: `translate(${st.lx},${H}px)` }, { transform: `translate(${st.lx},0)` }], o);
      }
    }
  }
  // Does a box cross the gate's ring band (the arc, its ticks, the time ring and the day
  // names outside it)? Compared by the box's nearest and farthest distance from the centre.
  function ringHit(b) {
    const nx = clamp(GC.cx, b[0], b[2]), ny = clamp(GC.cy, b[1], b[3]);
    const dmin = Math.hypot(nx - GC.cx, ny - GC.cy);
    const dmax = Math.max(...[[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].map(([x, y]) => Math.hypot(x - GC.cx, y - GC.cy)));
    return b[1] < YH && dmax > GC.r - 12 && dmin < GC.r + 38;
  }
  function sinkCol(st) {
    const e = st.el;
    if (!e) return;
    if (SNAP || !st.risen) { e.remove(); return; }
    const o = { duration: 380, easing: "cubic-bezier(.5,0,.8,.3)", fill: "forwards" };
    e.animate([{ opacity: 1 }, { opacity: 0 }], o).onfinish = () => e.remove();
    st.rise.animate([{ transform: "scaleY(1)" }, { transform: "scaleY(0)" }], o);
    st.lbl.animate([{ transform: `translate(${st.lx || "-50%"},0)` }, { transform: `translate(${st.lx || "-50%"},${st.H || 0}px)` }], o);
  }
  // the column names' boxes (placeCol keeps them) and the shafts themselves, for the "used"
  // label to keep clear of (a shaft through "8% used" struck out its first figure)
  function colBoxes() {
    const out = [];
    for (const st of agentState.values()) if (st.box) out.push(st.box, [st.bx - 3, st.by - st.H, st.bx + 3, st.by]);
    return out;
  }
  // ages tick every update, whether or not the canvas repaints
  function agentText(t) {
    for (const st of agentState.values()) {
      if (!st.lbl) continue;
      const a = since(t, st.start);
      txt(st.lbl, a == null ? st.type : `${st.type}, ${age(a)}`);
    }
  }

  function updateAgents(s, d, newSec) {
    const t = s.t, c = s.claude || {};
    // the rows' ages show whole seconds: between seconds only a change of the set matters
    const ak = (c.agents_running || []).map((a) => a && a.id).join();
    if (!newSec && ak === updateAgents.k && s.analytics === updateAgents.an) return;
    updateAgents.k = ak; updateAgents.an = s.analytics;
    const run = (c.agents_running || []).filter((a) => a && a.id != null).map((a) => ({ a, start: agStart(a, t) }))
      .sort((x, y) => (x.start ?? Infinity) - (y.start ?? Infinity)).map((x) => Object.assign({}, x.a, { _start: x.start }));
    const shown = run.slice(0, AG_MAX), ids = new Set(shown.map((a) => a.id));
    // more than the rows hold: say so under them ("4 agents running" listed three, silently).
    // The block keeps its depth: the general-purpose footnote gives up its line meanwhile.
    const more = run.length - shown.length;
    show(agMore, more > 0); show(gpF, more <= 0);
    if (more > 0) txt(agMore, `+${more} more`);
    if (run.length) txt(agHd, `${run.length} agent${run.length > 1 ? "s" : ""} running`);
    else {
      const last = (c.events || []).filter((e) => e.kind === "agent_done").pop();
      html(agHd, last ? `No agents running<br><span class="f">the last one finished ${age(t - last.t)} ago</span>` : "No agents running");
    }
    // rows
    const perSid = new Map();
    shown.forEach((a, i) => {
      let e = agentEls.get(a.id);
      if (!e) {
        e = mk("row", agRows);
        e.innerHTML = `<span class="v"></span>&ensp;<span class="k"></span><br><span class="k blk"></span><span class="f blk"></span>`;
        agentEls.set(a.id, e);
        if (!SNAP) e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: "ease" });
      }
      if (e._order !== i) { e._order = i; e.style.order = i; }
      const gp = a.type === "general-purpose";
      const sname = a.session || ((c.sessions || []).find((x) => x.sid === a.sid) || {}).name || String(a.sid || "").slice(0, 8);
      const [nv, nk, dk, ff] = e.querySelectorAll("span");
      const ncls = "v" + (gp ? " gp" : " warm");
      if (nv.className !== ncls) nv.className = ncls;
      txt(nv, a.type || "agent");
      const run_s = since(t, a._start);
      txt(nk, run_s == null ? "running" : `running ${age(run_s)}`);
      const desc = String(a.desc || "").replace(/^\S+:\s*/, "");
      txt(dk, desc.length > 38 ? desc.slice(0, 37) + "…" : desc);
      const idle = a.idle_s == null ? NaN : +a.idle_s;
      txt(ff, `for ${sname}${isFinite(idle) ? `, quiet ${age(idle)}` : ""}`);
      const slot = perSid.get(a.sid) || 0; perSid.set(a.sid, slot + 1);
      const st = agentState.get(a.id) || {};
      st.slot = slot; st.i = i; st.id = a.id; st.type = a.type || "agent"; st.gp = gp; st.sid = a.sid; st.start = a._start; st.alive = true;
      if (!st.el) makeCol(st);
      agentState.set(a.id, st);
    });
    for (const [id, e] of agentEls) if (!ids.has(id)) {
      agentEls.delete(id);
      if (SNAP) e.remove();
      else e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: "ease", fill: "forwards" }).onfinish = () => e.remove();
    }
    // A finished agent's column sinks; its trail leaves the canvas at once, and the faint
    // finished trail (from the events) takes its place.
    for (const [id, st] of agentState) if (!ids.has(id)) { sinkCol(st); agentState.delete(id); }
    view.agentCols = [...agentState.values()];
    view.agentSig = view.agentCols.map((x) => `${x.id}/${x.sid}/${x.slot}/${x.i}/${x.start != null}`).join();
    // today's spawns by type, the five largest
    const an = s.analytics || {}, today = (an.spawns && an.spawns.today) || {};
    const ent = Object.entries(today).sort((a, b) => b[1] - a[1]);
    // Fewer rows the more agents run, so the block ends above the far range's crests (y 422
    // at their highest; measured with ?agents, three agents ran to y 447 and crossed them).
    const dense = run.length >= 3;
    if (agents._dense !== dense) { agents._dense = dense; agents.classList.toggle("dense", dense); }
    const total = ent.reduce((a, x) => a + x[1], 0), top = ent.slice(0, dense ? 1 : run.length === 2 ? 2 : run.length ? 3 : 5), mx = top.length ? top[0][1] : 1;
    txt(spHd, total ? `${F.int(total)} spawned today` : "Nothing spawned today");
    const toks = (an.agent_tokens && an.agent_tokens.today) || {};
    html(spGrid, top.map(([k, v]) => `<span class="${k === "general-purpose" ? "gp" : "k"}" style="font-size:11.5px">${esc(k)}</span><span class="n">${F.int(v)}${toks[k] ? `, ${F.tokens(toks[k].out)} out` : ""}</span><div class="bar${k === "general-purpose" ? " gp" : ""}"><i style="transform:scaleX(${(v / mx).toFixed(3)})"></i></div>`).join(""));
    const gp = an.general_purpose;
    if (gp && gp.d14) {
      const d14 = Object.values((an.spawns && an.spawns.d14) || {}).reduce((a, b) => a + b, 0);
      const from = (gp.by_session_today || [])[0];
      if (dense) html(gpF, `<span class="gp">general-purpose: ${F.int(gp.d14)} of ${F.int(d14)} in 14 days</span>`);
      else html(gpF, `<span class="gp">general-purpose made ${F.int(gp.d14)} of ${F.int(d14)} spawns</span><br>in 14 days (${gp.share_d14}%)${gp.today ? `; ${F.int(gp.today)} today${from && run.length < 2 ? `,<br>${from[1] === gp.today ? "all" : F.int(from[1])} from ${esc(from[0])}` : ""}` : ""}`);
    } else html(gpF, "");
    void d;
  }

  function updateRail(s) {
    const y = s.sys;
    if (!y) return;
    R.cpu.set(y.cpu);
    // core bars: one scaleY per update; the CSS transition (var(--kiln-tween)) moves them,
    // in whole device pixels of the 14 px bar (28 levels). A bar moves once the load is a
    // whole device pixel from what it shows, not on every rounding flip: each transform
    // written re-runs WebKit's compositing pass over every layer, and rounding put one on
    // 54% of lines at 100 ms (78% at 300); this puts one on 19% (31%), never more than a
    // device pixel from the value (pass 3, replayed from the live feed).
    (y.cores || []).forEach((v, i) => {
      const e = R.cores[i]; if (!e) return;
      const x = clamp(v / 100, 0.04, 1) * 28;
      if (e._lv != null && Math.abs(x - e._lv) < 1) return;
      e._lv = Math.round(x); e.style.transform = `scaleY(${(e._lv / 28).toFixed(3)})`;
    });
    const busy = (y.top_cpu || [])[0];
    txt(R.cpuN[0], (y.load || [0])[0].toFixed(2));
    txt(R.cpuN[1], y.gpu == null ? "–" : String(Math.round(y.gpu)));
    txt(R.proc, busy ? String(busy[0]) : ""); txt(R.cpuN[2], busy ? String(Math.round(busy[1])) : "–");
    // The 2-minute sparklines scroll about a pixel a second, and at 100 ms a series holds
    // 1,200 points: they are redrawn at most every 0.35 s (every line from 400 ms, where
    // they also slide on the compositor), not on every line.
    const drawSparks = s.t - (updateRail.st || 0) >= 0.35;
    if (drawSparks) updateRail.st = s.t;
    const cpuSer = drawSparks ? Kiln.series("cpu") : null;
    if (drawSparks) spark(R.sparks[0], "cpu", cpuSer, Math.max(20, nice(Math.max(...cpuSer.map((p) => p.v)) * 1000) / 1000));
    const m = y.mem || {}, gb = (v) => ((v || 0) / 2 ** 30).toFixed(1);
    R.mem.set(m.used); txt(R.memS, `of ${Math.round((m.total || 0) / 2 ** 30)} GB`);
    const pr = m.pressure || "–", prc = "gk w" + (pr === "warn" || pr === "critical" ? " gp" : "");
    txt(R.memP, `pressure ${pr}`); if (R.memP.className !== prc) R.memP.className = prc;
    txt(R.memN[0], gb(y.swap)); txt(R.memN[1], gb(m.compressed));
    if (drawSparks) spark(R.sparks[1], "mem", Kiln.series("mem"), m.total);
    const n = y.net || {};
    R.net.set(n.rx_bps);
    rateTo(R.netN[0], R.netU[0], n.tx_bps);
    if (drawSparks) {
      const rxs = Kiln.series("rx"), rpk = Math.max(1, ...rxs.map((p) => p.v));
      rateTo(R.netN[1], R.netU[1], rpk);
      // the peak is over the data really held: hist.span_s after a feed restart (the
      // series' own steps once the page has tracked longer), never a blanket "2 min"
      let cov = 0;
      for (let i = 1; i < rxs.length; i++) { const dt = rxs[i].t - rxs[i - 1].t; if (dt > 0 && dt <= 5) cov += dt; }
      cov = Math.min(120, Math.max(cov, (s.hist && s.hist.span_s) || 0));
      txt(R.netPk, `${cov >= 90 ? Math.round(cov / 60) + " min" : Math.max(1, Math.round(cov)) + " s"} peak`);
      spark(R.sparks[2], "rx", rxs, rpk);
    }
    const dk = y.disk || {};
    R.disk.set(dk.free);
    txt(R.diskN[0], String(Math.round((dk.total || 0) / 1e9)));
    rateTo(R.diskN[1], R.diskU[1], dk.read_bps); rateTo(R.diskN[2], R.diskU[2], dk.write_bps);
    const b = y.batt || {};
    R.bat.set(b.pct);
    txt(R.batF, b.charging ? "charging" : b.ac ? "on power, not charging" : b.mins_left ? `on battery, ${age(b.mins_left * 60)} left` : "on battery");
  }

  // ---------- the period readout (btop's corner) -------------------------------------
  // The figure sits in a four-digit slot, right-aligned, so "ms" and the dot never move
  // between 900 and 1000.
  let hiTimer = 0;
  function showPeriod(ms, hi) {
    txt(periodTx, String(ms));
    if (hi) { period.classList.add("hi"); clearTimeout(hiTimer); hiTimer = setTimeout(() => period.classList.remove("hi"), 1500); }
  }
  showPeriod(Kiln.period, false);
  Kiln.onPeriod((ms) => showPeriod(ms, true));
  // The live dot beats on Kiln.onBeat (about once a second at any period; on every line it
  // strobed at 100 ms): a soft rise and fall of opacity, .5 → 1 → .5 over 600 ms. Its job is
  // to stay steady while data flows; under html.kiln-stale the stylesheet dims it.
  Kiln.onBeat(() => {
    if (SNAP) return;
    periodDot.animate([{ opacity: 0.5 }, { opacity: 1, offset: 0.4 }, { opacity: 0.5 }], { duration: 600, easing: "ease-in-out" });
  });

  // ---------- go -------------------------------------------------------------------
  // DEV ONLY (?fixture&measure): every text run's box, colour and size as JSON in #measure,
  // for the contrast check against the ?bare render (palmath.apca on the real pixels).
  function measure() {
    const out = [], walk = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
    const sr = stage.getBoundingClientRect(), k = sr.width / W;   // boxes in stage px, whatever the window
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement, cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      let op = 1;
      for (let p = el; p && p !== stage; p = p.parentElement) op *= +getComputedStyle(p).opacity;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const b of r.getClientRects()) if (b.width > 1) out.push({ t: n.textContent.trim().slice(0, 40), x: (b.left - sr.left) / k, y: (b.top - sr.top) / k, w: b.width / k, h: b.height / k, c: cs.color, fs: parseFloat(cs.fontSize), op });
    }
    let m = $("measure");
    if (!m) { m = document.createElement("script"); m.type = "application/json"; m.id = "measure"; document.body.appendChild(m); }
    m.textContent = JSON.stringify(out);
  }

  // DEV ONLY (?fixture&agents): the captured feed has no running agents, so this lends two
  // to its real sessions to check the columns and their rows. Never active in the host.
  const lendAgents = dev && q.has("agents");
  let errEl = null;
  if (dev) addEventListener("error", (e) => {
    errEl = errEl || mk("lb", stage); errEl.id = "err";
    errEl.style.cssText = "left:80px;top:400px;color:#f88;font-size:13px;z-index:9;white-space:pre";
    errEl.textContent = String((e.error && e.error.stack) || e.message);
  });
  Kiln.on((s) => {
    if (!s || !s.t) return;
    if (lendAgents && s.claude && s.claude.sessions && s.claude.sessions.length > 2) {
      const ss = s.claude.sessions, t = s.t;
      // the live feed's shape: {id, sid, session, type, desc, started, age_s, idle_s}
      s.claude.agents_running = [
        { id: "dev-a", sid: ss[2].sid, session: ss[2].name, type: "general-purpose", desc: "general-purpose: benchmark the ingest batch sizes", started: t - 2580, age_s: 2580, idle_s: 40 },
        { id: "dev-b", sid: ss[0].sid, session: ss[0].name, type: "researcher", desc: "researcher: cache eviction survey B", started: t - 1320, age_s: 1320, idle_s: 12 },
        { id: "dev-c", sid: ss[1].sid, session: ss[1].name, type: "tester", desc: "tester: run the web suite", started: null, age_s: 95.4, idle_s: null },
      ];
    }
    try {
      update(s);
      if (dev && q.has("measure")) measure();
      if (dev && q.has("stats")) {   // DEV ONLY: runtime frames and updates, for the cost self-check
        let m = $("kstats");
        if (!m) { m = document.createElement("script"); m.type = "application/json"; m.id = "kstats"; document.body.appendChild(m); }
        m.textContent = JSON.stringify(Object.assign({ now: performance.now(), period: Kiln.period, livePaints }, Kiln.stats));
      }
    }
    catch (e) {
      if (dev) { errEl = errEl || mk("lb", stage); errEl.style.cssText = "left:80px;top:400px;color:#f88;font-size:13px;z-index:9;white-space:pre"; errEl.textContent = String(e.stack || e); }
      throw e;
    }
  });
})();
