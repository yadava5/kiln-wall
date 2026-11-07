// Mission Map's weather window, painted (v5). The survey window looking south from campus,
// rendered as bitmaps once per sky key (about once a minute at most) and drifted on the
// compositor. v4.1 cut the cloud into four terraces and the sky into eight flat bands; review
// (2026-11-06): "it looks like 8-bit rendered". Everything here is continuous:
//   - the sky: per pixel, zenith to horizon by the real sun's altitude, warmer on the sun's
//     side at twilight, the sun's and moon's aureoles, the town's glow to the south at night;
//     dithered half a level so dark gradients never band;
//   - cloud: a layer seen in perspective (3-D gradient noise sampled on a cylinder, so the
//     tile repeats seamlessly across the window and the drift loops; features shrink and
//     flatten toward the horizon as a real deck does), its cover the real `cloud` share (a
//     quantile of the field), lit by a short march toward the light: the sun by day and in
//     twilight, the moon when it is up, otherwise the town from below;
//   - the land: the real 3DEP skyline, hazed with distance, its rim lit like the ground;
//   - rain, snow, fog and lightning as soft bitmaps by their real rates.
// paint() is pure: window geometry and the real positions in, canvases out.
(function () {
  "use strict";
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mixc = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a == null ? 1 : a})`;
  const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // Improved gradient noise (Perlin 2002), fixed permutation: the same sky for the same key.
  const P = new Uint8Array(512);
  (function () { const p = Array.from({ length: 256 }, (_, i) => i), r = rng(1013); for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) P[i] = p[i & 255]; })();
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (t, a, b) => a + t * (b - a);
  const grad = (h, x, y, z) => { h &= 15; const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
  function noise(x, y, z) {
    let X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z; X &= 255; Y &= 255; Z &= 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
    return lerp(w, lerp(v, lerp(u, grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z)), lerp(u, grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z))),
      lerp(v, lerp(u, grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1)), lerp(u, grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1))));
  }

  // ---------- palettes: real skies, by the sun's altitude and the deck ----------
  // twi: 0 at the end of nautical twilight (-12 deg), 1 at +4 deg; day: 0 at +4, 1 at +30.
  function palette(p) {
    const { sunAlt, kind, heavy, cov } = p;
    const day = sunAlt > 4, night = sunAlt <= -12, twi = clamp01((sunAlt + 12) / 16), hi = clamp01((sunAlt - 4) / 26);
    const deck = kind === "storm" ? 1 : kind === "rain" ? 0.8 : heavy ? 0.55 : cov >= 0.85 ? 0.45 : 0;
    const S = {};
    // the clear sky, then the deck's grey laid over it in proportion to how closed it is
    let zen, warm, cool;
    if (day) {
      zen = mixc(hex("#4f7fb6"), hex("#3a74bb"), hi); warm = mixc(hex("#e6cfae"), hex("#c6d9ea"), hi); cool = mixc(hex("#a9bfd6"), hex("#b9cfe4"), hi);
    } else if (!night) {
      const f = twi;
      zen = mixc(hex("#0b0d12"), hex("#45668f"), Math.pow(f, 1.3));
      warm = f > 0.5 ? mixc(hex("#e3864c"), hex("#efc184"), (f - 0.5) * 2) : mixc(hex("#2c2420"), hex("#e3864c"), f * 2);
      cool = mixc(hex("#121317"), hex("#8e93a0"), f);
    } else { zen = hex("#08090b"); warm = cool = hex("#08090b"); }
    const greyZ = day ? mixc(hex("#a3a9af"), hex("#5e656c"), deck) : mixc(hex("#0c0d0f"), hex("#5b5f64"), night ? 0 : twi);
    const greyH = day ? mixc(hex("#c3c7cb"), hex("#8b9197"), deck) : mixc(hex("#141414"), hex("#9a948d"), night ? 0 : twi);
    const g = heavy ? 0.92 : cov * 0.55;
    S.zen = mixc(zen, greyZ, g); S.warm = mixc(warm, greyH, g); S.cool = mixc(cool, greyH, g);
    S.clear = 1 - g;
    // the sun's aureole and its disc colour
    S.sunCol = sunAlt > 8 ? hex("#fff6dc") : mixc(hex("#ff9c52"), hex("#fff0c8"), clamp01((sunAlt + 1) / 9));
    // night: the town's glow to the south (warm, sodium and LED mixed), weaker under a clear sky
    S.city = night || twi < 0.35 ? (heavy || cov > 0.7 ? hex("#3a3129") : hex("#2b2621")) : null;
    S.cityF = night ? 1 : clamp01((0.35 - twi) / 0.35);
    return S;
  }

  function cloudPalette(p, S) {
    const { sunAlt, kind, heavy, cov, moonLight } = p;
    const day = sunAlt > 4, night = sunAlt <= -12, twi = clamp01((sunAlt + 12) / 16);
    const C = {};
    const D = kind === "storm" ? { lit: "#8f959b", shade: "#33383e", dark: 0.42 } : kind === "rain" ? { lit: "#aab0b6", shade: "#575e66", dark: 0.32 }
      : kind === "snow" ? { lit: "#e4e7ea", shade: "#9ca3ab", dark: 0.18 } : heavy || cov >= 0.85 ? { lit: "#dcdfe2", shade: "#858c94", dark: 0.26 }
      : { lit: "#fdfcf8", shade: "#97a3b1", dark: 0.14 };
    // moonlight is dim and cool, and scales with the phase; without it a night deck is lit
    // from below by the town
    const ml = p.moonLit == null ? 0.7 : p.moonLit;
    // (the town's light on cloud is a dull warm grey, not brown: sodium and LED mixed)
    // (v5: lifted from #57514a, which left a night deck one brown-black murk at card size)
    const N = moonLight ? { lit: "#" + mixc(hex("#2a2c30"), hex("#666b73"), ml).map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""), shade: "#0e0f11", dark: 0.2 } : { lit: heavy ? "#6b655d" : "#5a554f", shade: "#100f0f", dark: 0.25 };
    const mix = (a, b, f) => ({ lit: mixc(hex(a.lit), hex(b.lit), f), shade: mixc(hex(a.shade), hex(b.shade), f), dark: a.dark + (b.dark - a.dark) * f });
    const M = day ? mix(D, D, 0) : night ? mix(N, N, 0) : mix(N, D, Math.pow(twi, 0.8));
    // low sun: cloud lit gold, then rose; muted under a deck
    if (sunAlt < 12 && sunAlt > -10) {
      const tint = sunAlt > 2 ? hex("#ffd2a0") : sunAlt > -4 ? hex("#f39a64") : hex("#b8685a");
      M.lit = mixc(M.lit, tint, (heavy ? 0.3 : 0.75) * (1 - clamp01((sunAlt - 4) / 8)) * clamp01((sunAlt + 10) / 5));
    }
    // twilight shade: the side away from the sun goes slate, so lit and shaded faces separate
    if (!day && !night && !heavy) M.shade = mixc(M.shade, hex("#4b4f5a"), 0.5 * (1 - Math.abs(twi - 0.6)));
    C.lit = M.lit; C.shade = M.shade; C.dark = M.dark;
    // by day a thin spot in a deck is brighter (more light comes through); by night darker
    C.thinBright = sunAlt > -4;
    // distance hazes cloud toward the horizon's colour; at night that is the town's glow
    C.haze = mixc(S.warm, S.cool, 0.5);
    if (S.city) C.haze = mixc(C.haze, mixc(S.city, [104, 96, 87], heavy ? 0.5 : 0.1), S.cityF);
    return C;
  }

  // ---------- paint ----------
  // p: { W, H, HY, k, landY(x), sun{x,y,alt}, moon{x,y,alt,lit,waxing}, kind, cov, heavy,
  //      raining, snowy, rate, windX, rim (ink), moonLight, light[x,y] (unit, toward it) }
  // out: { sky, front, fx } canvases to draw into; returns { cloud, precip } canvases or null.
  function paint(p, out) {
    p = Object.assign({}, p, { sunAlt: p.sun.alt, moonLit: p.moon.lit });
    const { W, H, HY, k } = p, PW = Math.round(W * k), PH = Math.round(H * k);
    const S = palette(p), CP = cloudPalette(p, S);
    const r = rng(97);
    const elev = (y) => (HY - y) / 1.45;             // deg: the window is 1.45 pt a degree both ways
    const ptPerDeg = W / 180;

    // --- the sky
    const sky = out.sky; sky.width = PW; sky.height = PH;
    const sg = sky.getContext("2d"), img = sg.createImageData(PW, PH), d = img.data;
    const sx = p.sun.x, sy = p.sun.y, mx = p.moon.x, my = p.moon.y;
    const sunGlow = p.sun.alt > -18 ? S.clear * clamp01((p.sun.alt + 18) / 14) : 0;
    const moonGlow = p.moon.alt > -2 && p.sun.alt < 2 ? S.clear * p.moon.lit * 0.5 : 0;
    for (let py = 0; py < PH; py++) {
      const y = (py + 0.5) / k, e = Math.max(0, elev(y)), g = Math.pow(1 - clamp01(e / 52), 2.6);
      for (let px = 0; px < PW; px++) {
        const x = (px + 0.5) / k, i = 4 * (py * PW + px);
        const psi = Math.min(180, Math.abs(x - sx) / ptPerDeg), side = sstep(25, 150, psi);
        let c = mixc(S.zen, mixc(S.warm, S.cool, side), g);
        if (sunGlow) {
          const dd = Math.hypot(x - sx, y - sy) / 1.45;
          const a = sunGlow * (0.55 * Math.exp(-dd / 2.2) + 0.32 * Math.exp(-dd / 12) + 0.12 * Math.exp(-dd / 40) * (1 - g));
          c = mixc(c, S.sunCol, clamp01(a));
        }
        if (moonGlow) { const dd = Math.hypot(x - mx, y - my) / 1.45, a = moonGlow * (0.18 * Math.exp(-dd / 6) + 0.06 * Math.exp(-dd / 25)); c = mixc(c, [150, 156, 166], clamp01(a)); }
        if (S.city) c = mixc(c, S.city, S.cityF * Math.exp(-e / 7) * (0.75 + 0.25 * Math.exp(-Math.pow((x - W * 0.55) / (W * 0.45), 2))));
        d[i] = c[0] + r() - 0.5; d[i + 1] = c[1] + r() - 0.5; d[i + 2] = c[2] + r() - 0.5; d[i + 3] = 255;
      }
    }
    sg.putImageData(img, 0, 0);
    sg.save(); sg.scale(k, k);
    // stars after nautical twilight: magnitudes from a steep distribution, dimmed by
    // extinction near the horizon and by the town's glow; the deck hides them anyway
    if (p.sun.alt < -10 && p.cov < 0.95) {
      const rs = rng(7), dark = clamp01((-10 - p.sun.alt) / 4) * (1 - p.cov * 0.6);
      for (let i = 0; i < 70; i++) {
        const x = rs() * W, y = rs() * (HY - 6), m = Math.pow(rs(), 3), ext = sstep(2, 14, elev(y));
        const a = dark * ext * (0.25 + 0.75 * m), rr = 0.35 + 0.65 * m;
        if (a < 0.05) continue;
        const gr = sg.createRadialGradient(x, y, 0, x, y, rr * 2.2);
        gr.addColorStop(0, `rgba(240,236,226,${a.toFixed(3)})`); gr.addColorStop(0.35, `rgba(240,236,226,${(a * 0.55).toFixed(3)})`); gr.addColorStop(1, "rgba(240,236,226,0)");
        sg.fillStyle = gr; sg.fillRect(x - rr * 2.2, y - rr * 2.2, rr * 4.4, rr * 4.4);
      }
    }
    // the sun: a soft-edged disc, gold near the horizon
    if (p.sun.alt > -1 && p.cov < 0.9 && p.sun.x > -10 && p.sun.x < W + 10) {
      const R = 4.6, gr = sg.createRadialGradient(sx, sy, 0, sx, sy, R + 1.2);
      gr.addColorStop(0, rgba(mixc(S.sunCol, [255, 255, 255], 0.6))); gr.addColorStop(R / (R + 1.2) - 0.08, rgba(S.sunCol)); gr.addColorStop(1, rgba(S.sunCol, 0));
      sg.fillStyle = gr; sg.beginPath(); sg.arc(sx, sy, R + 1.2, 0, 7); sg.fill();
    }
    // the moon at its phase: lit limb on the sun's side, the terminator an ellipse, earthshine
    if (p.moon.alt > -1 && p.sun.alt < 2 && p.cov < 0.9 && mx > -10 && mx < W + 10) {
      const R = 5, f = p.moon.lit, rx = Math.abs(2 * f - 1) * R;
      sg.save(); sg.translate(mx, my); if (!p.moon.waxing) sg.scale(-1, 1);
      sg.fillStyle = "rgba(60,63,70,0.55)"; sg.beginPath(); sg.arc(0, 0, R, 0, 7); sg.fill();
      sg.fillStyle = "#ece8de"; sg.beginPath(); sg.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);
      if (f >= 0.5) sg.ellipse(0, 0, Math.max(0.01, rx), R, 0, Math.PI / 2, Math.PI * 1.5, false);
      else sg.ellipse(0, 0, Math.max(0.01, rx), R, 0, Math.PI / 2, -Math.PI / 2, true);
      sg.fill(); sg.restore();
    }
    sg.restore();

    // --- cloud: a periodic tile (one window wide) for the drifting layer
    let cloud = null;
    if (p.cov > 0.02) cloud = cloudTile(p, S, CP, PW, PH, rng(131));

    // --- the land, fog and lightning in front
    const fr = out.front; fr.width = PW; fr.height = PH;
    const fg = fr.getContext("2d"); fg.scale(k, k);
    const day = p.sun.alt > 4, night = p.sun.alt <= -12;
    const hz = mixc(S.warm, S.cool, 0.5);
    // the moon behind a night deck: no disc, a broad pale patch where its light diffuses
    // through, weaker the thicker the deck, scaled by the phase. On this fixed layer, not the
    // drifting cloud, since the moon stays put while the deck moves under it.
    if (p.cov >= 0.85 && p.moon.alt > -1 && p.sun.alt < -6 && mx > -40 && mx < W + 40) {
      const through = { cloudy: 1, drizzle: 0.7, fog: 0.6, snow: 0.6, rain: 0.4, storm: 0.15 }[p.kind] ?? 0.8;
      const a = through * (0.1 + 0.4 * p.moon.lit) * sstep(-1, 4, p.moon.alt), R = 46;
      const gr = fg.createRadialGradient(mx, my, 0, mx, my, R);
      gr.addColorStop(0, `rgba(170,174,182,${a.toFixed(3)})`); gr.addColorStop(0.25, `rgba(160,164,172,${(a * 0.45).toFixed(3)})`);
      gr.addColorStop(0.6, `rgba(150,154,162,${(a * 0.12).toFixed(3)})`); gr.addColorStop(1, "rgba(150,154,162,0)");
      fg.fillStyle = gr; fg.fillRect(mx - R, my - R, 2 * R, 2 * R);
    }
    let ridge, foot;
    if (p.snowy) { ridge = day ? hex("#b9bfc5") : hex("#3c4146"); foot = day ? hex("#e7eaec") : hex("#545a60"); }
    else if (day) { ridge = mixc(hex("#3a3c35"), hz, 0.32); foot = hex("#1f1e1a"); }
    else if (night) { ridge = mixc(hex("#141310"), S.city || hex("#141310"), 0.35); foot = hex("#0c0b0a"); }
    else { ridge = mixc(mixc(hex("#141310"), hex("#3a3c35"), clamp01((p.sun.alt + 12) / 16)), hz, 0.2); foot = hex("#141210"); }
    const land = new Path2D(); land.moveTo(0, H); for (let x = 0; x <= W; x += 1) land.lineTo(x, p.landY(x)); land.lineTo(W, H); land.closePath();
    const lgr = fg.createLinearGradient(0, HY - 14, 0, H);
    lgr.addColorStop(0, rgba(ridge)); lgr.addColorStop(0.45, rgba(mixc(ridge, foot, 0.55))); lgr.addColorStop(1, rgba(foot));
    fg.fillStyle = lgr; fg.fill(land);
    // the ground's language, quietly: two contours under the skyline, receding
    fg.lineWidth = 0.5;
    for (const [j, dy, a] of [[1, 3, 0.22], [3, 8.5, 0.16]]) {
      fg.strokeStyle = rgba(p.snowy && day ? [150, 156, 162] : mixc(ridge, [140, 128, 112], 0.35), a); fg.beginPath();
      for (let x = 0; x <= W; x += 2) { const yy = HY + (p.landY(x) - HY) * (1 - 0.15 * j) + dy; x ? fg.lineTo(x, yy) : fg.moveTo(x, yy); }
      fg.stroke();
    }
    // the rim in the ground's ink; on snow it sinks toward the snow, a crest not a wire
    fg.strokeStyle = p.snowy ? rgba(mixc(ridge, hex(p.rim), 0.3)) : p.rim; fg.globalAlpha = 0.85; fg.lineWidth = 1; fg.beginPath();
    for (let x = 0; x <= W; x += 1) x ? fg.lineTo(x, p.landY(x)) : fg.moveTo(x, p.landY(x));
    fg.stroke(); fg.globalAlpha = 1;
    // fog: real fog, lying on the ground and thinning upward, with soft wisps; it swallows
    // the skyline. Rain hazes the distance a little too.
    if (p.kind === "fog" || p.raining || p.snowy) {
      const fogC = p.kind === "fog" ? (day ? hex("#c6cacd") : night ? hex("#2c2926") : mixc(hex("#2c2926"), hex("#c6cacd"), clamp01((p.sun.alt + 12) / 16))) : night ? mixc(CP.haze, CP.lit, 0.25) : mixc(hz, CP.shade, 0.3);
      const dense = p.kind === "fog" ? 1 : p.snowy ? 0.45 : 0.35;
      const t = document.createElement("canvas"); t.width = PW; t.height = PH;
      const tg = t.getContext("2d"), fi = tg.createImageData(PW, PH), fd = fi.data, rf = rng(211);
      for (let py = 0; py < PH; py++) {
        const y = (py + 0.5) / k, base = p.kind === "fog" ? 0.32 + 0.6 * sstep(10, HY + 8, y) : 0.9 * sstep(HY - 22, HY + 4, y) * (1 - sstep(HY + 4, H, y) * 0.5);
        for (let px = 0; px < PW; px++) {
          const x = (px + 0.5) / k, phi = 2 * Math.PI * x / W;
          const n = noise(Math.cos(phi) * 2.2, Math.sin(phi) * 2.2, y / 14) * 0.6 + noise(Math.cos(phi) * 5, Math.sin(phi) * 5, y / 6 + 9) * 0.3;
          const a = clamp01(dense * base * (0.82 + 0.5 * n)), i = 4 * (py * PW + px);
          fd[i] = fogC[0] + rf() - 0.5; fd[i + 1] = fogC[1] + rf() - 0.5; fd[i + 2] = fogC[2] + rf() - 0.5; fd[i + 3] = a * 255;
        }
      }
      tg.putImageData(fi, 0, 0); fg.setTransform(1, 0, 0, 1, 0, 0); fg.drawImage(t, 0, 0); t.width = t.height = 0;
    }

    // lightning: a forked bolt with its glow and the cloud it lights, flashed by opacity
    const fx = out.fx; fx.width = PW; fx.height = PH;
    if (p.kind === "storm") {
      const xg = fx.getContext("2d"), rl = rng(41); xg.scale(k, k);
      const x0 = 80 + rl() * 90, top = 14;
      const glow = xg.createRadialGradient(x0, top + 6, 0, x0, top + 6, 70);
      glow.addColorStop(0, "rgba(214,220,240,0.55)"); glow.addColorStop(0.4, "rgba(190,198,222,0.18)"); glow.addColorStop(1, "rgba(190,198,222,0)");
      xg.fillStyle = glow; xg.fillRect(0, 0, W, H);
      const bolt = (x, y, len, w) => { const path = [[x, y]]; while (y < p.landY(x) && path.length < len) { x += (rl() - 0.5) * 9; y += 3 + rl() * 4.5; path.push([x, Math.min(y, p.landY(x))]); } return path; };
      const main = bolt(x0, top, 40), branch = bolt(...main[Math.floor(main.length * 0.4)], 6);
      for (const [path, w] of [[main, 1.3], [branch, 0.7]]) {
        xg.lineJoin = "miter"; xg.lineCap = "round";
        for (const [lw, col] of [[w * 5, "rgba(200,210,255,0.18)"], [w * 2.4, "rgba(225,232,255,0.45)"], [w, "rgba(255,255,250,1)"]]) {
          xg.lineWidth = lw; xg.strokeStyle = col; xg.beginPath(); path.forEach(([x, y], i) => (i ? xg.lineTo(x, y) : xg.moveTo(x, y))); xg.stroke();
        }
      }
    }

    // precipitation: a tile two windows tall that falls one window per cycle
    let precip = null;
    if (p.raining || p.snowy) precip = precipTile(p, S, CP, PW, PH);
    return { cloud, precip };
  }

  function cloudTile(p, S, CP, PW, PH, r) {
    const { W, HY, k } = p, N = PW * PH;
    const field = new Float32Array(N);
    // per row: elevation, depth to the layer, the cylinder's radius and the noise footprint
    const OCT = 5;
    for (let py = 0; py < PH; py++) {
      // depth keeps growing through the skyline (rows behind the hills still differ), so the
      // last rows above a low stretch of skyline never repeat into columns
      const y = (py + 0.5) / k, el = (yy) => Math.max(-2.5, (HY - yy) / 1.45) * Math.PI / 180;
      const e = el(y), dep = 1 / (Math.sin(e) + 0.07), dep1 = 1 / (Math.sin(el(y + 1 / k)) + 0.07);
      const R = 0.42 * dep, Z = 1.25 * dep;
      const fpH = 2 * Math.PI * R / PW, fpV = Math.abs(dep1 - dep) * 1.25;
      const fp = Math.max(fpH, fpV);
      const wts = []; let amp = 1, fq = 1;
      for (let o = 0; o < OCT; o++) { wts.push(amp * clamp01((0.5 - fq * fp) / 0.28)); amp *= 0.52; fq *= 2.03; }
      for (let px = 0; px < PW; px++) {
        const phi = 2 * Math.PI * (px + 0.5) / PW;
        let X = Math.cos(phi) * R, Y = Math.sin(phi) * R, z = Z;
        // a slow warp so edges billow instead of reading as noise
        const wv = noise(X * 0.6 + 11.3, Y * 0.6, z * 0.6) * 0.6;
        X += wv; z -= wv;
        let v = 0, f = 1;
        for (let o = 0; o < OCT; o++) { if (wts[o] > 0) v += wts[o] * noise(X * f, Y * f, z * f + o * 17.1); f *= 2.03; }
        field[py * PW + px] = v;
      }
    }
    // cover: the top `cov` of the field over the sky (above the skyline) is cloud
    const samp = [];
    for (let py = 0; py < (HY - 3) * k; py += 2) for (let px = 0; px < PW; px += 3) samp.push(field[py * PW + px]);
    samp.sort((a, b) => a - b);
    const q = (u) => samp[Math.max(0, Math.min(samp.length - 1, Math.floor(u * samp.length)))];
    const lo = q(0.01), hi = q(0.995), cov = clamp01(p.cov);
    const t = q(1 - cov), soft = (hi - lo) * (cov > 0.9 ? 0.08 : 0.11);
    // A deck (cover 85 % and up) is one sheet: no holes cut through it, only thin and thick
    // places across the field's whole range. A broken sky is cut at the cover quantile.
    const deck = cov >= 0.85;
    const dens = new Float32Array(N), thick = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const v = field[i];
      if (deck) { dens[i] = 1; thick[i] = clamp01((v - lo) / Math.max(1e-6, hi - lo)); }
      else { dens[i] = sstep(t - soft * 0.5, t + soft, v); thick[i] = clamp01((v - t) / Math.max(1e-6, hi - t)); }
    }
    // light: a short march toward the light in window space (one direction for the whole
    // tile, so the lighting stays right as the tile drifts)
    const [lx, ly] = p.light || [0, 1], steps = 6, stepPx = 2.4 * k;
    const img = new ImageData(PW, PH), D = img.data;
    const deckLit = p.cov >= 0.85;
    for (let py = 0; py < PH; py++) {
      const y = (py + 0.5) / k, e = Math.max(0, (HY - y) / 1.45);
      const haze = clamp01(Math.exp(-e / 5) * 0.6);
      // the last degree or so is all distance: cloud and gaps merge into one haze
      const merge = sstep(1.4, 0.2, e);
      // a night deck is lit from below by the town: brighter toward the horizon
      // (and a broken sky's cloud is lit only where the glow reaches, near the horizon; high
      // up it is a silhouette)
      // v5: plus a band over the last few degrees, where the base is seen edge-on over the
      // town and returns the most of its light
      const town = p.sun.alt <= -6 && !p.moonLight;
      const glowRow = town ? (deckLit ? 0.5 + 0.5 * Math.pow(sstep(0, HY, y), 1.4) + 0.32 * Math.exp(-e / 3) : 0.15 + 0.85 * Math.pow(sstep(0, HY, y), 2.2)) : 1;
      // the base's relief under the town: a lump's underside (thicker than the row below
      // it) faces the light and catches it, the cloud just above a lump falls into shadow.
      // Only overhead: lower down, rows are kilometres apart and a screen-space offset cuts
      // the flattened billows into ripples. There the tone flattens too, toward the band.
      const relief = town && deckLit ? 1.6 * sstep(8, 24, e) : 0, rb = Math.round(1.5 * k);
      const flat = town && deckLit ? 0.5 + 0.5 * sstep(2, 22, e) : 1;
      for (let px = 0; px < PW; px++) {
        const i = py * PW + px, a = dens[i] + (cov * 0.85 - dens[i]) * merge;
        if (a <= 0.002) continue;
        let s = 0;
        // (no light direction = the town's diffuse glow from below: no march, which would
        // smear the field down each column into streaks; thickness and the row carry it)
        if (p.light) for (let j = 1; j <= steps; j++) {
          // x wraps (the tile repeats); above the window the deck goes on (hold at the top
          // row), below it is land, so the march ends there
          const qx = ((Math.round(px + lx * stepPx * j) % PW) + PW) % PW, qy = Math.max(0, Math.round(py + ly * stepPx * j));
          if (qy >= PH) break;
          const ii = qy * PW + qx; s += dens[ii] * (0.35 + 0.65 * thick[ii]);
        }
        // (diffuse glow from below: thicker cloud returns more of it)
        const T = !p.light ? 0.25 + 0.75 * Math.sqrt(thick[i]) : Math.exp(-s * (deckLit ? 0.12 : 0.9));
        const th = thick[i];
        let c;
        if (deckLit) {
          // a deck's tone is its thickness: thin places glow by day and fall dark by night;
          // the march adds the relief of its billows
          let lum = CP.thinBright ? 0.18 + 0.82 * Math.pow(1 - th, 0.9) : town ? 0.08 + 0.92 * Math.pow(th, 1.1) : 0.15 + 0.85 * Math.pow(th, 0.8);
          if (relief) lum += relief * (th - thick[Math.min(PH - 1, py + rb) * PW + px]);
          if (flat < 1) lum = 0.45 + (lum - 0.45) * flat;
          c = mixc(CP.shade, CP.lit, clamp01(lum * (0.7 + 0.3 * T)));
        } else c = mixc(CP.shade, CP.lit, clamp01(0.1 + 0.9 * T));
        const dk = deckLit ? 1 : 1 - CP.dark * th;
        c = [c[0] * dk, c[1] * dk, c[2] * dk];
        c = mixc(c, CP.haze, Math.max(haze, merge * 0.8));
        c = [c[0] * glowRow, c[1] * glowRow, c[2] * glowRow];
        // thin edges let a little sky through
        const alpha = Math.pow(a, 0.85);
        D[4 * i] = c[0] + r() - 0.5; D[4 * i + 1] = c[1] + r() - 0.5; D[4 * i + 2] = c[2] + r() - 0.5; D[4 * i + 3] = alpha * 255 + r() - 0.5;
      }
    }
    const c = document.createElement("canvas"); c.width = PW; c.height = PH;
    c.getContext("2d").putImageData(img, 0, 0);
    return c;
  }

  function precipTile(p, S, CP, PW, PH) {
    const { W, H, k } = p, c = document.createElement("canvas"); c.width = PW; c.height = PH * 2;
    const g = c.getContext("2d"), r = rng(19); g.scale(k, k);
    const day = p.sun.alt > 4;
    const slant = Math.max(-0.5, Math.min(0.5, p.windX * 0.012));
    // periodic in one window's height: every drop drawn a window above and below as well
    const draw = (fn) => { for (const off of [-H, 0, H, 2 * H]) fn(off); };
    if (p.snowy) {
      const n = Math.round(36 + 24 * Math.min(2, p.rate));
      for (let i = 0; i < n; i++) {
        const x = r() * W, y = r() * H, near = r(), rad = 0.5 + near * near * 1.1, a = (day ? 0.55 : 0.3) + (day ? 0.4 : 0.3) * near;
        const col = day ? "248,250,252" : "176,174,170";
        draw((off) => {
          const gr = g.createRadialGradient(x, y + off, 0, x, y + off, rad * 1.6);
          gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(0.55, `rgba(${col},${a * 0.7})`); gr.addColorStop(1, `rgba(${col},0)`);
          g.fillStyle = gr; g.fillRect(x - rad * 1.6, y + off - rad * 1.6, rad * 3.2, rad * 3.2);
        });
      }
    } else {
      const drizzle = p.kind === "drizzle", n = drizzle ? 40 : Math.round(46 + 24 * Math.min(3, p.rate));
      const col = day ? [236, 240, 244] : p.sun.alt > -12 ? [170, 176, 184] : [150, 140, 128];
      for (let i = 0; i < n; i++) {
        const near = r(), x = r() * W, y = r() * H;
        const L = (drizzle ? 2.5 : 5) + near * (drizzle ? 2 : 6), a = (drizzle ? 0.25 : 0.22) + near * (drizzle ? 0.25 : 0.38), w = 0.45 + near * (drizzle ? 0.3 : 0.6);
        draw((off) => {
          const y0 = y + off, x1 = x + slant * L, y1 = y0 + L, gr = g.createLinearGradient(x, y0, x1, y1);
          gr.addColorStop(0, rgba(col, 0)); gr.addColorStop(1, rgba(col, a));
          g.strokeStyle = gr; g.lineWidth = w; g.lineCap = "round"; g.beginPath(); g.moveTo(x, y0); g.lineTo(x1, y1); g.stroke();
        });
      }
    }
    return c;
  }

  window.MM_SKY = { paint };
})();
