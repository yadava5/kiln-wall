// vignette.js: the Ledger's engraved weather plate, live.
//
// Oxford, Ohio, looking south from the campus: the Beta Bell Tower (the brick shaft, the
// white belfry and its cap), a Georgian hall with a cupola and an arched passage in the
// manner of Upham Hall, the trees of the season and the lamp at the tower's foot. Drawn
// from the Commons photographs named in PLATE.md; nothing is traced. By day it is printed
// in black ink on paper; by night as a white-line engraving, light lines cut out of the
// dark block. The real light picks the print, never the edition (update).
//
// LAYERS, back to front, each a canvas painted once per change of the key:
//   sky      the open sky's hatching, the sun or the stars and the moon, the lamp's halo
//   twinkle  two sparse sets of stars whose opacity breathes (clear nights only)
//   cloud    the cloud, periodic along x, translated at the wind's speed and direction
//   front    the ridge, the buildings, the trees, the ground, the lamp, the fog, the frame
//   fall     rain or snow, periodic along the fall vector (two depths)
//   flash    the storm's fork and the lit deck, opacity 0 between strikes
// Every moving layer is periodic, so its motion is one infinite, linear Web Animation of
// its transform (cloud, rain, snow) or opacity (stars, lightning) that the compositor
// runs: no frame of it touches JS (measured 2026-11-05: the same cloud drift from
// Kiln.loop at 10 fps cost 1.3 points of WebContent). A repaint happens when the key
// changes: the sun in 1% steps of the day, the windows as they go out, the cloud in 5%
// steps, the wind, the moon; at most once a minute (the caller's weather tick).
(function () {
  "use strict";
  // as index.html: the Night print is white ink cut from the black paper; its luminaries
  // (the moon, the fork) are in the gold ink. The Day print has no gold: ink and paper only.
  const PAL = {
    day: { paper: "#F0DFD0", ink: "#1C2430", lamp: "#F3D6A6" },
    night: { paper: "#12100E", ink: "#F2EDE4", lamp: "#F3D6A6", gold: "#DBB762", sheen: "#F1D78A" },
  };
  const WET = { drizzle: 1, rain: 1, storm: 1 };
  const DECK = { cloudy: 1, drizzle: 1, rain: 1, snow: 1, storm: 1 };
  const KINDS = ["clear", "partly", "cloudy", "fog", "drizzle", "rain", "snow", "storm"];
  // cloud cover the kind implies when the feed gives none, and the range it can honestly show
  const COVER = { clear: [0, 0, 0], partly: [0.45, 0.2, 0.75], cloudy: [0.95, 0.8, 1], fog: [0.2, 0, 0.3],
    drizzle: [0.9, 0.8, 1], rain: [0.95, 0.8, 1], snow: [0.95, 0.8, 1], storm: [0.97, 0.85, 1] };
  const TAU = 2 * Math.PI;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  // piecewise-linear through pts [[x, y]...], clamped at the ends
  function pl(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
    return pts[pts.length - 1][1];
  }
  function rng(seed) { let s = seed % 2147483647 || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

  // value noise on a fixed lattice, so the same weather always engraves the same sky; px
  // wraps the lattice along x every px cells, which makes a field periodic (the cloud layer)
  const G = 48, lat = Float32Array.from({ length: G * G }, rng(9));
  const sm = (t) => t * t * (3 - 2 * t);
  function vn(x, y, px = G) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const at = (i, j) => lat[(((j % G) + G) % G) * G + (((i % px) + px) % px)];
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * xf;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * xf;
    return a + (b - a) * yf;
  }
  const grain = (x, y) => vn(x / 9, y / 5);

  // The moon's age as a fraction of the synodic month (0 new, .5 full), from the
  // reference new moon of 6 Jan 2000 18:14 UTC.
  const moonPhase = (t) => ((((t / 86400 + 2440587.5 - 2451550.1) / 29.530588853) % 1) + 1) % 1;
  function midnight(t) { const d = new Date(t * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }

  // ---------- what the plate shows, from the live weather and state.t ----------
  // o: dev overrides {kind, sky}. ?weather=<kind> also supplies a typical rate when
  // the live line reports none, so every kind can be checked on a dry night.
  function scene(wx, t, o) {
    const kind = KINDS.includes(o.kind) ? o.kind : KINDS.includes(wx.kind) ? wx.kind : "cloudy";
    let sunF = null, day = !!wx.is_day, rise = wx.sunrise, set = wx.sunset;
    if (rise && set) {
      // today's times, shifted by whole days if the report predates midnight
      const shift = Math.round((midnight(t) - midnight(rise)) / 86400) * 86400;
      rise += shift; set += shift;
      sunF = (t - rise) / (set - rise);
      day = sunF > 0 && sunF < 1;
    }
    const realDay = day;
    if (o.sky) { day = o.sky === "day"; if (day && !(sunF > 0 && sunF < 1)) sunF = 0.36; }
    // hours since sunset and until sunrise: the hall's windows go out through the night
    let hs = 2, hb = 8;
    if (rise && set && !day && !(o.sky && realDay)) {
      hs = (t > set ? t - set : t + 86400 - set) / 3600;
      hb = (t < rise ? rise - t : rise + 86400 - t) / 3600;
    }
    const lit = day ? 0 : Math.max(pl([[0, 0.85], [2, 0.7], [4, 0.45], [6, 0.18], [10, 0.1]], hs), hb < 1.5 ? 0.3 : 0);
    // The moon rides the sun's track, lagging it by its age (new: with the sun; full:
    // opposite). u is the position along the track: 0 rising, 1 setting, beyond 1 below.
    const p = moonPhase(t), moonLit = (1 - Math.cos(TAU * p)) / 2;
    let moonU = null;
    if (rise && set) { const dayLen = set - rise; moonU = ((((t - rise - p * 86400) % 86400) + 86400) % 86400) / dayLen; }
    let precip = Math.max(wx.precip_mm || 0, wx.rain_mm || 0), snow = wx.snow_cm || 0;
    if (o.kind) {
      if (kind === "drizzle" && !precip) precip = 0.2;
      if (kind === "rain" && !precip) precip = 1.6;
      if (kind === "storm" && !precip) precip = 5;
      if (kind === "snow" && !snow) snow = 0.6;
    }
    // The plate faces south, as an almanac's sun diagram does: the sun rises on the left
    // (east) and sets on the right. So a west wind carries cloud and rain leftward, and
    // the vane on the tower points right, into it. North and south winds show end-on.
    const mph = (wx.wind_kmh || 0) / 1.609, dir = wx.wind_dir || 0, sx = Math.sin(dir * Math.PI / 180);
    const slant = clamp(sx * Math.min(1, mph / 20) * 0.5, -0.35, 0.35);
    const vx = sx * clamp(mph, 0, 40) * 0.3;   // cloud drift, px/s: 10 mph crosses the plate in two minutes
    const cv = COVER[kind], cover = wx.cloud == null || o.kind ? cv[0] : clamp(wx.cloud / 100, cv[1], cv[2]);
    const month = new Date(t * 1000).getMonth();
    return {
      kind, day, sunF: day ? sunF : null, precip, snow, slant, vx, cover, lit, vane: -sx,
      wet: !!WET[kind] || (precip > 0 && kind !== "snow"),
      falls: kind === "snow" ? true : !!WET[kind] || precip > 0,
      phase: p, moonLit, moonU, bare: month >= 10 || month <= 2,
      sunrise: rise, sunset: set,
    };
  }

  // ---------- the engraving's tools ----------
  // A canvas at the device ratio, w x h in page px
  function canvas(w, h, cls) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), cv = document.createElement("canvas");
    if (cls) cv.className = cls;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { cv, c };
  }
  // The burin's tools for one print. b is light, 0 (black) .. 1 (lit), for every point:
  // the Night print cuts light lines whose weight grows with b, the Day print inks dark
  // lines whose weight grows with 1 - b. f < 0 means no line here at all. With a period,
  // the lines' drift and their sampling repeat every period px, so a layer drawn with
  // them tiles seamlessly along x.
  function tools(c, ed, period) {
    const P = PAL[ed], dayPrint = ed === "day";
    const dark = dayPrint ? P.ink : P.paper, light = dayPrint ? P.paper : P.ink;
    const wt = (b, max) => (dayPrint ? 0.25 + (1 - b) * max : 0.15 + b * max);
    // the line is never ruled: each one drifts by under a pixel along its run, which is
    // what separates an engraving from scan lines at 2x
    const wob = period ? (xx, yy) => (vn(xx * 8 / period + 3, yy / 7, 8) - 0.5) * 0.9 : (xx, yy) => (vn(xx / 46 + 3, yy / 7) - 0.5) * 0.9;
    const dx = period ? period / Math.round(period / 3) : 3;
    // a run of engraved lines between y0 and y1 (and x0..x1): each line is one polygon
    // whose thickness follows f; all of them filled in one pass
    function band(y0, y1, step, max, f, col, x0 = 0, x1 = 1e4) {
      c.fillStyle = col || P.ink;
      c.beginPath();
      for (let yy = y0; yy < y1; yy += step) {
        const bot = [];
        for (let xx = x0; xx <= x1 + 4; xx += dx) {
          const v = f(xx, yy), q = v < 0 ? 0 : wt(v, max) / 2, yc = yy + wob(xx, yy);
          if (xx === x0) c.moveTo(xx, yc - q); else c.lineTo(xx, yc - q);
          bot.push(xx, yc + q);
        }
        for (let i = bot.length - 2; i >= 0; i -= 2) c.lineTo(bot[i], bot[i + 1]);
        c.closePath();
      }
      c.fill();
    }
    function clipped(path, fn) { c.save(); c.clip(path); fn(); c.restore(); }
    // A solid: by day paper hatched to its tone (b) under an ink outline; by night the
    // dark block, with fine lines cut into it only where the lamp reaches (reach, 0..1),
    // so the block keeps its silhouette and stays darker than the sky.
    function block(path, b, reach, y0, y1) {
      if (dayPrint) {
        c.fillStyle = P.paper; c.fill(path);
        clipped(path, () => band(y0, y1, 2.6, 2, (xx, yy) => b + 0.05 * grain(xx, yy)));
        c.strokeStyle = P.ink; c.globalAlpha = 0.7; c.lineWidth = 0.6; c.stroke(path); c.globalAlpha = 1;
      } else {
        c.fillStyle = P.paper; c.fill(path);
        if (reach) clipped(path, () => band(y0, y1, 2.2, 0.9, (xx, yy) => { const k = reach(xx, yy); return k < 0.04 ? -1 : k * 0.6; }, P.ink));
        c.strokeStyle = P.ink; c.globalAlpha = 0.55; c.lineWidth = 0.6; c.stroke(path); c.globalAlpha = 1;
      }
    }
    // White paint (a belfry, a cupola, a cornice): by day bare paper under an outline; by
    // night fine lines on a close pitch, which read as a pale tone against the black
    function white(path, y0, y1) {
      if (dayPrint) { c.fillStyle = P.paper; c.fill(path); c.strokeStyle = P.ink; c.globalAlpha = 0.8; c.lineWidth = 0.6; c.stroke(path); c.globalAlpha = 1; }
      else { c.fillStyle = P.paper; c.fill(path); clipped(path, () => band(y0, y1, 1.7, 1.1, () => 0.6, P.ink)); }
    }
    return { P, dayPrint, dark, light, wt, band, clipped, block, white };
  }
  function rect(x, y, w, h) { const p = new Path2D(); p.rect(x, y, w, h); return p; }
  function poly(pts) { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return p; }

  // the plate's geometry, shared by every layer
  function geo(w, h, sc) {
    const horizon = Math.round(h * 0.7), ground = horizon + 4, street = horizon + 26;
    const tx = Math.round(w * 0.64), lx = tx + 22, ly = horizon - 18;
    const sun = sc.day && sc.sunF != null ? trackAt(w, horizon, clamp(sc.sunF)) : null;
    const clearish = sc.kind === "clear" || sc.kind === "partly";
    let moon = null;
    if (clearish && sc.moonLit > 0.04) {
      if (sc.moonU == null) moon = sc.day ? null : [w * 0.2, 30];
      else if (sc.moonU > 0.04 && sc.moonU < 0.96 && (!sc.day || sc.moonLit > 0.25)) moon = trackAt(w, horizon, sc.moonU);
    }
    // by day a moon near the sun is lost in its light
    if (moon && sun && Math.hypot(moon[0] - sun[0], moon[1] - sun[1]) < 40) moon = null;
    return { w, h, horizon, ground, street, tx, lx, ly, sun, moon, clearish, lampOn: !sc.day };
  }
  // the sun's track across the plate: u 0 at the left horizon (rising), 1 at the right
  const trackAt = (w, horizon, u) => [w * (0.12 + 0.76 * u), horizon - 14 - Math.sin(Math.PI * u) * (horizon - 46)];

  // ---------- the sky ----------
  function paintSky(w, h, sc, ed, g) {
    const { cv, c } = canvas(w, h), T = tools(c, ed), { P, dayPrint, dark, light } = T;
    const k = sc.kind, { horizon, lx, ly, sun, moon } = g;
    c.fillStyle = P.paper; c.fillRect(0, 0, w, h);
    // light, 0..1, for every point of the open sky (the cloud has its own layer)
    const sky = (x, y) => {
      const gr = clamp((y - 40) / (horizon - 40)), cf = grain(x, y);
      let b;
      if (sc.day) {
        if (k === "fog") b = 0.8 + 0.1 * cf;
        else if (k === "storm") b = 0.28 + 0.12 * gr;
        else if (DECK[k]) b = 0.5 + 0.12 * gr;
        else b = 0.7 + 0.14 * (y / horizon);
        if (sun) {
          const d = Math.hypot(x - sun[0], y - sun[1]);
          b += g.clearish ? Math.max(0, 1 - d / 42) * 0.6 : k === "storm" ? 0 : Math.max(0, 1 - d / 90) * 0.18;
        }
      } else {
        const lamp = Math.max(0, 1 - Math.hypot(x - lx, y - ly) / 46);
        if (k === "fog") b = 0.3 + 0.1 * cf + gr * 0.22;
        else if (k === "storm") b = 0.03 + gr * gr * 0.2;
        else if (DECK[k]) b = 0.08 + gr * gr * 0.4 + (k === "snow" ? 0.1 : 0);   // the deck's lit base shows at the horizon
        else b = 0.04 + gr * gr * 0.22;
        b += lamp * (k === "fog" ? 0.5 : 0.9);
        if (moon) b += Math.max(0, 1 - Math.hypot(x - moon[0], y - moon[1]) / 34) * 0.4 * sc.moonLit;
      }
      return clamp(b);
    };
    T.band(2, horizon + 4, 2.6, 1.8, sky);
    if (sun && g.clearish) {
      c.fillStyle = light; c.beginPath(); c.arc(sun[0], sun[1], 7, 0, TAU); c.fill();
      c.strokeStyle = P.ink; c.globalAlpha = 0.6; c.lineWidth = 0.8; c.beginPath(); c.arc(sun[0], sun[1], 9.5, 0, TAU); c.stroke(); c.globalAlpha = 1;
    }
    // stippled stars; the twinkle layers take a few of them
    const stars = [];
    if (!sc.day && g.clearish) {
      const r = rng(5);
      c.fillStyle = light;
      for (let i = 0; i < 90; i++) {
        const x = r() * w, y = 4 + r() * (horizon - 40), s = 0.45 + r() * 0.7, a = 0.45 + r() * 0.55;
        if (moon && Math.hypot(x - moon[0], y - moon[1]) < 16) continue;
        c.globalAlpha = a; c.beginPath(); c.arc(x, y, s, 0, TAU); c.fill();
        stars.push([x, y, s, a]);
      }
      c.globalAlpha = 1;
    }
    if (moon) {
      // the moon at its real phase: the lit limb, closed by the terminator ellipse. By night
      // it is the one thing on the sky in the gold ink; by day a pale disc.
      const [mx, my] = moon, r = 6.5, p = sc.phase, waxing = p < 0.5, crescent = sc.moonLit < 0.5;
      c.fillStyle = dark; c.globalAlpha = dayPrint ? 0.35 : 1; c.beginPath(); c.arc(mx, my, r + 0.6, 0, TAU); c.fill(); c.globalAlpha = 1;
      c.fillStyle = dayPrint ? light : P.gold; c.beginPath();
      c.arc(mx, my, r, -Math.PI / 2, Math.PI / 2, !waxing);
      const rx = r * Math.abs(Math.cos(TAU * p));
      if (waxing === crescent) c.ellipse(mx, my, rx, r, 0, Math.PI / 2, -Math.PI / 2, true);
      else c.ellipse(mx, my, rx, r, 0, Math.PI / 2, (3 * Math.PI) / 2, false);
      c.fill();
    }
    return { el: cv, stars };
  }
  // Two sparse sets of the sky's stars, drawn a little brighter than on the sky; their
  // opacity breathes against each other (10.5 s and 7 s), so the stars twinkle.
  function twinkleLayers(w, sc, ed, g, stars) {
    const light = PAL[ed].ink, H = g.horizon - 30, out = [];
    for (const set of [0, 1]) {
      const { cv, c } = canvas(w, H, "twinkle");
      c.fillStyle = light;
      stars.forEach(([x, y, s, a], i) => {
        if (i % 4 !== set * 2) return;
        c.globalAlpha = Math.min(1, a + 0.45); c.beginPath(); c.arc(x, y, s + 0.25, 0, TAU); c.fill();
      });
      cv.style.opacity = 0.5;
      out.push({ el: cv, dur: set ? 3500 : 5250, delay: set * 2100 });
    }
    return out;
  }

  // ---------- the cloud: one layer, periodic along x, moved by the wind ----------
  // The layer is three plates wide and sits at left = -w, so translated anywhere within
  // one plate width either way it still covers the plate; the cloud field, the lines'
  // drift and their sampling all repeat every w, so the join never shows as it crosses.
  // Where there is cloud the layer is opaque paper, engraved to its tone; elsewhere it is
  // clear, so the sky, the stars and the moon show through the gaps, and a cloud passing
  // covers them.
  function cloudLayer(w, sc, ed, g) {
    const { horizon } = g, H = horizon + 4, W = 3 * w, k = sc.kind;
    // the field: three octaves, each an integer number of cells per plate width
    const cf = (x, y) => 0.6 * vn(x * 6 / w, y / 26, 6) + 0.3 * vn(x * 12 / w + 5, y / 11 + 2, 12) + 0.1 * vn(x * 48 / w, y / 5, 48);
    // the threshold that covers the real share of the sky: the field's quantile
    const samples = [];
    for (let y = 2; y < horizon - 40; y += 4) for (let x = 0; x < w; x += 4) samples.push(cf(x, y));
    samples.sort((a, b) => a - b);
    const th = samples[Math.min(samples.length - 1, Math.floor((1 - sc.cover) * samples.length))];
    // the mask, 0..1: the field above its threshold, thinning to nothing toward the horizon
    // along a ragged base (a deck's underside is never a rule)
    const base = (x) => horizon - 30 - 14 * vn(x * 8 / w + 3, 2.5, 8) - 6 * vn(x * 24 / w, 6.5, 24);
    const mask = (x, y) => { const b = base(x); return sstep(th - 0.04, th + 0.04, cf(x, y)) * sstep(b + 14, b - 12, y); };
    const { cv, c } = canvas(W, H, "cloud"), T = tools(c, ed, w), { P, dayPrint, dark } = T;
    cv.style.left = -w + "px"; cv.style.top = "0px";
    // the cloud's body, row by row
    c.fillStyle = P.paper;
    for (let y = 0; y < H; y += 1) {
      let x0 = -1;
      for (let x = 0; x <= W; x += 1) {
        const inside = x < W && mask(x, y) > 0.5;
        if (inside && x0 < 0) x0 = x;
        else if (!inside && x0 >= 0) { c.fillRect(x0, y, x - x0, 1.3); x0 = -1; }
      }
    }
    // its tone: the belly (the underside, where the field falls away below) is lit by the
    // town at night and shaded by day; the tops are dark by night, bare paper by day
    const belly = (x, y) => clamp((cf(x, y) - cf(x, y + 12)) * 3);
    const tone = (x, y) => {
      if (mask(x, y) <= 0.5) return -1;
      const gr = clamp((y - 40) / (horizon - 40)), be = belly(x, y);
      if (dayPrint) {
        if (k === "partly" || k === "clear") return 0.96 - be * 0.5;
        if (k === "storm") return 0.42 - be * 0.3 + 0.08 * gr;
        if (k === "snow") return 0.8 - be * 0.22;
        if (k === "drizzle") return 0.74 - be * 0.3;
        return 0.62 - be * 0.35 - 0.1 * (1 - gr);
      }
      // by night the cloud is a dark mass; only its bellies and its base, which the town
      // lights, take lines, so the sky keeps its black
      if (k === "storm") return 0.02 + be * 0.25 * (0.2 + gr);
      if (k === "partly") return 0.03 + be * 0.45 * (0.3 + gr) + gr * gr * 0.2;
      return 0.03 + be * 0.3 * (0.25 + gr) + gr * gr * 0.3 + (k === "snow" ? 0.08 : 0);
    };
    T.band(0, H, 2.6, 1.8, tone, undefined, 0, W);
    // cross-hatching, cut across the cloud in proportion to how much sky it covers: it
    // breaks the lines, so the deck reads rougher and darker in either print
    const xh = k === "storm" ? 0.55 : k === "partly" || k === "clear" ? 0 : (k === "snow" ? 0.15 : k === "drizzle" ? 0.22 : 0.32) * clamp((sc.cover - 0.5) / 0.5);
    if (xh > 0) {
      c.strokeStyle = dark; c.globalAlpha = xh; c.lineWidth = 0.7; c.lineCap = "butt";
      const ca = Math.cos(0.6), sa = Math.sin(0.6), ds = w / Math.round(w / 5);
      for (let s = -H; s < W; s += ds) {
        let on = false;
        c.beginPath();
        for (let t = 0; t < H / sa + 3; t += 3) {
          const x = s + t * ca, y = H - t * sa, inside = y >= 0 && mask(x, y) > 0.5;
          if (inside && !on) c.moveTo(x, y); else if (inside) c.lineTo(x, y);
          on = inside;
        }
        c.stroke();
      }
      c.globalAlpha = 1;
    }
    return { el: cv, W: w, vx: sc.vx, anim: null, from: 0, to: 0, dur: 0 };
  }

  // ---------- the front: the ridge, the campus, the ground, the lamp ----------
  function paintFront(w, h, sc, ed, g) {
    const { cv, c } = canvas(w, h), T = tools(c, ed), { P, dayPrint, dark, light } = T;
    const k = sc.kind, { horizon, ground, street, tx, lx, ly, lampOn } = g;
    const lampCol = lampOn ? P.lamp : P.ink;

    // far: a soft tree line held to a narrow, pale weight range; fog swallows it
    if (k !== "fog") {
      const far = new Path2D();
      far.moveTo(0, ground); far.lineTo(0, horizon - 14);
      for (let x = 0; x <= w + 8; x += 8) far.lineTo(x, horizon - 12 - 9 * vn(x / 60 + 11, 3) - 4 * vn(x / 20 + 4, 7));
      far.lineTo(w + 8, ground); far.closePath();
      c.fillStyle = P.paper; c.fill(far);
      const pale = k === "snow" ? (dayPrint ? 0.8 : 0.5) : dayPrint ? 0.62 : 0.32;
      T.clipped(far, () => T.band(horizon - 34, ground, 2.4, 0.9, (x, y) => pale + 0.12 * vn(x / 30, y / 8)));
    }

    // what the lamp reaches, 0..1, for the night print's cut lines
    const reach = (xx, yy) => Math.max(0, 1 - Math.hypot(xx - lx, (yy - ly) * 1.6) / 60);
    // by day: brick a middle tone, slate darker, so the panes still read on the walls
    const wallTone = k === "fog" ? 0.6 : 0.5, roofTone = k === "fog" ? 0.45 : 0.25;
    const wins = [], lit = [], caps = [];
    const r = rng(17);

    // the trees of the season: bare from November to March, in leaf otherwise
    function tree(x, hgt, seed, big) {
      if (sc.bare) {
        const rr = rng(seed);
        // in the print's line: ink by day, cut lines by night
        c.strokeStyle = P.ink; c.lineCap = "round"; c.globalAlpha = dayPrint ? 0.9 : 0.85;
        const grow = (x0, y0, ang, len, wd, d) => {
          const x1 = x0 + Math.cos(ang) * len, y1 = y0 - Math.sin(ang) * len;
          c.lineWidth = wd; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
          if (!d) return;
          const n = d > 3 ? 2 : rr() < 0.4 ? 3 : 2;
          for (let i = 0; i < n; i++) grow(x1, y1, ang + (rr() - 0.5) * 1.1 + (i - (n - 1) / 2) * 0.55, len * (0.6 + rr() * 0.16), wd * 0.68, d - 1);
        };
        grow(x, ground, Math.PI / 2 + (rr() - 0.5) * 0.2, hgt * 0.3, big ? 2 : 1.5, 5);
        c.globalAlpha = 1;
      } else {
        // a crown of three lobes on a short trunk
        const p = new Path2D(), lw = hgt * 0.42, top = ground - hgt;
        p.moveTo(x - 1.2, ground); p.lineTo(x - 1.2, ground - hgt * 0.3); p.lineTo(x - lw, ground - hgt * 0.3);
        p.quadraticCurveTo(x - lw * 1.1, top + hgt * 0.25, x - lw * 0.45, top + hgt * 0.2);
        p.quadraticCurveTo(x, top - hgt * 0.12, x + lw * 0.45, top + hgt * 0.2);
        p.quadraticCurveTo(x + lw * 1.1, top + hgt * 0.25, x + lw, ground - hgt * 0.3);
        p.lineTo(x + 1.2, ground - hgt * 0.3); p.lineTo(x + 1.2, ground); p.closePath();
        T.block(p, 0.3, reach, top - 2, ground);
        caps.push([[x - lw * 0.4, top + hgt * 0.16, null], [x, top - hgt * 0.02], [x + lw * 0.4, top + hgt * 0.16]]);
      }
    }
    {
      // ---- the hall: three storeys of sash windows, a hipped roof with chimneys, the
      // central pavilion a little higher, the cupola on it, the arched passage below
      const x0 = Math.round(w * 0.03), x1 = Math.round(w * 0.47), xc = (x0 + x1) / 2, eave = horizon - 30, ridge = horizon - 47;
      const hall = poly([[x0, ground], [x0, eave], [x0 + 16, ridge], [xc - 22, ridge], [xc - 15, ridge - 8], [xc + 15, ridge - 8], [xc + 22, ridge], [x1 - 16, ridge], [x1, eave], [x1, ground]]);
      T.block(hall, wallTone, reach, ridge - 10, ground);
      // the roof, darker slate, as the part of the block above the eave
      const roof = poly([[x0, eave], [x0 + 16, ridge], [xc - 22, ridge], [xc - 15, ridge - 8], [xc + 15, ridge - 8], [xc + 22, ridge], [x1 - 16, ridge], [x1, eave]]);
      if (dayPrint) T.clipped(roof, () => T.band(ridge - 10, eave, 2.2, 2, (xx, yy) => roofTone + 0.05 * grain(xx, yy)));
      // chimneys, standing above the ridge; the eave line
      for (const cx of [x0 + 26, xc - 48, xc + 48, x1 - 26]) { const chim = rect(cx - 2, ridge - 4, 4, 12); T.block(chim, roofTone, null, ridge - 4, ridge + 8); caps.push([[cx - 2, ridge - 4], [cx, ridge - 4], [cx + 2, ridge - 4]]); }
      c.strokeStyle = P.ink; c.globalAlpha = dayPrint ? 0.8 : 0.35; c.lineWidth = 0.6; c.beginPath(); c.moveTo(x0, eave + 0.5); c.lineTo(x1, eave + 0.5); c.stroke(); c.globalAlpha = 1;
      // the cupola: a drum under a dome, a finial on top
      const cy = ridge - 8, drum = rect(xc - 5, cy - 12, 10, 12);
      T.white(drum, cy - 12, cy);
      const dome = new Path2D(); dome.moveTo(xc - 6, cy - 12); dome.quadraticCurveTo(xc - 6, cy - 19, xc, cy - 19); dome.quadraticCurveTo(xc + 6, cy - 19, xc + 6, cy - 12); dome.closePath();
      c.fillStyle = dark; c.fill(dome);
      c.strokeStyle = P.ink; c.lineWidth = 0.9; c.beginPath(); c.moveTo(xc, cy - 19); c.lineTo(xc, cy - 24); c.stroke();
      c.fillStyle = dark; c.fillRect(xc - 1.2, cy - 10, 2.4, 7);   // the drum's opening
      // the arch
      const arch = new Path2D(); arch.moveTo(xc - 4, ground); arch.lineTo(xc - 4, ground - 6); arch.arc(xc, ground - 6, 4, Math.PI, 0); arch.lineTo(xc + 4, ground); arch.closePath();
      c.fillStyle = dark; c.fill(arch);
      // the windows: bays across three floors, none where the arch is
      const rows = [eave + 5, eave + 15.5, eave + 26];
      for (let bx = x0 + 6; bx < x1 - 4; bx += 8.6) for (let f = 0; f < 3; f++) {
        if (f === 2 && Math.abs(bx - xc) < 6) continue;
        wins.push([bx, rows[f], r()]);
      }
      caps.push([[x0 + 16, ridge], [xc - 22, ridge], [xc - 22, ridge]], [[xc + 22, ridge], [x1 - 16, ridge], [x1 - 16, ridge]], [[xc - 15, ridge - 8], [xc, ridge - 8], [xc + 15, ridge - 8]]);

      // ---- the trees: one between the hall and the tower, the big one at the right
      tree(Math.round(w * 0.535), 46, 3, false);
      tree(Math.round(w * 0.86), 64, 4, true);
      tree(w + 4, 54, 6, false);

      // ---- the tower: the brick shaft to its cornice, the white belfry with its arched
      // opening, the cap, the finial and the vane; two louvred slits high on the shaft
      const shaft = rect(tx - 5.5, 58, 11, ground - 58);
      T.block(shaft, wallTone, reach, 56, ground);
      c.fillStyle = dark; c.fillRect(tx - 3.6, 63, 1.7, 11); c.fillRect(tx + 1.9, 63, 1.7, 11);
      T.white(rect(tx - 7, 54, 14, 4), 53, 58);
      T.white(rect(tx - 5.5, 42, 11, 12), 41, 54);
      const bell = new Path2D(); bell.moveTo(tx - 2, 53); bell.lineTo(tx - 2, 47); bell.arc(tx, 47, 2, Math.PI, 0); bell.lineTo(tx + 2, 53); bell.closePath();
      c.fillStyle = dark; c.fill(bell);
      const cap = new Path2D(); cap.moveTo(tx - 6.5, 42); cap.quadraticCurveTo(tx - 6, 36.5, tx, 36); cap.quadraticCurveTo(tx + 6, 36.5, tx + 6.5, 42); cap.closePath();
      c.fillStyle = dark; c.fill(cap);
      if (!dayPrint) { c.strokeStyle = P.ink; c.globalAlpha = 0.5; c.lineWidth = 0.6; c.stroke(cap); c.globalAlpha = 1; }
      c.strokeStyle = P.ink; c.lineWidth = 0.9; c.beginPath(); c.moveTo(tx, 36); c.lineTo(tx, 29); c.stroke();
      // the vane points into the wind; a wind along the line of sight shows end-on
      const vl = sc.vane * 5;
      c.lineWidth = 0.8; c.beginPath(); c.moveTo(tx - vl * 0.5, 30.5); c.lineTo(tx + vl, 30.5); c.stroke();
      c.fillStyle = P.ink; c.beginPath();
      if (Math.abs(vl) > 1.2) { c.moveTo(tx + vl + Math.sign(vl) * 2, 30.5); c.lineTo(tx + vl, 29); c.lineTo(tx + vl, 32); } else c.arc(tx, 30.5, 1, 0, TAU);
      c.closePath(); c.fill();
      caps.push([[tx - 7, 54], [tx, 54], [tx + 7, 54]], [[tx - 5, 39], [tx, 36], [tx + 5, 39]]);
    }

    // the windows: by day panes of sky in an ink frame; by night the lit ones, which go
    // out as the night goes on (sc.lit is the share still lit)
    if (sc.day) {
      c.strokeStyle = P.ink; c.lineWidth = 0.5; c.fillStyle = P.paper;
      for (const [wx, wy] of wins) { c.fillRect(wx, wy, 2.4, 3.4); c.strokeRect(wx, wy, 2.4, 3.4); }
    } else for (const [wx, wy, u] of wins) if (u < sc.lit) lit.push([wx, wy]);
    if (k === "snow") {
      // snow lies on the ridges, the eaves, the cornice and the cap
      c.strokeStyle = light; c.lineWidth = 2; c.lineCap = "round";
      for (const seg of caps) {
        c.beginPath();
        if (seg[0][2] === null) { c.moveTo(seg[0][0], seg[0][1]); c.quadraticCurveTo(seg[1][0], seg[1][1] - 1, seg[2][0], seg[2][1]); }
        else { c.moveTo(seg[0][0], seg[0][1]); c.lineTo(seg[1][0], seg[1][1]); c.lineTo(seg[2][0], seg[2][1]); }
        c.stroke();
      }
    }
    if (!sc.day) { c.fillStyle = P.lamp; for (const [wx, wy] of lit) c.fillRect(wx, wy, 2.4, 3.2); }

    // near: the ground, the walk; wet, it carries the lamp and the windows
    if (k === "snow") {
      c.fillStyle = P.paper; c.fillRect(0, ground, w, h - ground);
      T.band(ground + 2, h, 3, 1.4, (xx, yy) => 0.86 - 0.1 * vn(xx / 14, yy / 3));
    } else {
      c.fillStyle = sc.day ? P.paper : dark; c.fillRect(0, ground, w, h - ground);
      if (sc.day) T.band(ground + 2, h, 3, 1.8, (xx, yy) => (sc.wet ? 0.42 : 0.3) + 0.08 * vn(xx / 12, yy / 3));
      const rs = rng(23);
      c.strokeStyle = sc.day ? P.ink : light;
      for (let yy = ground + 3; yy < h; yy += 3) {
        for (let xx = (yy * 7) % 11; xx < w; xx += 14 + rs() * 10) {
          const near = lampOn ? Math.max(0, 1 - Math.abs(xx - lx) / 40) : 0, len = 3 + rs() * 6 + near * 10;
          const b = (sc.wet ? 0.12 : 0.06) + near * (sc.wet ? 0.8 : 0.35) * (1 - ((yy - ground) / (h - ground)) * 0.5);
          const keep = rs();
          if (sc.day && !sc.wet) continue;
          if (b > 0.18 || keep < (sc.wet ? 0.35 : 0.18)) {
            c.globalAlpha = 0.35 + b * 0.6; c.lineWidth = 0.3 + b * 1.1;
            c.beginPath(); c.moveTo(xx, yy); c.lineTo(xx + len, yy); c.stroke();
          }
        }
      }
      c.globalAlpha = 1;
      if (sc.wet && !sc.day) {
        c.strokeStyle = P.lamp; c.lineWidth = 0.9;
        for (const [wx] of lit) for (let i = 0; i < 5; i++) {
          c.globalAlpha = 0.55 - i * 0.1; c.beginPath(); c.moveTo(wx - 0.5, ground + 4 + i * 5); c.lineTo(wx + 3, ground + 4 + i * 5); c.stroke();
        }
        for (let i = 0; i < 18; i++) {
          c.globalAlpha = 0.9 - i * 0.045; c.lineWidth = 1.6 - i * 0.07;
          c.beginPath(); c.moveTo(lx, ground + 3 + i * 2.6); c.lineTo(lx + (i % 2 ? 1.5 : -1.5), ground + 4.5 + i * 2.6); c.stroke();
        }
        c.globalAlpha = 1;
      }
    }
    // the lamp at the tower's foot: post and lantern, lit after dark
    c.strokeStyle = P.ink; c.lineWidth = 1.6; c.beginPath(); c.moveTo(lx, ly + 3); c.lineTo(lx, ground + 2); c.stroke();
    c.fillStyle = lampCol;
    c.beginPath(); c.moveTo(lx - 3, ly - 3); c.lineTo(lx + 3, ly - 3); c.lineTo(lx + 2, ly + 3); c.lineTo(lx - 2, ly + 3); c.closePath(); c.fill();
    c.fillStyle = P.ink;
    c.beginPath(); c.moveTo(lx - 4.2, ly - 2.6); c.lineTo(lx, ly - 6.6); c.lineTo(lx + 4.2, ly - 2.6); c.closePath(); c.fill();

    if (k === "fog") {
      // fog: the tops dissolve into it (the front thins upward), and light lines lie over
      // the low ground, thickest at the horizon
      c.save(); c.globalCompositeOperation = "destination-out";
      const fg = c.createLinearGradient(0, horizon - 20, 0, 24);
      fg.addColorStop(0, "rgba(0,0,0,0)"); fg.addColorStop(1, "rgba(0,0,0,0.8)");
      c.fillStyle = fg; c.fillRect(0, 0, w, horizon - 20); c.restore();
      c.strokeStyle = light; c.lineWidth = 1.3;
      for (let yy = horizon - 46; yy < h; yy += 3) {
        c.globalAlpha = 0.55 * Math.max(0, 1 - Math.abs(yy - horizon - 6) / 52);
        c.beginPath(); c.moveTo(0, yy); c.lineTo(w, yy); c.stroke();
      }
      c.globalAlpha = 1;
    }
    c.strokeStyle = P.ink; c.lineWidth = 1; c.strokeRect(0.5, 0.5, w - 1, h - 1);
    return { el: cv, lit };
  }

  // the storm's fork of lightning: a soft 5 px stroke under a 1.6 px one; gold by night
  function strokeFork(c, w, horizon, ed, k) {
    const P = PAL[ed], r = rng(31), fork = [[w * 0.3, 4]];
    while (fork[fork.length - 1][1] < horizon - 16) { const [x, y] = fork[fork.length - 1]; fork.push([x + (r() - 0.4) * 14, y + 7 + r() * 9]); }
    const branch = [fork[3]];
    for (let i = 0; i < 4; i++) { const [x, y] = branch[branch.length - 1]; branch.push([x - 4 - r() * 8, y + 5 + r() * 6]); }
    for (const [lw, a, col] of [[5, 0.18 * k, ed === "day" ? P.paper : P.gold], [1.6, 1, ed === "day" ? P.paper : P.sheen]]) {
      c.strokeStyle = col; c.globalAlpha = a; c.lineWidth = lw; c.lineJoin = "miter";
      for (const line of [fork, branch]) { c.beginPath(); line.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); }
    }
    c.globalAlpha = 1;
  }

  // ---------- the storm's lightning: a flash layer over the plate ----------
  // Painted once with the plate: the deck lit from inside (a wash in the light ink round the
  // fork's head, which lifts the cloud) and the fork itself. Between strikes it is opacity
  // 0; each strike is a 0.75 s double flicker (up in 50 ms, a dip, a second, smaller return,
  // a 0.55 s fade), three of them in a 20 s cycle at uneven gaps (6.2, 8.5, 5.3 s). Without
  // motion the fork is cut into the front instead.
  function flashLayer(w, h, ed, g) {
    const P = PAL[ed], light = ed === "day" ? P.paper : P.ink, { horizon } = g;
    const { cv, c } = canvas(w, h, "flash");
    cv.style.opacity = 0;
    const gr = c.createRadialGradient(w * 0.3, 0, 0, w * 0.3, 0, w * 0.62);
    const rgb = [1, 3, 5].map((i) => parseInt(light.slice(i, i + 2), 16)).join(",");
    gr.addColorStop(0, `rgba(${rgb},0.62)`); gr.addColorStop(0.45, `rgba(${rgb},0.24)`); gr.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = gr; c.fillRect(0, 0, w, horizon + 4);
    strokeFork(c, w, horizon, ed, 2);
    return { el: cv };
  }
  const STRIKES = (() => {
    const env = [[0, 0], [0.05, 1], [0.13, 0.2], [0.2, 0.8], [0.75, 0]], cycle = 20, frames = [];
    for (const at of [0.3, 6.5, 15]) for (const [k, o] of env) frames.push({ offset: (at + k) / cycle, opacity: o });
    frames.unshift({ offset: 0, opacity: 0 }); frames.push({ offset: 1, opacity: 0 });
    return { frames, dur: cycle * 1000 };
  })();

  // ---------- rain and snow: periodic textures on their own layers ----------
  // A layer covers twice the plate's height and repeats along the fall vector
  // (slant * H, H), so translating it by that vector and wrapping is seamless.
  function fallLayer(w, h, sc, ed, near) {
    const P = PAL[ed], dayPrint = ed === "day";
    const dark = dayPrint ? P.ink : P.paper, light = dayPrint ? P.paper : P.ink;
    const snow = sc.kind === "snow", brightSky = sc.day && sc.kind !== "storm";
    const col = snow || !brightSky ? light : dark;
    const amt = clamp(snow ? sc.snow / 1.5 : sc.precip / 2.5);
    const slant = snow ? 0.06 : sc.slant, H = h, sx = Math.abs(slant) * H;
    const X0 = Math.ceil(2 * sx) + 10, W = w + 2 * X0;
    const { cv, c } = canvas(W, 2 * H, "fall");
    cv.style.left = -X0 + "px"; cv.style.top = -H + "px";
    // snow sways: the canvas falls inside a wrapper that rocks a few px side to side
    let wrap = null;
    if (snow) { wrap = document.createElement("div"); wrap.className = "sway"; wrap.style.cssText = "position:absolute;inset:0"; wrap.appendChild(cv); }
    const r = rng(near ? 41 : 43);
    const k = sc.kind;
    // strokes per layer: drizzle is fine and sparse, rain denser and longer, the
    // storm densest; the real rate scales each
    const n = Math.round((snow ? 60 + amt * 110 : k === "drizzle" ? 45 + amt * 90 : k === "storm" ? 150 + amt * 120 : 60 + amt * 140) * (near ? 0.55 : 0.45) * (W / w));
    const len = k === "drizzle" ? 4 + amt * 3 : k === "storm" ? 13 : 8 + amt * 7;
    c.strokeStyle = col; c.fillStyle = col; c.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const u = -sx + r() * (W + 2 * sx), v = r() * H, a = (near ? 0.5 : 0.3) + r() * 0.35;
      const L = len * (near ? 1 : 0.7) * (0.8 + r() * 0.4), s = snow ? (near ? 1.1 + r() * 0.8 : 0.6 + r() * 0.5) : 0;
      for (const kk of [-1, 0, 1]) {
        const uu = u + slant * H * kk, vv = v + H * kk + H;
        c.globalAlpha = a;
        if (snow) {
          c.beginPath(); c.arc(uu, vv - H, s, 0, TAU); c.fill();
          if (brightSky) { c.globalAlpha = a * 0.6; c.strokeStyle = dark; c.lineWidth = 0.5; c.stroke(); c.strokeStyle = col; }
        } else {
          c.lineWidth = near ? (k === "drizzle" ? 0.6 : 0.85) : 0.55;
          c.beginPath(); c.moveTo(uu, vv - H); c.lineTo(uu + slant * L, vv - H + L); c.stroke();
        }
      }
    }
    const speed = snow ? (near ? 18 : 11) : k === "drizzle" ? (near ? 70 : 45) : k === "storm" ? (near ? 260 : 170) : near ? 190 : 120;
    return { el: wrap || cv, cv, wrap, speed, slant, H, phase: near ? 0 : 0.37, sway: snow };
  }

  // ---------- motion: animations the compositor runs, no frames in JS ----------
  // They pause with the runtime (html.kiln-paused, which the host sets when the wallpaper
  // is covered, the screen is locked or Low Power Mode is on) and are never made under
  // prefers-reduced-motion or weather_motion: false, when every layer stands still.
  const anims = new Set();
  let motion = true;
  const moving = () => motion && !window.Kiln.reduced;
  function play(el, frames, opts) {
    const a = el.animate(frames, Object.assign({ iterations: Infinity, easing: "linear", fill: "both" }, opts));
    if (window.Kiln.paused) a.pause();
    anims.add(a);
    return a;
  }
  function stop(a) { a.cancel(); anims.delete(a); }
  new MutationObserver(() => {
    const p = document.documentElement.classList.contains("kiln-paused");
    for (const a of anims) (p ? a.pause() : a.play());
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  const px = (x, y) => `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
  // the cloud: from where it is now (o, 0..w), one plate width along the wind, then again;
  // a change of wind restarts it from the same place, so nothing jumps
  function drift(C) {
    let o = 0;
    if (C.anim) { o = C.from + (C.to - C.from) * (((C.anim.currentTime || 0) % C.dur) / C.dur); stop(C.anim); C.anim = null; }
    if (o < 0) o += C.W;
    if (!C.vx || !moving()) { C.el.style.transform = px(o, 0); return; }
    C.from = o; C.to = o + Math.sign(C.vx) * C.W; C.dur = (C.W / Math.abs(C.vx)) * 1000;
    C.anim = play(C.el, [{ transform: px(C.from, 0) }, { transform: px(C.to, 0) }], { duration: C.dur });
  }
  // rain and snow: one period along the fall vector; the far layer starts part-way so the
  // two depths never line up; snow's wrapper rocks 3 px either way over 4.5 s
  function fall(L, plate) {
    const dur = (L.H / L.speed) * 1000;
    const a = play(L.cv, [{ transform: px(0, 0) }, { transform: px(L.slant * L.H, L.H) }], { duration: dur });
    a.currentTime = L.phase * dur;
    plate.anims.push(a);
    if (L.wrap) plate.anims.push(play(L.wrap, [{ transform: px(-3, 0) }, { transform: px(3, 0) }], { duration: 4500, direction: "alternate", easing: "ease-in-out" }));
  }

  let current = null, curKey = null, curEd = null;
  const plates = new Set();
  function dropPlate(p) {
    for (const a of p.anims) stop(a);
    if (p.cloud && p.cloud.anim) stop(p.cloud.anim);
    p.el.remove(); plates.delete(p);
  }

  // update(container, weather, t, edition, {kind, sky, motion, fade_ms, slow, w, h})
  // every tick; repaints only when the key changes. Returns the scene it shows. The
  // caller passes the plate's size, measured once, so a tick never forces a layout.
  function update(box, wx, t, ed, o) {
    motion = o.motion !== false;
    const w = o.w || Math.round(box.clientWidth), h = o.h || Math.round(box.clientHeight);
    if (!w || !h) return null;
    const sc = wx ? scene(wx, t, o) : null;
    // The plate is printed by the light outside, not by the edition (README, Preferences, "No
    // veils on the sky": the sky is the same picture in either appearance). A day sky is the
    // Day print, black ink on paper; a night sky is the Night print, white lines cut from the
    // dark block. Under the other edition it sits on the page as a printed block of its own,
    // edge for edge. The edition still prints the empty plate.
    if (sc) ed = sc.day ? "day" : "night";
    // a storm's lightning strikes from its own layer when anything may move
    if (sc) sc.flashes = sc.kind === "storm" && moving();
    // the wind's drift is set on the cloud layer live; it is not part of the key
    if (sc && current && current.cloud && Math.abs(current.cloud.vx - sc.vx) > 0.02) { current.cloud.vx = sc.vx; drift(current.cloud); }
    const key = sc
      ? [sc.kind, ed, sc.day, sc.flashes, sc.sunF == null ? "-" : Math.round(sc.sunF * 100), Math.round(sc.precip * 10), Math.round(sc.snow * 10),
        Math.round(sc.slant * 20), Math.round(sc.phase * 30), sc.moonU == null ? "-" : Math.round(sc.moonU * 50), Math.round(sc.cover * 20),
        Math.round(sc.lit * 20), Math.round(sc.vane * 8), sc.bare, w, h].join("|")
      : ["none", ed, w, h].join("|");
    if (key === curKey) return sc;
    curKey = key;
    const fade = curEd && curEd !== ed && !window.Kiln.reduced;
    curEd = ed;
    const el = document.createElement("div");
    el.className = "plate";
    const plate = { el, anims: [], cloud: null };
    if (sc) {
      const g = geo(w, h, sc);
      const sky = paintSky(w, h, sc, ed, g);
      el.appendChild(sky.el);
      if (sc.kind === "clear" && !sc.day && sky.stars.length && moving()) {
        for (const T of twinkleLayers(w, sc, ed, g, sky.stars)) {
          el.appendChild(T.el);
          plate.anims.push(play(T.el, [{ opacity: 0.25 }, { opacity: 1 }], { duration: T.dur, direction: "alternate", easing: "ease-in-out", delay: -T.delay }));
        }
      }
      if (sc.cover > 0.02 && sc.kind !== "fog") {
        plate.cloud = cloudLayer(w, sc, ed, g);
        el.appendChild(plate.cloud.el); drift(plate.cloud);
      }
      const front = paintFront(w, h, sc, ed, g);
      if (sc.kind === "storm" && !sc.flashes) strokeFork(front.el.getContext("2d"), w, g.horizon, ed, 1);
      el.appendChild(front.el);
      if (sc.falls) for (const near of [false, true]) {
        const L = fallLayer(w, h, sc, ed, near);
        el.appendChild(L.el);
        if (moving()) fall(L, plate);
      }
      if (sc.flashes) { const F = flashLayer(w, h, ed, g); el.appendChild(F.el); plate.anims.push(play(F.el, STRIKES.frames, { duration: STRIKES.dur })); }
    } else {
      const base = document.createElement("canvas");
      paintEmpty(base, w, h, ed);
      el.appendChild(base);
    }
    const old = current;
    // a plate still fading out from an earlier change goes now
    for (const p of [...plates]) if (p !== old) { dropPlate(p); plates.delete(p); }
    plates.add(plate);
    current = plate;
    if (fade && o.slow) {
      // the new printing fades in over the old with the page's re-inking (o.slow runs
      // it on Kiln.loop, as a tween is clamped to part of a period). It always lands,
      // so the old plate is always dropped.
      el.style.opacity = 0;
      box.appendChild(el);
      o.slow(o.fade_ms || 8000, (v) => { el.style.opacity = v; if (v === 1 && old) dropPlate(old); });
    } else {
      box.appendChild(el);
      if (old) dropPlate(old);
    }
    return sc;
  }
  function paintEmpty(cv, w, h, ed) {
    const P = PAL[ed], dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + "px"; cv.style.height = h + "px";
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = P.paper; c.fillRect(0, 0, w, h);
    c.strokeStyle = P.ink; c.strokeRect(0.5, 0.5, w - 1, h - 1);
    c.fillStyle = P.ink; c.globalAlpha = 0.7; c.font = "italic 14px Newsreader, serif"; c.textAlign = "center";
    c.fillText("No weather report on this line", w / 2, h / 2 + 4);
  }

  window.LedgerVignette = { update, scene };
})();
