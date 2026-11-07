// sky.js: the windscreen. Three planes: the sky beyond the glass (gradient, stars or sun,
// stratus, the town on the ridge), the weather falling through it, and what lands on the
// glass. Every texture is drawn once into a canvas; motion is transform and opacity only,
// from one Kiln.loop (30 fps while something falls, 2-10 fps for drifting cloud, none when
// nothing moves). The sky is repainted when the weather or the sun has moved enough to see.
// No filters, no timers of its own.
//
// Dev overrides: ?weather=clear|partly|cloudy|fog|drizzle|rain|snow|storm and ?sun=<f>, the
// fraction of the way from sunrise (0) to sunset (1), to check the day sky.
(() => {
  "use strict";
  const W = 1512, H = 622, HORIZON = 612;
  const q = new URLSearchParams(location.search);
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const seeded = (s) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mixc = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const mixp = (A, B, k) => A.map((c, i) => mixc(c, B[i], k));
  const css = (c, a = 1) => `rgba(${c.map(Math.round).join(",")},${a})`;
  const P = (...h) => h.map(rgb);

  const sky = document.getElementById("sky"), glass = document.getElementById("glass");
  // A texture drawn below the device ratio (the cloud, streak and flake sheets) gets a CSS
  // box of its own pixel size over the device ratio, and its transform scales it back up
  // by k. A composited layer's backing store is its CSS box times the device ratio, so
  // the layer then costs what the texture costs. Measured in KilnWall 2026-11-05: the two
  // cloud sheets, 1.8 MB of texture each, held 30 MB of tiled 2x backing between them.
  function canvas(parent, w, h, scale, cls, tex) {
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const k = tex && scale < DPR ? DPR / scale : 1;
    c.style.width = w / k + "px"; c.style.height = h / k + "px";
    if (k !== 1) { c.style.transformOrigin = "0 0"; c.style.transform = `scale(${k})`; }
    if (cls) c.className = cls;
    parent.appendChild(c);
    const x = c.getContext("2d");
    x.scale(scale, scale);
    return { c, x, k };
  }
  // a layer's place, in stage points; its texture scale always comes last
  const at = (L, x, y, more = "") => `translate3d(${x}px,${y}px,0)${more}${L.k !== 1 ? ` scale(${L.k})` : ""}`;
  const free = (L) => { if (L) { L.c.width = L.c.height = 0; L.c.remove(); } };

  /* ---------------- what the feed says, and the dev override ---------------- */
  const DEV = {
    clear: { code: 0, text: "clear sky", cloud: 4, precip_mm: 0, rain_mm: 0, snow_cm: 0 },
    partly: { code: 2, text: "partly cloudy", cloud: 45, precip_mm: 0, rain_mm: 0, snow_cm: 0 },
    cloudy: { code: 3, text: "overcast", cloud: 97, precip_mm: 0, rain_mm: 0, snow_cm: 0 },
    fog: { code: 45, text: "fog", cloud: 100, humidity: 99, precip_mm: 0, rain_mm: 0, snow_cm: 0 },
    drizzle: { code: 51, text: "light drizzle", cloud: 100, humidity: 93, precip_mm: 0.2, rain_mm: 0.2, snow_cm: 0 },
    rain: { code: 63, text: "moderate rain", cloud: 100, humidity: 96, precip_mm: 3.1, rain_mm: 3.1, snow_cm: 0 },
    snow: { code: 73, text: "moderate snow", cloud: 100, humidity: 90, precip_mm: 1.1, rain_mm: 0, snow_cm: 1.4, temp_c: -2.5, feels_c: -7 },
    storm: { code: 95, text: "thunderstorm", cloud: 100, humidity: 97, precip_mm: 7.5, rain_mm: 7.5, snow_cm: 0 },
  };
  function weather(s) {
    let w = s && s.weather;
    const k = q.get("weather");
    if (k && DEV[k]) w = Object.assign({ place: "Demo City", temp_c: 12, feels_c: 11, humidity: 90, wind_kmh: 14, wind_dir: 240, is_day: false, observed_at: s && s.t }, w, DEV[k], { kind: k });
    if (w && q.has("day")) w = Object.assign({}, w, { is_day: q.get("day") !== "0" });
    return w || null;
  }

  // The sun from sunrise/sunset alone: altitude follows a sine over the day, with a noon
  // height estimated from day length; azimuth sweeps east to west. Good to a few degrees,
  // which is all a sky colour needs. The glass faces south, so east is on the left.
  function sunAt(w, t) {
    if (!w || !w.sunrise || !w.sunset) return { alt: w && w.is_day ? 30 : -30, x: W / 2, y: 120 };
    let rise = w.sunrise, set = w.sunset;
    while (t - rise > 86400) { rise += 86400; set += 86400; }   // the feed's times are for one day
    const len = (set - rise) / 3600;
    // dev: ?day=1 is solar noon, ?day=0 solar midnight (halfway from sunset to the next sunrise)
    const f = q.has("sun") ? +q.get("sun") : q.has("day") ? (q.get("day") === "0" ? 1 + (24 - len) / (2 * len) : 0.5) : (t - rise) / (set - rise);
    const noon = clamp(20 + (len - 9) * 7.5, 25, 75);
    const alt = f >= 0 && f <= 1 ? noon * Math.sin(Math.PI * f) : -Math.min(60, 12 * len * (f < 0 ? -f : f - 1));
    const az = 180 + (clamp(f, -0.2, 1.2) - 0.5) * 2 * (50 + len * 2.5);
    // 17 pt a degree: the windscreen sees about 36 degrees up, as a cockpit's does. At 9 a
    // degree a November noon sun (about 32 up) sat behind the PFD, and a clear day showed none.
    return { alt, x: W / 2 + (az - 180) * 7, y: HORIZON - Math.max(alt, -4) * 17 };
  }

  /* ---------------- far plane: sky, stars, sun and the town ---------------- */
  // gradient stops at y 0, 324, 530, 601 (the v2 sky), horizon at 612
  const SKY = {
    nightOvc: P("#0C1016", "#161D27", "#2A2729", "#4B372B"),   // overcast, lit sodium from the town
    nightClr: P("#03050A", "#0A1020", "#151B2A", "#2E2A31"),
    // The real day sky (README: nothing changes what the sky depicts). Before 2026-11-05 the
    // deck had a deeper day (#2B5C94 at the zenith, an overcast of #5D656E, a storm of
    // #2C3239) that, behind its shade, read as dusk at noon.
    day: P("#3F78B4", "#76A6D4", "#AFCBE6", "#DCE7EF"),
    dayOvc: P("#7D868F", "#959CA3", "#ADB2B6", "#C4C6C6"),
    stormDay: P("#6A727A", "#7B838A", "#91979C", "#A6AAAD"),
    twi: P("#1A2142", "#4F4A70", "#B8717A", "#F2A266"),
    storm: P("#07090C", "#0E1218", "#1B1C20", "#2E2620"),
    fog: P("#2B2E31", "#3E3F40", "#5B534C", "#6F5E51"),
    fogDay: P("#9DA3A8", "#B2B6B9", "#C3C5C6", "#CFCFCD"),
  };
  const CLOUD = {   // top, middle, bottom tint of the stratus, and the fine second layer
    night: P("#1D232C", "#3F3A3D", "#835B41", "#56494A"),
    nightClr: P("#151A22", "#262830", "#4A3C36", "#3A3638"),
    day: P("#EDF0F3", "#D6DBE0", "#BCC2C9", "#C9CED4"),
    dayOvc: P("#8E959D", "#9EA3A9", "#A8ABAD", "#7E858D"),
    twi: P("#5A5170", "#B07A80", "#EAA27A", "#8A6A72"),
    storm: P("#0E1115", "#1F1F23", "#4A3628", "#24242A"),
    stormDay: P("#737B83", "#838A91", "#939A9F", "#7A8289"),
    fog: P("#5C5753", "#6B635D", "#8A7462", "#6E6660"),
    fogDay: P("#C9CDD1", "#D2D5D7", "#DADBDB", "#C2C6CA"),
  };

  const base = canvas(sky, W, H, 1);
  const cl = [canvas(sky, 2 * W, HORIZON, 0.5, "drift", true), canvas(sky, 2 * W, HORIZON, 0.5, "drift", true)];
  cl[0].c.style.opacity = 0.9; cl[1].c.style.opacity = 0.5;
  let flash = null;   // the lightning canvas: allocated by the first storm, not before
  const ridge = canvas(sky, W, 32, DPR);
  ridge.c.style.top = HORIZON - 14 + "px";
  const fall = document.createElement("div");   // weather beyond the glass sits in front of the town
  sky.appendChild(fall);

  let look = null;   // the palette the sky was last painted with

  function palette(w, sun) {
    const kind = w ? w.kind : "cloudy", ovc = w ? clamp(w.cloud / 100, 0, 1) : 0.6;
    const dayK = smooth(-6, 6, sun.alt), twi = clamp(1 - Math.abs(sun.alt + 1) / 9, 0, 1) * (1 - ovc * 0.7);
    const pick = (S, n) => {
      let c = mixp(mixp(S[n + "Clr"] || S.nightClr, S.nightOvc || S.night, ovc), mixp(S.day, S.dayOvc, ovc), dayK);
      c = mixp(c, S.twi, twi);
      if (kind === "storm") c = mixp(c, dayK > 0.5 ? S.stormDay : S.storm, 0.85);
      if (kind === "fog") c = mixp(c, dayK > 0.5 ? S.fogDay : S.fog, 0.85);
      return c;
    };
    return { kind, ovc, dayK, twi, sun, sky: pick(SKY, "night"), cloud: pick({ ...CLOUD, nightOvc: CLOUD.night }, "night") };
  }

  /* ---------------- canopy glass: how much smoke the panes need, from the sky painted behind them ----------------
     The clock, the weather block, the annunciator strip and the two side columns sit on panes of
     canopy glass (#cg, index.html). Nothing shades the sky outside them (README, "No veils on the
     sky"). Their smoke is the least that keeps the faintest ink legible over the sky as painted:
     the gradient, stars, sun and town (the base canvas) and both cloud sheets at four drift
     positions, behind every pane. The glass is a dark tint over the sky in sRGB, as the browser
     composites it; the smoke is the least tint at which the 95th-percentile brightest sky pixel
     comes down to Y_MAX (the windscreen's faintest coloured small figure, amber at Y 0.71,
     holds Lc 75 on Y 0.041; Y_MAX leaves a margin for what the samples miss: falling weather,
     beads, the blur's spread). The six panes share one smoke, so they read as one glass; the strip never goes under
     STRIP_MIN, as it is the housing the lamps are set in. Under 0.04 the glass goes clear.
     Once per sky repaint, never per line. The boxes are read once, at load, before deck.js
     fits the sessions pane to its list: the most it can cover is what gets sampled. */
  const panes = [...document.querySelectorAll("#cg .pane")].map((el) => ({ el, k: el.dataset.p, x0: el.offsetLeft, y0: el.offsetTop, x1: el.offsetLeft + el.offsetWidth, y1: el.offsetTop + el.offsetHeight }));
  const Y_MAX = 0.036, STRIP_MIN = 0.42, TINT = [4, 8, 13];
  const lin = (c) => 0.2126729 * Math.pow(c[0] / 255, 2.4) + 0.7151522 * Math.pow(c[1] / 255, 2.4) + 0.072175 * Math.pow(c[2] / 255, 2.4);
  let smokeInfo = null;
  function smoke() {
    const bp = base.x.getImageData(0, 0, W, HORIZON).data, cw = cl[0].c.width;
    const cp = cl.map((c) => c.x.getImageData(0, 0, cw, c.c.height).data), cop = [0.9, 0.5];
    const px = [];
    for (const P of panes) {
      for (let y = P.y0 + 3; y < Math.min(P.y1, HORIZON); y += 6) for (let x = P.x0 + 3; x < P.x1; x += 6) {
        const o = (y * W + x) * 4;
        for (let k = 0; k < 4; k++) {   // four drift positions of the cloud sheets
          let c = [bp[o], bp[o + 1], bp[o + 2]];
          cp.forEach((p, i) => {
            const tx = Math.floor(((x + (k * W) / 4 + i * 377) % W) / 2), ty = Math.min(cl[i].c.height - 1, Math.floor(y / 2)), j = (ty * cw + tx) * 4, a = (p[j + 3] / 255) * cop[i];
            if (a > 0) c = mixc(c, [p[j], p[j + 1], p[j + 2]], a);
          });
          px.push(c);
        }
      }
    }
    // the 95th-percentile pixel by luminance, then the least tint that brings it to Y_MAX
    px.sort((a, b) => lin(a) - lin(b));
    const hi = px[Math.floor(px.length * 0.95)], seen = (a) => lin(mixc(hi, TINT, a));
    let lo = 0, up = 0.92;
    if (seen(0) <= Y_MAX) up = 0;
    else for (let i = 0; i < 14; i++) { const m = (lo + up) / 2; if (seen(m) > Y_MAX) lo = m; else up = m; }
    const a = up < 0.04 ? 0 : Math.ceil(up * 50) / 50;   // in steps of .02, so a slow sun rewrites it rarely
    for (const P of panes) {
      const v = P.k === "shield" ? Math.max(a, STRIP_MIN) : a;   // the glareshield is the lamps' housing
      P.el.style.setProperty("--a", v);
      P.el.style.setProperty("--e", Math.min(1, v / 0.25).toFixed(2));   // the edges come with the smoke
      P.el.classList.toggle("clear", v === 0);
    }
    smokeInfo = { smoke: a, skyY95: +lin(hi).toFixed(3) };
  }

  function paintBase(L) {
    const g = base.x, { sky: S, dayK, ovc, sun, kind } = L;
    const lg = g.createLinearGradient(0, 0, 0, H);
    [[0, 0], [324, 1], [530, 2], [601, 3]].forEach(([y, i]) => lg.addColorStop(y / H, css(S[i])));
    lg.addColorStop(HORIZON / H, css(mixc(S[3], [10, 11, 14], 0.3)));
    lg.addColorStop(1, "#0A0B0E");
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
    // stars where the cloud is thin and the sun is down
    const starK = (1 - dayK) * Math.pow(1 - ovc, 1.5) * (kind === "fog" ? 0 : 1);
    if (starK > 0.02) {
      const r = seeded(77);
      for (let i = 0; i < 520; i++) {
        const x = r() * W, y = Math.pow(r(), 1.4) * 540, s = 0.35 + Math.pow(r(), 3) * 1.1, a = (0.25 + r() * 0.75) * starK * (1 - y / 640);
        g.fillStyle = `rgba(${r() < 0.2 ? "255,226,196" : "226,236,255"},${a.toFixed(3)})`;
        g.beginPath(); g.arc(x, y, s, 0, 7); g.fill();
      }
    }
    // the sun's glare, behind the cloud
    if (sun.alt > -6 && !sun.hide && ovc < 0.95 && kind !== "fog") {
      const k = smooth(-6, 4, sun.alt) * (1 - ovc * 0.85), warm = 1 - smooth(2, 25, sun.alt);
      const col = mixc([255, 250, 236], [255, 176, 110], warm);
      const rg = g.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, 420);
      rg.addColorStop(0, css(col, 0.95 * k)); rg.addColorStop(0.04, css(col, 0.55 * k));
      rg.addColorStop(0.25, css(col, 0.16 * k)); rg.addColorStop(1, css(col, 0));
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
    }
    // the town lights the cloud base from below at night; fog holds it close to the ground
    const town = (1 - dayK) * (kind === "fog" ? 1.25 : 0.45 + 0.55 * ovc);
    if (town > 0.02) {
      g.save(); g.translate(800, HORIZON); g.scale(1, 300 / 900);
      const tg = g.createRadialGradient(0, 0, 0, 0, 0, 900);
      tg.addColorStop(0, css([208, 128, 72], 0.42 * town)); tg.addColorStop(1, css([208, 128, 72], 0));
      g.fillStyle = tg; g.fillRect(-900, -900, 1800, 900); g.restore();
    }
    // horizon haze; in fog it becomes a veil over everything
    const hz = g.createLinearGradient(0, kind === "fog" ? 0 : HORIZON - 150, 0, HORIZON + 4);
    const hc = dayK > 0.5 ? [216, 221, 226] : [140, 116, 102], ha = kind === "fog" ? 0.5 : 0.22;
    hz.addColorStop(0, css(hc, kind === "fog" ? 0.12 : 0)); hz.addColorStop(0.85, css(hc, ha)); hz.addColorStop(1, css(hc, 0));
    g.fillStyle = hz; g.fillRect(0, 0, W, HORIZON + 4);
  }

  function paintRidge(L) {
    const g = ridge.x, night = 1 - L.dayK, fog = L.kind === "fog";
    g.clearRect(0, 0, W, 32);
    let d = new Path2D(), x = 0;
    const r = seeded(11);
    d.moveTo(0, 18);
    while (x < W) { x += 6 + r() * 10; d.lineTo(x, 10 + Math.sin(x / 140) * 4 + Math.sin(x / 37) * 1.6 + r() * 4); }
    d.lineTo(W, 32); d.lineTo(0, 32); d.closePath();
    g.fillStyle = css(mixc([5, 6, 8], [44, 52, 50], L.dayK * (fog ? 0.3 : 1))); g.fill(d);
    if (night < 0.05) return;
    const rl = seeded(5);
    for (let i = 0; i < 180; i++) {
      const cluster = rl() < 0.62, lx = cluster ? 800 + (rl() - 0.5) * 560 : rl() * W;
      const ly = 15 + rl() * rl() * 8, lr = 0.45 + rl() * 0.7, warm = rl() < 0.82, a = (0.35 + rl() * 0.6) * night;
      const c = warm ? [255, 194, 127] : [217, 230, 242];
      if (fog) {   // halos: the fog scatters each light into a soft disc
        const hg = g.createRadialGradient(lx, ly, 0, lx, ly, 7 + lr * 6);
        hg.addColorStop(0, css(c, 0.32 * a)); hg.addColorStop(1, css(c, 0));
        g.fillStyle = hg; g.fillRect(lx - 14, ly - 14, 28, 28);
      } else {
        g.shadowColor = css(c, a); g.shadowBlur = 3;
      }
      g.fillStyle = css(c, a * (fog ? 0.5 : 1));
      g.beginPath(); g.arc(lx, ly, lr, 0, 7); g.fill();
    }
    g.shadowBlur = 0;
  }

  /* ---------------- stratus: tileable value-noise fbm, baked once, recoloured rarely ---------------- */
  const NW = 756, NH = 306;
  function field(fx, fy, oct, seed) {
    const r = seeded(seed), out = new Float32Array(NW * NH);
    let amp = 1;
    for (let o = 0; o < oct; o++) {
      const cx = Math.round(fx * 2 ** o), cy = Math.round(fy * 2 ** o), gr = new Float32Array(cx * (cy + 1));
      for (let i = 0; i < gr.length; i++) gr[i] = r();
      for (let y = 0; y < NH; y++) {
        const gy = (y / NH) * cy, y0 = gy | 0, ty = gy - y0, sy = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < NW; x++) {
          const gx = (x / NW) * cx, x0 = gx | 0, tx = gx - x0, sx = tx * tx * (3 - 2 * tx), x1 = (x0 + 1) % cx;
          const a = gr[y0 * cx + x0] + (gr[y0 * cx + x1] - gr[y0 * cx + x0]) * sx;
          const b = gr[(y0 + 1) * cx + x0] + (gr[(y0 + 1) * cx + x1] - gr[(y0 + 1) * cx + x0]) * sx;
          out[y * NW + x] += (a + (b - a) * sy) * amp;
        }
      }
      amp *= 0.5;
    }
    // normalise to the spread feTurbulence gives, so the v2 alpha curves still apply
    let m = 0, v = 0;
    for (const n of out) m += n;
    m /= out.length;
    for (const n of out) v += (n - m) * (n - m);
    const sd = Math.sqrt(v / out.length);
    for (let i = 0; i < out.length; i++) out[i] = 0.5 + ((out[i] - m) / sd) * 0.17;
    return out;
  }
  let F0 = null, F1 = null;
  function paintClouds(L) {
    F0 = F0 || field(3, 6, 5, 7);
    F1 = F1 || field(5, 10, 4, 21);
    const fog = L.kind === "fog", cover = (0.97 - Math.min(L.ovc, 0.97)) * 1.25;
    // v2's alpha curves: 2.1n - 0.78 and 2.6n - 1.3, opened up as the cover thins
    const layers = [[F0, fog ? 1.5 : 2.1, (fog ? 0.32 : 0.78) + cover, 0], [F1, fog ? 1.6 : 2.6, (fog ? 0.6 : 1.3) + cover, 1]];
    for (const [Fd, gain, bias, li] of layers) {
      const img = new ImageData(NW, NH), d = img.data, C = L.cloud;
      for (let y = 0; y < NH; y++) {
        const k = y / NH, col = li ? C[3] : k < 0.55 ? mixc(C[0], C[1], k / 0.55) : mixc(C[1], C[2], (k - 0.55) / 0.45);
        for (let x = 0; x < NW; x++) {
          const i = y * NW + x, a = clamp(gain * Fd[i] - bias, 0, 1), o = i * 4;
          d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = a * 255;
        }
      }
      cl[li].x.putImageData(img, 0, 0);
      cl[li].x.putImageData(img, NW, 0);
    }
  }

  /* ---------------- the weather between the town and the glass ---------------- */
  // A streak texture tiles along the fall vector: a streak at (x, y) repeats at (x + s*T, y + T),
  // so translating by one period is seamless.
  const T = 256;
  function streaks(o) {
    const mx = Math.ceil(Math.abs(o.slant) * T) + 4, L = canvas(fall, W + 2 * mx, H + T, 1, "drift", true);
    L.mx = mx; L.speed = o.speed; L.slant = o.slant; L.y = Math.random() * T;
    const r = seeded(o.seed), g = L.x;
    g.lineCap = "round";
    // copies shift sideways by slant*T per period, so seed x wide enough that every band is full
    const ext = Math.abs(o.slant) * (H + 2 * T), n = o.n * (1 + ext / (W + 2 * mx));
    for (let i = 0; i < n; i++) {
      const x = (o.slant > 0 ? -ext : 0) + r() * (W + 2 * mx + ext), y = r() * T;
      const len = o.len[0] + r() * (o.len[1] - o.len[0]), a = o.a[0] + r() * (o.a[1] - o.a[0]);
      for (let k = -1; y + k * T < H + T + len; k++) {
        const yy = y + k * T, xx = x + o.slant * k * T;
        if (o.dot) {
          const s = o.dot[0] + r() * (o.dot[1] - o.dot[0]);
          const rg = g.createRadialGradient(xx, yy, 0, xx, yy, s);
          rg.addColorStop(0, css(o.col, a)); rg.addColorStop(1, css(o.col, 0));
          g.fillStyle = rg; g.fillRect(xx - s, yy - s, 2 * s, 2 * s);
        } else {
          const lg = g.createLinearGradient(xx, yy, xx + o.slant * len, yy + len);
          lg.addColorStop(0, css(o.col, 0)); lg.addColorStop(1, css(o.col, a));
          g.strokeStyle = lg; g.lineWidth = o.w;
          g.beginPath(); g.moveTo(xx, yy); g.lineTo(xx + o.slant * len, yy + len); g.stroke();
        }
      }
    }
    return L;
  }
  // snow rushing toward the glass: three flake fields that grow from a vanishing point
  // and fade, staggered, like a landing light in snow
  function flakes(seed) {
    const L = canvas(fall, W, HORIZON, 1, "drift", true), r = seeded(seed), g = L.x;
    for (let i = 0; i < 150; i++) {
      const x = r() * W, y = r() * HORIZON, s = 1 + Math.pow(r(), 2) * 2.2;
      const rg = g.createRadialGradient(x, y, 0, x, y, s);
      rg.addColorStop(0, "rgba(246,248,252,.95)"); rg.addColorStop(0.55, "rgba(236,242,250,.55)"); rg.addColorStop(1, "rgba(236,242,250,0)");
      g.fillStyle = rg; g.fillRect(x - s, y - s, 2 * s, 2 * s);
    }
    return L;
  }

  /* ---------------- the glass: beads, runs and settling flakes ---------------- */
  // The bead canvas is 14.7 MB at DPR 2, so it exists only while the glass is wet: made by
  // the first bead, freed when the glass has dried (a clear night held it, empty, all night).
  let beadC = null;
  const runBox = document.createElement("div");
  runBox.id = "runs"; glass.appendChild(runBox);
  function bead() {
    if (!beadC) { beadC = canvas(glass, W, HORIZON - 4, DPR); glass.insertBefore(beadC.c, runBox); }
    return beadC;
  }
  const GLASS = {   // n beads, size curve, lifetime (s), runs and how often one starts (s)
    drizzle: { n: 1150, rmax: 4.2, pow: 2.2, life: [40, 140], runs: 3, every: 5 },
    rain: { n: 950, rmax: 6.2, pow: 1.8, life: [12, 50], runs: 8, every: 1.3 },
    storm: { n: 1050, rmax: 7.2, pow: 1.6, life: [6, 26], runs: 12, every: 0.6 },
    snow: { n: 380, flake: true, life: [10, 30], runs: 1, every: 18 },
    fog: { n: 1500, rmax: 1.3, pow: 1.4, life: [60, 220], runs: 0, every: 0, dim: 0.5 },
  };
  // a bead is a lens: clear body, dark refracting rim, light gathered into a caustic at its
  // foot, one specular point. At night it carries the town's warmth; by day, the sky's.
  function sprite(day) {
    const S = 48, c = document.createElement("canvas"), g = c.getContext("2d");
    c.width = c.height = S;
    const rg = g.createRadialGradient(S / 2, S * 0.8, 0, S / 2, S / 2, S / 2);
    const st = day
      ? [[0, "rgba(246,249,252,.78)"], [0.3, "rgba(182,194,206,.3)"], [0.72, "rgba(92,102,112,.14)"], [1, "rgba(42,49,56,.55)"]]
      : [[0, "rgba(255,215,174,.8)"], [0.3, "rgba(156,133,120,.32)"], [0.72, "rgba(42,44,51,.18)"], [1, "rgba(5,6,8,.75)"]];
    st.forEach(([o, c2]) => rg.addColorStop(o, c2));
    g.fillStyle = rg; g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 7); g.fill();
    return c;
  }
  // the specular point is drawn at its own strength, as v2 did, not dimmed with the body
  function specSprite() {
    const S = 16, c = document.createElement("canvas"), g = c.getContext("2d");
    c.width = c.height = S;
    g.fillStyle = "rgb(255,246,234)"; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 0.5, 0, 7); g.fill();
    return c;
  }
  function flakeSprite() {
    const S = 48, c = document.createElement("canvas"), g = c.getContext("2d");
    c.width = c.height = S;
    const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    rg.addColorStop(0, "rgba(250,252,255,.95)"); rg.addColorStop(0.5, "rgba(232,240,250,.7)"); rg.addColorStop(1, "rgba(232,240,250,0)");
    g.fillStyle = rg; g.fillRect(0, 0, S, S);
    return c;
  }
  const SPR = { night: sprite(false), day: sprite(true), spec: specSprite(), flake: flakeSprite() };
  let beads = [], dirty = [], beadDay = false, spawnAcc = 0, runAcc = 0, cfg = null, runs = [];
  const brnd = seeded(97);

  function drawBead(b) {
    const g = bead().x;
    if (b.flake) { g.globalAlpha = 0.85; g.drawImage(SPR.flake, b.x - b.r, b.y - b.r, 2 * b.r, 2 * b.r); return; }
    const dim = (cfg && cfg.dim) || 1;
    g.globalAlpha = (0.5 + (b.y / HORIZON) * 0.45) * dim;
    g.drawImage(SPR[beadDay ? "day" : "night"], b.x - b.r, b.y - b.r, 2 * b.r, 2 * b.r);
    if (b.r > 1.4) { g.globalAlpha = 0.85 * dim; g.drawImage(SPR.spec, b.x - b.r * 0.54, b.y - b.r * 0.66, b.r * 0.48, b.r * 0.48); }
  }
  function newBead(now, aged) {   // aged: the fraction of its life already spent
    const c = cfg, life = c.life[0] + brnd() * (c.life[1] - c.life[0]);
    const b = c.flake
      ? { x: brnd() * W, y: brnd() * (HORIZON - 8), r: 1.2 + Math.pow(brnd(), 2) * 2.6, flake: true }
      : { x: brnd() * W, y: brnd() * (HORIZON - 8), r: 0.8 + Math.pow(brnd(), c.pow) * (c.rmax - 0.8) };
    b.die = now + life * (1 - (aged || 0));
    return b;
  }
  function redrawAll() {
    if (!beadC && !beads.length) return;
    bead().x.clearRect(0, 0, W, HORIZON);
    for (const b of beads) drawBead(b);
    beadC.x.globalAlpha = 1;
  }
  function redrawDirty() {
    if (!dirty.length) return;
    if (!beadC) { dirty = []; return; }
    const g = beadC.x;
    for (const [x0, y0, x1, y1] of dirty) {
      g.save(); g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
      g.clearRect(x0, y0, x1 - x0, y1 - y0);
      for (const b of beads) if (b.x + b.r > x0 && b.x - b.r < x1 && b.y + b.r > y0 && b.y - b.r < y1) drawBead(b);
      g.restore();
    }
    g.globalAlpha = 1;
    dirty = [];
  }
  const gone = (b) => dirty.push([b.x - b.r - 1, b.y - b.r - 1, b.x + b.r + 1, b.y + b.r + 1]);

  function startRun(now) {
    const len = 60 + brnd() * 150, day = beadDay, c = document.createElement("canvas"), w = 12;
    c.width = w * DPR; c.height = (len + 10) * DPR; c.style.width = w + "px"; c.style.height = len + 10 + "px";
    c.className = "drift";
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    let x = w / 2, d = new Path2D();
    d.moveTo(x, 0);
    for (let s = 8; s < len; s += 8) { x = clamp(x + (brnd() - 0.4) * 1.6, 2, w - 2); d.lineTo(x, s); }
    const lg = g.createLinearGradient(0, 0, 0, len);
    lg.addColorStop(0, day ? "rgba(214,224,234,0)" : "rgba(201,182,166,0)"); lg.addColorStop(1, day ? "rgba(226,234,242,.75)" : "rgba(233,211,191,.8)");
    g.strokeStyle = lg; g.lineWidth = 1.5; g.lineCap = "round"; g.globalAlpha = 0.55; g.stroke(d);
    g.globalAlpha = 1;
    g.drawImage(SPR[day ? "day" : "night"], x - 2.6, len - 0.6, 5.2, 5.2);
    g.globalAlpha = 0.85;
    g.drawImage(SPR.spec, x - 1.4, len + 0.6, 1.3, 1.3);
    const r = { c, x: 30 + brnd() * (W - 60), y: brnd() * 260 - len, len, v: 0, vmax: 70 + brnd() * 150, hold: brnd() * 1.5, ox: x - w / 2 };
    runBox.appendChild(c);
    runs.push(r);
    return r;
  }
  function moveRuns(dt) {
    for (const r of runs) {
      if (r.hold > 0) { r.hold -= dt; continue; }
      const y0 = r.y + r.len;
      r.v = Math.min(r.vmax, r.v + 140 * dt);
      r.y += r.v * dt;
      if (brnd() < dt * 0.5) { r.hold = 0.15 + brnd() * 0.8; r.v = 0; }   // drops stutter on glass
      const hx = r.x + r.ox, y1 = r.y + r.len + 3;
      // the head sweeps up the beads in its path and leaves a clear track
      beads = beads.filter((b) => (Math.abs(b.x - hx) < b.r + 1.5 && b.y > y0 && b.y < y1 ? (gone(b), false) : true));
      r.c.style.transform = `translate3d(${(r.x - 6).toFixed(1)}px,${r.y.toFixed(1)}px,0)`;
    }
    runs = runs.filter((r) => (r.y < HORIZON ? true : (r.c.remove(), false)));
  }

  /* ---------------- configure for the weather, and the one loop ---------------- */
  let mode = null, layers = [], snow = [], drift = [0, 0], cv = [0, 0], stopLoop = null, beadClock = 0;
  function setMode(w, L) {
    const kind = w ? w.kind : "cloudy", I = w ? clamp((w.precip_mm || w.rain_mm || 0) / 4, 0.1, 1) : 0;
    const toward = (((w ? w.wind_dir : 240) + 180) * Math.PI) / 180, kmh = w ? w.wind_kmh || 0 : 0;
    const vx = -Math.sin(toward);   // facing south: an east-going wind moves things left
    const slant = clamp(vx * (kmh / 45), -0.45, 0.45);
    cv = [vx * kmh * 0.012, vx * kmh * 0.02];
    const sig = `${kind}|${slant.toFixed(2)}|${(I * 4).toFixed(0)}|${L.dayK > 0.5}`;
    if (sig === mode) return;
    mode = sig;
    layers.forEach(free); snow.forEach(free); layers = []; snow = [];
    const col = L.dayK > 0.5 ? [232, 238, 244] : [154, 166, 180];
    if (kind === "drizzle") layers.push(streaks({ n: 900, len: [5, 14], a: [0.1, 0.2], w: 0.7, col, slant, speed: 170, seed: 41 }));
    if (kind === "rain" || kind === "storm") {
      layers.push(streaks({ n: 700 * (0.6 + I * 0.4), len: [10, 24], a: [0.1, 0.22], w: 0.8, col, slant, speed: 650, seed: 43 }));
      layers.push(streaks({ n: 150 * (0.5 + I * 0.5), len: [30, 58], a: [0.08, 0.18], w: 1.2, col, slant: slant * 1.3, speed: 1050, seed: 47 }));
    }
    if (kind === "snow") {
      layers.push(streaks({ n: 420, len: [0, 0], a: [0.35, 0.8], dot: [0.6, 1.5], col: [240, 244, 250], slant: slant * 2, speed: 38, seed: 53 }));
      snow = [61, 67, 71].map(flakes);
    }
    const gc = GLASS[kind];
    if (gc !== cfg || beadDay !== L.dayK > 0.5) {
      cfg = gc ? Object.assign({}, gc, { n: Math.round(gc.n * (gc.flake ? 1 : 0.8 + 0.2 * I)) }) : null;
      beadDay = L.dayK > 0.5;
      // the glass is already wet when the page appears, runs and all; stagger lifetimes so
      // beads do not all go at once
      const now = performance.now() / 1000;
      if (cfg && !beads.length) {
        for (let i = 0; i < cfg.n; i++) beads.push(newBead(now, brnd() * 0.95));
        for (let i = 0; i < Math.ceil(cfg.runs / 2); i++) startRun(now).y += brnd() * 200;
      }
      redrawAll();
    }
    lastL = L;
    retune();
    if (Kiln.reduced) staticFrame();
  }
  // the loop runs only when something moves: 30 fps for falling weather or a wet glass, and
  // for cloud alone just often enough that each step stays under a quarter of a device pixel
  // (0.12 pt): 2 fps at a 14 km/h wind, 7 at 45. Cloud drifts a fraction of a point a second,
  // so a faster rate repaints the screen for steps no one can see. None for a still clear sky.
  let lastL = null, loopFps = -1, cloudEvery = 0.5, cloudAcc = 0;
  // A dry glass holds nothing, but over the composited sky it still took a 15 MB backing
  // of its own (measured in KilnWall, 2026-11-05): it leaves the render tree until it is wet.
  function glassOn() {
    const on = !!(cfg || beads.length || runs.length);
    if (glass.__on !== on) { glass.__on = on; glass.style.display = on ? "" : "none"; }
  }
  function retune() {
    glassOn();
    const wet = layers.length || snow.length || cfg || beads.length || runs.length || (mode && mode.startsWith("storm"));
    const cfps = clamp(Math.ceil(Math.abs(cv[1]) / 0.12), 2, 10);
    cloudEvery = 1 / cfps;
    const fps = wet ? 30 : Math.abs(cv[1]) > 0.01 && lastL && lastL.ovc > 0.05 ? cfps : 0;
    if (fps === loopFps) return;
    loopFps = fps;
    if (stopLoop) stopLoop();
    stopLoop = fps ? Kiln.loop(tick, { fps }) : null;
  }
  // A flake field grows about a vanishing point (ox, 280): with the texture's own box the
  // origin stays at the box's corner, so the zoom about that point is written out
  const zoom = (L, ox, dy, s) => at(L, ox.toFixed(1), (280 + dy).toFixed(1), ` scale(${s.toFixed(3)}) translate(${(-ox).toFixed(1)}px,-280px)`);
  function staticFrame() {   // reduced motion: hold one composed frame
    snow.forEach((L, i) => { L.c.style.opacity = 0.5; L.c.style.transform = zoom(L, 756, 0, 1 + i * 0.4); });
  }

  function tick(t, dt) {
    // cloud keeps its own clock (a 2 fps step is 0.5 s; only a resume gap is cut short)
    cloudAcc += Math.min(dt || 0, 1);
    if (cloudAcc >= cloudEvery * 0.9) {
      for (let i = 0; i < 2; i++) {
        drift[i] = (drift[i] - cv[i] * cloudAcc + W) % W;
        cl[i].c.style.transform = at(cl[i], (-drift[i]).toFixed(2), 0);
      }
      cloudAcc = 0;
    }
    dt = Math.min(dt || 0, 0.1);
    for (const L of layers) {
      L.y = (L.y + L.speed * dt) % T;
      L.c.style.transform = at(L, (-L.mx + L.slant * (L.y - T)).toFixed(1), (L.y - T).toFixed(1));
    }
    snow.forEach((L, i) => {
      const p = (t / 3.2 + i / 3) % 1, s = 0.45 * Math.pow(4.4, p), a = Math.pow(Math.sin(Math.PI * p), 1.3) * 0.9;
      L.c.style.transform = zoom(L, 756 + cv[1] * 60, p * 36, s);
      L.c.style.opacity = a.toFixed(3);
    });
    if (mode && mode.startsWith("storm") && Math.random() < dt / 9) lightning();
    if (runs.length) moveRuns(dt);
    beadClock += dt;
    if (beadClock < 0.1) return;   // the glass itself changes at 10 fps
    const step = beadClock;
    beadClock = 0;
    if (cfg) {
      spawnAcc += (cfg.n / ((cfg.life[0] + cfg.life[1]) / 2)) * step;
      while (spawnAcc >= 1 && beads.length < cfg.n * 1.1) { spawnAcc--; const b = newBead(t); beads.push(b); drawBead(b); }
      spawnAcc = Math.min(spawnAcc, 1);
      if (cfg.runs && runs.length < cfg.runs) { runAcc += step; if (runAcc > cfg.every) { runAcc = 0; startRun(t); } }
      if (beadC) beadC.x.globalAlpha = 1;
    }
    // evaporation: a dry glass loses every bead within its lifetime
    const keep = [];
    for (const b of beads) (b.die && b.die < t) || (!cfg && brnd() < step / 40) ? gone(b) : keep.push(b);
    beads = keep;
    redrawDirty();
    if (!cfg && !beads.length && !runs.length) {   // the glass has dried
      if (beadC) { free(beadC); beadC = null; }
      glassOn();
      if (loopFps === 30) retune();
    }
  }
  function lightning() {
    if (!flash) { flash = canvas(sky, W, HORIZON, 0.5, "", true); flash.c.style.opacity = 0; sky.insertBefore(flash.c, ridge.c); }
    const g = flash.x, r = Math.random;
    g.clearRect(0, 0, W, HORIZON);
    for (let i = 0; i < 3; i++) {
      const x = r() * W, y = 60 + r() * 380, R = 220 + r() * 300, rg = g.createRadialGradient(x, y, 0, x, y, R);
      rg.addColorStop(0, "rgba(206,216,236,.55)"); rg.addColorStop(1, "rgba(206,216,236,0)");
      g.fillStyle = rg; g.fillRect(0, 0, W, HORIZON);
    }
    flash.c.animate([{ opacity: 0 }, { opacity: 0.9, offset: 0.06 }, { opacity: 0.15, offset: 0.2 }, { opacity: 0.65, offset: 0.3 }, { opacity: 0 }], { duration: 900, easing: "ease-out" });
  }

  /* ---------------- on every line: repaint only what the weather or the sun changed ---------------- */
  function apply(s) {
    const w = weather(s), sun = sunAt(w, s ? s.t : 0), L = palette(w, sun);
    const sig = [L.kind, L.ovc.toFixed(2), L.dayK.toFixed(2), L.twi.toFixed(2), Math.round(sun.x / 8), Math.round(sun.y / 8)].join("|");
    if (sig !== look) {
      const cloudSig = sig.split("|").slice(0, 4).join("|");
      if (!look || cloudSig !== look.split("|").slice(0, 4).join("|")) paintClouds(L);
      look = sig;
      paintBase(L); paintRidge(L);
      smoke();
    }
    setMode(w, L);
  }
  // glass: what smoke() last decided (dev)
  window.FDSky = { weather, get glass() { return smokeInfo; } };
  apply(null);
  // the sun moves a pixel of sky in about a minute: look again every 10 s, or when the weather block changes
  let seenW, seenT = -1;
  Kiln.on((s) => {
    const k = Math.floor(s.t / 10);
    if (s.weather === seenW && k === seenT) return;
    seenW = s.weather; seenT = k;
    apply(s);
  });
})();
