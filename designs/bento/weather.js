// The weather tile: a lit window onto the real sky (state.weather), for every kind the feed
// reports: clear, partly, cloudy, fog, drizzle, rain, snow, storm, by day and by night.
// Cost rules (README 8, 8a): every texture is painted once into a canvas when the weather changes,
// then moved by transform and opacity only: falling things from Kiln.loop at 30 fps (snow 20),
// drifting cloud and fog one CSS pixel at a time (at most 15 fps, or on the feed's own lines when
// those come often enough; see cadence). No filters, no blur.
// Clouds drift with the real wind (speed and direction); rain slants with it.
(function () {
  "use strict";
  const { rng } = BK;
  let root, W, H, HZ, DPR, L = {}, P = null, stopLoop = null;
  const keys = {};
  const T = 128; // precipitation tile, CSS px

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const rgb = (c, a) => (a == null ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

  function canvas(w, h, scale) {
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    c.style.width = w + "px"; c.style.height = h + "px";
    const x = c.getContext("2d");
    x.scale(scale, scale);
    return [c, x];
  }
  function layer(tag) {
    const e = document.createElement(tag || "div");
    e.style.willChange = "transform, opacity";
    root.appendChild(e);
    return e;
  }

  // The tile's size, read once and again only when it changes (a ResizeObserver, never a
  // per-tick layout read); a new size clears every texture so the next line repaints it.
  // The horizon sits just above the sill (index.html, the card that carries the words), so the
  // trees and the town stand on its top edge and the ground runs on behind it.
  function measure() {
    W = Math.round(root.clientWidth) || 472;
    H = Math.round(root.clientHeight) || 260;
    const sill = document.querySelector("#C .sill");
    HZ = sill && sill.offsetTop > H * 0.4 ? sill.offsetTop + 6 : Math.round(H * 0.823);
    DPR = Math.min(2, window.devicePixelRatio || 1);
    for (const k in keys) delete keys[k];
    if (L.flashRim) {
      L.flashRim.style.cssText = `inset:0;width:${W}px;height:${H}px;border-radius:24px;opacity:0;will-change:opacity;box-shadow:inset 0 0 0 1.5px rgba(214,228,255,0.9),inset 0 0 26px rgba(190,210,255,0.45)`;
      L.flashSky.style.cssText = `left:0;top:0;width:${W}px;height:${HZ}px;opacity:0;will-change:transform,opacity;background:radial-gradient(60% 70% at 50% 18%,rgba(214,226,255,0.85),rgba(160,180,255,0.25) 45%,rgba(160,180,255,0) 75%)`;
    }
  }
  let last = null;
  function init() {
    root = document.getElementById("wx");
    measure();
    new ResizeObserver(() => {
      const w = Math.round(root.clientWidth), h = Math.round(root.clientHeight);
      if (w === W && h === H) return;
      measure();
      if (last) update.apply(null, last);
    }).observe(root);
    // back to front: sky, far and near clouds, the lightning in the deck, land, fog,
    // precipitation far and near, the glass with its beads, running drops, the rim flash
    L.sky = layer("canvas");
    L.cloudFar = layer("canvas"); L.cloudNear = layer("canvas");
    L.flashSky = layer(); L.flashSky.style.opacity = 0;
    L.land = layer("canvas");
    L.fogA = layer("canvas"); L.fogB = layer("canvas");
    L.pFar = layer(); L.pNear = layer();
    L.glass = layer("canvas");
    L.drops = [0, 1, 2].map(() => { const d = layer("canvas"); d.style.opacity = 0; return { el: d, y: 0, v: 0, wait: 0, x: 0, live: false }; });
    L.flashRim = layer();
    measure();
    paintDrop();
  }

  // ---------------------------------------------------------------- periodic value noise
  function hash(ix, iy, seed) {
    const s = Math.sin(ix * 127.1 + iy * 311.7 + seed * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }
  // fBm that wraps every `period` lattice cells in x, so a strip tiles seamlessly
  function fbm(x, y, period, seed, oct) {
    let v = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < oct; o++) {
      const p = period << o, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const x0 = ((ix % p) + p) % p, x1 = (x0 + 1) % p;
      const a = hash(x0, iy, seed + o), b = hash(x1, iy, seed + o), c = hash(x0, iy + 1, seed + o), d = hash(x1, iy + 1, seed + o);
      v += amp * (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy);
      norm += amp; amp *= 0.5; x *= 2; y *= 2;
    }
    return v / norm;
  }

  // A cloud strip TW wide that tiles in x, painted once, with W extra so a translate can wrap.
  function paintClouds(el, o) {
    const TW = W * 2, TH = o.h, cw = TW + W;
    el.width = cw; el.height = TH;
    el.style.width = cw + "px"; el.style.height = TH + "px";
    const src = document.createElement("canvas");
    src.width = TW; src.height = TH;
    const sx = src.getContext("2d"), img = sx.createImageData(TW, TH), D = img.data;
    // fBm clusters around 0.5; stretched, its spread maps onto coverage, and a narrow edge
    // gives each cloud a body instead of a veil
    // The lattice is stretched so `per` cells span exactly TW: with o.cell as is, the noise wrapped
    // at per * cell (960 or 900 px) while the strip wraps at TW (944), and that seam drifted across
    // the window. The envelope reaches 0 at the strip's foot (it stopped at 0.15: a hard edge
    // halfway down the window).
    const thr = 1 - o.cover, per = Math.max(1, Math.round(TW / o.cell)), cell = TW / per;
    for (let j = 0; j < TH; j++) {
      const yy = j / TH, env = 1 - smooth(o.fadeFrom, 1, yy);
      const lit = Math.pow(yy, 1.6);
      for (let i = 0; i < TW; i++) {
        const v = clamp((fbm(i / cell, (j / o.cell) * o.stretch, per, o.seed, 5) - 0.5) * 2.1 + 0.5, 0, 1);
        const a = smooth(thr - 0.06, thr + 0.14, v) * env;
        const k = (j * TW + i) * 4;
        if (a <= 0.003) { D[k + 3] = 0; continue; }
        // density shades the body (dense = dark at night, bright by day); the town or the low
        // sun lights the underside toward the horizon
        const sh = clamp((v - 0.3) / 0.45, 0, 1);
        const c = mix(mix(o.dark, o.light, o.day ? sh : 1 - sh), o.lit, lit * o.glow * (0.5 + 0.5 * (1 - sh)));
        D[k] = c[0]; D[k + 1] = c[1]; D[k + 2] = c[2]; D[k + 3] = Math.round(a * o.alpha * 255);
      }
    }
    sx.putImageData(img, 0, 0);
    // the strip, then its start again past its end, so a translate can wrap without a seam
    const x = el.getContext("2d");
    x.clearRect(0, 0, cw, TH);
    x.drawImage(src, 0, 0);
    x.drawImage(src, 0, 0, W, TH, TW, 0, W, TH);
  }

  // ---------------------------------------------------------------- the sky
  function skyStops(p) {
    if (!p.day) {
      const c = p.cover;
      // the town lights the underside of a cloud deck; a clear night stays dark to the horizon
      return [[0, mix([5, 9, 20], [11, 18, 34], c)], [0.5, mix([12, 20, 44], [27, 33, 53], c)], [0.78, mix([24, 32, 60], [70, 52, 63], c)],
        [0.88, mix([38, 40, 66], [131, 82, 62], c)], [1, mix([20, 20, 30], [26, 18, 20], c)]];
    }
    const a = p.alt, golden = 1 - smooth(2, 16, a), over = clamp(p.cover * (p.kind === "partly" ? 0.4 : 1), 0, 1);
    const top = mix(mix([47, 111, 196], [58, 82, 140], golden), p.kind === "storm" ? [64, 70, 82] : [141, 150, 163], over);
    const midC = mix(mix([127, 176, 230], [198, 150, 150], golden), p.kind === "storm" ? [86, 92, 104] : [181, 188, 197], over);
    const hor = mix(mix([207, 226, 242], [242, 178, 122], golden), p.kind === "storm" ? [104, 108, 116] : [207, 211, 216], over);
    return [[0, top], [0.55, midC], [0.88, hor], [1, hor]];
  }
  function paintSky(p) {
    const [c, x] = canvas(W, H, DPR);
    L.sky.replaceWith(c); L.sky = c;
    const g = x.createLinearGradient(0, 0, 0, H);
    for (const [o, col] of skyStops(p)) g.addColorStop(o, rgb(col));
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    if (!p.day && p.cover < 0.7) {
      const r = rng(17), n = Math.round(140 * (1 - p.cover));
      for (let i = 0; i < n; i++) {
        const sx = r() * W, sy = r() * HZ * 0.8, a = (0.25 + r() * 0.6) * (1 - sy / HZ);
        x.fillStyle = `rgba(230,236,255,${a.toFixed(2)})`;
        x.beginPath(); x.arc(sx, sy, 0.4 + r() * 0.8, 0, 7); x.fill();
      }
    }
    if (p.day && p.sun && p.cover < 0.8) {
      const { sx, sy } = p.sun, vis = 1 - p.cover;
      const g2 = x.createRadialGradient(sx, sy, 0, sx, sy, 120);
      g2.addColorStop(0, `rgba(255,246,220,${0.85 * vis})`); g2.addColorStop(0.12, `rgba(255,236,190,${0.5 * vis})`); g2.addColorStop(1, "rgba(255,236,190,0)");
      x.fillStyle = g2; x.fillRect(0, 0, W, H);
      x.fillStyle = `rgba(255,252,240,${vis})`;
      x.beginPath(); x.arc(sx, sy, 11, 0, 7); x.fill();
    }
  }

  // ---------------------------------------------------------------- the land: ridge, town, trees
  function paintLand(p) {
    const [c, x] = canvas(W, H, DPR);
    L.land.replaceWith(c); L.land = c;
    const k = W / 472, hz = HZ, day = p.day, r = rng(5);
    if (!day) { // the town's glow on the low sky: an ellipse 0.8 W across and 110 px high
      // The fill covers the whole canvas in the squashed space. It used to start at y 0 of that
      // space, which landed at 0.63 H on screen and cut the glow off in a straight line.
      const rx = W * 0.8, s = 110 / rx, cy = hz + 20;
      const g = x.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, `rgba(240,160,96,${0.55 * (0.4 + p.cover * 0.6)})`); g.addColorStop(1, "rgba(240,160,96,0)");
      x.save(); x.translate(W * 0.55, cy); x.scale(1, s);
      x.fillStyle = g; x.fillRect(-W, -cy / s, 2 * W, H / s); x.restore();
    }
    const fog = p.fog;
    // far ridge, in haze
    x.beginPath(); x.moveTo(0, hz - 16);
    for (let xx = 0; xx <= W; xx += 24) x.lineTo(xx, hz - 18 - Math.sin(xx / 70) * 5);
    x.lineTo(W, hz); x.lineTo(0, hz); x.closePath();
    x.fillStyle = day ? rgb(mix([96, 112, 126], [190, 196, 204], fog), 0.9) : rgb(mix([60, 44, 49], [80, 76, 84], fog), 0.85);
    x.fill();
    // town: a tower and a spire
    const town = day ? rgb(mix([52, 60, 70], [170, 176, 184], fog * 0.9)) : rgb(mix([21, 18, 27], [62, 60, 70], fog * 0.8));
    x.fillStyle = town;
    const tx = 290 * k;
    x.fillRect(tx, hz - 40, 34, 40); x.fillRect(tx + 6, hz - 52, 22, 12);
    x.beginPath(); x.moveTo(tx + 8, hz - 52); x.quadraticCurveTo(tx + 17, hz - 69, tx + 26, hz - 52); x.fill();
    x.fillRect(tx + 16, hz - 72, 2, 8);
    x.fillRect(110 * k, hz - 30, 16, 30);
    x.beginPath(); x.moveTo(110 * k, hz - 30); x.lineTo(118 * k, hz - 72); x.lineTo(126 * k, hz - 30); x.fill();
    if (!day) { x.fillStyle = `rgba(255,216,160,${0.85 * (1 - fog * 0.6)})`; roundRect(x, tx + 9, hz - 37, 16, 9, 4.5); x.fill(); }
    // snow on the roofs and the spire, by how much has fallen
    if (p.snow > 0) {
      x.fillStyle = `rgba(236,240,248,${(0.35 + p.snow * 0.6).toFixed(2)})`;
      x.fillRect(tx, hz - 41, 34, 2.2); x.fillRect(tx + 6, hz - 53, 22, 2);
    }
    // fog: the ridge and the town fade first
    if (fog > 0) {
      const g = x.createLinearGradient(0, hz - 80, 0, hz + 12);
      const fc = day ? [214, 218, 224] : [96, 92, 104];
      g.addColorStop(0, rgb(fc, 0)); g.addColorStop(0.6, rgb(fc, 0.72 * fog)); g.addColorStop(1, rgb(fc, 0.55 * fog));
      x.fillStyle = g; x.fillRect(0, hz - 80, W, 92);
    } else if (p.humidity) {
      x.fillStyle = day ? `rgba(230,234,240,${(p.humidity / 100) * 0.1})` : `rgba(217,200,189,${(p.humidity / 100) * 0.08})`;
      x.fillRect(0, hz - 18, W, 30);
    }
    // near trees and the ground
    const tree = day ? [29, 42, 36] : [6, 7, 12];
    x.fillStyle = rgb(tree);
    const crowns = [];
    for (let xx = -10; xx < W + 10; xx += 5 + r() * 7) {
      const tall = r() < 0.2 ? 18 + r() * 18 : 4 + r() * 12, rad = 5 + r() * 9;
      crowns.push([xx, hz + 3 - tall, rad]);
      x.beginPath(); x.arc(xx, hz + 3 - tall, rad, 0, 7); x.fill();
    }
    x.fillStyle = rgb(day ? [34, 44, 38] : [7, 8, 12]);
    x.fillRect(0, hz, W, H - hz);
    if (p.snow > 0) {
      x.fillStyle = `rgba(232,236,246,${(0.25 + p.snow * 0.55).toFixed(2)})`;
      for (const [cx, cy, rad] of crowns) { x.beginPath(); x.arc(cx, cy - rad * 0.35, rad * 0.62, Math.PI * 1.1, Math.PI * 1.9); x.fill(); }
      x.fillStyle = day ? `rgba(226,230,238,${(0.4 + p.snow * 0.5).toFixed(2)})` : `rgba(120,128,146,${(0.4 + p.snow * 0.5).toFixed(2)})`;
      x.fillRect(0, hz, W, H - hz);
    }
    // street lamps at night, with their reflections when the road is wet
    if (!day) {
      const rl = rng(9);
      for (let lx = 30; lx < W; lx += 95 + rl() * 30) {
        if (p.wet) {
          const g = x.createLinearGradient(0, hz + 10, 0, H);
          g.addColorStop(0, "rgba(255,196,122,0.4)"); g.addColorStop(1, "rgba(255,196,122,0)");
          x.fillStyle = g; x.fillRect(lx - 2, hz + 10, 4, H - hz - 10);
        }
        const g = x.createRadialGradient(lx, hz + 8, 0, lx, hz + 8, 16);
        g.addColorStop(0, "rgba(255,224,168,1)"); g.addColorStop(0.3, "rgba(255,180,92,0.4)"); g.addColorStop(1, "rgba(255,180,92,0)");
        x.fillStyle = g; x.fillRect(lx - 16, hz - 8, 32, 32);
      }
    }
  }
  function roundRect(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }

  // ---------------------------------------------------------------- precipitation tiles
  function precipTile(kind, near) {
    const [c, x] = canvas(T, T, DPR), r = rng(near ? 23 : 31);
    const wrap = (fn) => { for (const dx of [-T, 0, T]) for (const dy of [-T, 0, T]) fn(dx, dy); };
    if (kind === "snow") {
      const n = near ? 16 : 34;
      for (let i = 0; i < n; i++) {
        const px = r() * T, py = r() * T, rad = near ? 1.3 + r() * 1.3 : 0.6 + r() * 0.7, a = near ? 0.75 + r() * 0.25 : 0.45 + r() * 0.3;
        wrap((dx, dy) => {
          const g = x.createRadialGradient(px + dx, py + dy, 0, px + dx, py + dy, rad * 1.6);
          g.addColorStop(0, `rgba(250,252,255,${a})`); g.addColorStop(0.55, `rgba(250,252,255,${a * 0.7})`); g.addColorStop(1, "rgba(250,252,255,0)");
          x.fillStyle = g; x.beginPath(); x.arc(px + dx, py + dy, rad * 1.6, 0, 7); x.fill();
        });
      }
    } else {
      const spec = { drizzle: [10, 22, 5, 9, 0.16, 0.3], rain: [18, 34, 12, 20, 0.2, 0.38], storm: [26, 44, 16, 26, 0.22, 0.42] }[kind] || [10, 22, 5, 9, 0.16, 0.3];
      const n = near ? spec[0] : spec[1], l0 = near ? spec[3] : spec[2], a0 = near ? spec[5] : spec[4];
      x.lineCap = "round";
      x.lineWidth = near ? 0.9 : 0.6;
      for (let i = 0; i < n; i++) {
        const px = r() * T, py = r() * T, len = l0 * (0.6 + r() * 0.6), a = a0 * (0.6 + r() * 0.7);
        x.strokeStyle = `rgba(214,226,250,${a.toFixed(2)})`;
        wrap((dx, dy) => { x.beginPath(); x.moveTo(px + dx, py + dy); x.lineTo(px + dx, py + dy + len); x.stroke(); });
      }
    }
    return c.toDataURL();
  }
  function setupPrecip(p) {
    const on = !!p.precip;
    for (const [el, near] of [[L.pFar, false], [L.pNear, true]]) {
      el.style.display = on ? "" : "none";
      if (!on) continue;
      const pad = Math.ceil(H * Math.tan((Math.abs(p.slant) * Math.PI) / 180)) + 24;
      el.style.cssText += `;left:${-T - pad}px;top:${-T - pad}px;width:${W + 2 * T + 2 * pad}px;height:${H + 2 * T + 2 * pad}px;` +
        `background-image:url(${precipTile(p.precip, near)});background-size:${T}px ${T}px;opacity:${near ? 1 : 0.8}`;
    }
  }

  // ---------------------------------------------------------------- the glass and its beads
  function paintGlass(p) {
    const [c, x] = canvas(W, H, DPR);
    L.glass.replaceWith(c); L.glass = c;
    const spec = { drizzle: [160, 34, 1.4, 2.2], rain: [120, 46, 1.8, 3.2], storm: [130, 52, 1.8, 3.4], fog: [520, 0, 0, 0], snow: [0, 8, 1.2, 1.6] }[p.kind];
    if (!spec) return;
    const r = rng(41);
    for (let i = 0; i < spec[0]; i++) {
      const fogk = p.kind === "fog";
      x.fillStyle = `rgba(226,232,246,${((fogk ? 0.05 : 0.12) + r() * (fogk ? 0.08 : 0.2)).toFixed(2)})`;
      x.beginPath(); x.arc(r() * W, r() * H, fogk ? 0.3 + r() * 0.5 : 0.5 + r() * 0.8, 0, 7); x.fill();
    }
    for (let i = 0; i < spec[1]; i++) bead(x, r() * W, r() * H, spec[2] + r() * spec[3]);
  }
  // a bead on the glass: a lens that carries the scene upside down, dark on top, lit below
  function bead(x, bx, by, rad) {
    const g = x.createLinearGradient(0, by - rad, 0, by + rad);
    g.addColorStop(0, "rgba(255,201,142,0.3)"); g.addColorStop(0.5, "rgba(140,138,160,0.06)"); g.addColorStop(1, "rgba(214,222,239,0.26)");
    x.fillStyle = g; x.beginPath(); x.arc(bx, by, rad, 0, 7); x.fill();
    x.lineWidth = Math.min(1, rad * 0.22); x.strokeStyle = "rgba(3,5,10,0.4)";
    x.beginPath(); x.arc(bx, by, rad, Math.PI * 1.11, Math.PI * 1.89); x.stroke();
    x.lineWidth = Math.min(0.9, rad * 0.2); x.strokeStyle = "rgba(255,236,210,0.55)";
    x.beginPath(); x.arc(bx, by, rad, Math.PI * 0.15, Math.PI * 0.85); x.stroke();
    x.fillStyle = "rgba(255,255,255,0.9)"; x.beginPath(); x.arc(bx - rad * 0.32, by - rad * 0.4, Math.max(0.45, rad * 0.17), 0, 7); x.fill();
  }
  // one running drop: a bead with the faint wet trail it leaves above it
  function paintDrop() {
    const [c, x] = canvas(10, 46, DPR);
    const g = x.createLinearGradient(0, 0, 0, 40);
    g.addColorStop(0, "rgba(214,226,250,0)"); g.addColorStop(1, "rgba(214,226,250,0.22)");
    x.fillStyle = g; x.fillRect(4, 0, 2, 40);
    bead(x, 5, 40, 3.2);
    for (const d of L.drops) {
      d.el.width = c.width; d.el.height = c.height; d.el.style.width = "10px"; d.el.style.height = "46px";
      d.el.getContext("2d").drawImage(c, 0, 0);
    }
  }

  // ---------------------------------------------------------------- the reading -> scene parameters
  function params(w, t, day) {
    const kind = w ? w.kind : "cloudy";
    const cloud = clamp(((w && w.cloud) != null ? w.cloud : 60) / 100, 0, 1);
    const heavy = ["drizzle", "rain", "storm", "snow"].includes(kind);
    const cover = kind === "clear" ? Math.min(cloud, 0.12) : heavy ? Math.max(cloud, 0.88) : kind === "fog" ? Math.max(cloud, 0.75) : kind === "partly" ? clamp(cloud, 0.25, 0.65) : Math.max(cloud, 0.7);
    // where the sun is: across the window from sunrise to sunset, its height from the arc of the day
    let alt = -20, sun = null;
    if (day && w) {
      let f = 0.35;
      if (w._day == null && w.sunrise && w.sunset && w.sunset > w.sunrise) f = clamp((t - w.sunrise) / (w.sunset - w.sunrise), 0, 1);
      alt = Math.sin(Math.PI * f) * 35;
      // its arc keeps to the band between the figures' foot and the horizon, clear of the type
      sun = { sx: W * (0.12 + 0.76 * f), sy: HZ - 14 - (alt / 35) * (HZ - 14 - H * 0.44) };
    }
    // the wind: km/h -> px/s; it blows from wind_dir, so a westerly carries the clouds right
    const wk = w && w.wind_kmh != null ? w.wind_kmh : 8, dir = ((w && w.wind_dir) || 250) * Math.PI / 180;
    const sign = -Math.sin(dir) >= 0 ? 1 : -1, v = Math.max(1.2, wk * 0.28) * sign;
    const precip = ["drizzle", "rain", "storm", "snow"].includes(kind) ? kind : null;
    const slant = precip && precip !== "snow" ? clamp(-sign * Math.min(22, wk * 0.7), -22, 22) : 0;
    return {
      kind, day: !!day, cover, alt, sun, precip, slant, cloudV: v,
      fog: kind === "fog" ? 0.85 : 0, wet: ["drizzle", "rain", "storm"].includes(kind) || (w && w.rain_mm > 0),
      snow: kind === "snow" || (w && w.snow_cm > 0) ? clamp(0.25 + ((w && w.snow_cm) || 0) / 6, 0, 1) : 0,
      humidity: w ? w.humidity : null,
      fallV: { drizzle: [230, 150], rain: [520, 340], storm: [700, 460], snow: [34, 20] }[precip] || [0, 0],
      drops: { drizzle: 1, rain: 2, storm: 3 }[kind] || 0,
    };
  }

  function cloudStyle(p, near) {
    const night = !p.day, storm = p.kind === "storm", over = p.cover > 0.7;
    const dark = night ? (storm ? [8, 9, 15] : [14, 17, 28]) : storm ? [40, 44, 54] : over ? [118, 124, 136] : [186, 194, 208];
    const light = night ? (storm ? [44, 46, 60] : [72, 78, 102]) : storm ? [96, 102, 114] : over ? [204, 208, 216] : [255, 255, 255];
    const lit = night ? (storm ? [96, 70, 72] : [176, 112, 86]) : storm ? [70, 72, 80] : [232, 196, 170];
    return {
      h: Math.round(near ? HZ * 0.62 : HZ * 0.95), cell: near ? 150 : 96, stretch: near ? 2.2 : 2.8, seed: near ? 3 : 11,
      cover: near ? p.cover * 0.92 : p.cover, dark, light, lit, day: p.day, glow: night ? 0.75 : 1 - smooth(2, 16, p.alt), fadeFrom: near ? 0.5 : 0.62,
      alpha: (near ? 1 : 0.9) * (p.kind === "fog" ? 0.7 : 1),
    };
  }

  function paintFog(el, seed, h) {
    const TW = W * 2, cw = TW + W;
    el.width = cw; el.height = h; el.style.width = cw + "px"; el.style.height = h + "px";
    const src = document.createElement("canvas");
    src.width = TW; src.height = h;
    // per cells span exactly TW, so the bank wraps without a seam (see paintClouds)
    const sx = src.getContext("2d"), img = sx.createImageData(TW, h), D = img.data, per = Math.max(1, Math.round(TW / 180)), cx = TW / per;
    const c = P.day ? [226, 230, 236] : [120, 116, 128];
    for (let j = 0; j < h; j++) {
      const env = Math.sin((j / h) * Math.PI);
      for (let i = 0; i < TW; i++) {
        const v = fbm(i / cx, (j / 180) * 5, per, seed, 4), k = (j * TW + i) * 4;
        D[k] = c[0]; D[k + 1] = c[1]; D[k + 2] = c[2]; D[k + 3] = Math.round(clamp((v - 0.35) / 0.4, 0, 1) * env * 0.8 * 255);
      }
    }
    sx.putImageData(img, 0, 0);
    const x = el.getContext("2d");
    x.clearRect(0, 0, cw, h);
    x.drawImage(src, 0, 0);
    x.drawImage(src, 0, 0, W, h, TW, 0, W, h);
  }

  // ---------------------------------------------------------------- the figures' ink
  // README, Preferences, "No veils on the sky": nothing is laid over the sky to help the type.
  // The clock and the temperature stand on the sky in the ink the sky allows, white or near
  // black, read from the pixels this file actually painted behind each figure: the sky, both
  // cloud decks at 16 drift positions each (each deck at its own stride, since they drift at
  // different speeds), the land and the fog banks. The ink whose 5th-percentile APCA Lc is
  // higher behind both figures wins; if even that is under 60 (large type) behind either, both
  // go onto cards in the theme's tile colours (index.html .nb.card), so the pair always matches.
  // A 2 px halo hugs the glyphs on the sky. Once per
  // repaint of the scene, never per line. The words sit on the sill, a card, always.
  const LIN = Float64Array.from({ length: 256 }, (_, i) => Math.pow(i / 255, 2.4));
  const sY = (r, g, b) => 0.2126729 * LIN[r] + 0.7151522 * LIN[g] + 0.072175 * LIN[b];
  function apca(yt, yb) {                  // APCA 0.0.98G-4g, |Lc|
    const cl = (y) => (y < 0.022 ? y + Math.pow(0.022 - y, 1.414) : y);
    yt = cl(yt); yb = cl(yb);
    if (Math.abs(yb - yt) < 0.0005) return 0;
    if (yb > yt) { const s = (Math.pow(yb, 0.56) - Math.pow(yt, 0.57)) * 1.14; return s < 0.1 ? 0 : (s - 0.027) * 100; }
    const s = (Math.pow(yb, 0.65) - Math.pow(yt, 0.62)) * 1.14; return s > -0.1 ? 0 : -(s + 0.027) * 100;
  }
  const INKS = { light: sY(255, 255, 255), dark: sY(17, 17, 20) }, LC_LARGE = 60;
  const FIGS = ["wx-nb-clock", "wx-nb-temp"];
  function ink() {
    const r0 = root.getBoundingClientRect();
    // the glyphs' box: the figure less its card padding (index.html .nb, 3 10 6 10)
    const boxes = FIGS.map((id) => { const e = document.getElementById(id), b = e.getBoundingClientRect();
      return { e, x0: b.left - r0.left + 10, x1: b.right - r0.left - 10, y0: b.top - r0.top + 3, y1: b.bottom - r0.top - 6 }; });
    const Y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y0)))), Y1 = Math.min(H, Math.ceil(Math.max(...boxes.map((b) => b.y1))));
    // the first line arrives before its figures are written (bento.js): try again on the next
    if (Y1 <= Y0 || boxes.some((b) => b.x1 - b.x0 < 8)) return false;
    // a canvas's pixels over rows Y0..Y1 of the tile; s is its backing scale, top its offset
    const grab = (cv, s, top) => {
      if (!cv || cv.style.display === "none" || !cv.width) return null;
      const a = Math.max(0, Math.floor((Y0 - top) * s)), b = Math.min(cv.height, Math.ceil((Y1 - top) * s));
      if (b <= a) return null;
      return { d: cv.getContext("2d").getImageData(0, a, cv.width, b - a).data, w: cv.width, a, s, top };
    };
    const at = (g, x, y) => {             // [r, g, b, a] of a grabbed canvas at tile css (x, y)
      const j = Math.floor((y - g.top) * g.s) - g.a, i = Math.floor(x * g.s);
      if (j < 0 || i < 0 || i >= g.w || j >= g.d.length / (4 * g.w)) return null;
      const p = (j * g.w + i) * 4; return [g.d[p], g.d[p + 1], g.d[p + 2], g.d[p + 3] / 255];
    };
    const sky = grab(L.sky, DPR, 0), land = grab(L.land, DPR, 0);
    const fogT = (el) => parseFloat(el.style.top) || 0;
    const decks = [[grab(L.cloudFar, 1, 0), 0], [grab(L.cloudNear, 1, 0), 0.31], [grab(L.fogA, 1, fogT(L.fogA)), 0.57], [grab(L.fogB, 1, fogT(L.fogB)), 0.83]];
    const TW = W * 2, N = 16, G = [0.618034, 0.414214, 0.302776, 0.236068];
    const info = {};
    for (const bx of boxes) {
      const lc = { light: [], dark: [] };
      for (let y = bx.y0 + 2; y < bx.y1; y += 4) for (let x = bx.x0 + 2; x < bx.x1; x += 4) {
        const s0 = sky && at(sky, x, y);
        if (!s0) continue;
        for (let n = 0; n < N; n++) {
          let r = s0[0], g = s0[1], b = s0[2];
          decks.forEach(([dk, off], k) => {
            if (!dk) return;
            const c = at(dk, x + ((n * G[k] + off) % 1) * TW, y);
            if (c && c[3]) { r += (c[0] - r) * c[3]; g += (c[1] - g) * c[3]; b += (c[2] - b) * c[3]; }
          });
          const c = land && at(land, x, y);
          if (c && c[3]) { r += (c[0] - r) * c[3]; g += (c[1] - g) * c[3]; b += (c[2] - b) * c[3]; }
          const yb = sY(r + 0.5 | 0, g + 0.5 | 0, b + 0.5 | 0);
          lc.light.push(apca(INKS.light, yb)); lc.dark.push(apca(INKS.dark, yb));
        }
      }
      const p5 = (a) => { a.sort((p, q) => p - q); return a.length ? a[Math.floor(a.length * 0.05)] : 0; };
      bx.L5 = p5(lc.light); bx.D5 = p5(lc.dark);
    }
    // the two figures are a pair: one ink and one treatment for both, judged on the weaker
    const L5 = Math.min(...boxes.map((b) => b.L5)), D5 = Math.min(...boxes.map((b) => b.D5));
    const k = L5 >= D5 ? "light" : "dark", card = Math.max(L5, D5) < LC_LARGE;
    for (const bx of boxes) {
      if (bx.e.dataset.ink !== k) bx.e.dataset.ink = k;
      bx.e.classList.toggle("card", card);
      bx.e.dataset.lc = (k === "light" ? bx.L5 : bx.D5).toFixed(1);
      info[bx.e.id] = { ink: k, lc5: +(k === "light" ? bx.L5 : bx.D5).toFixed(1), card };
    }
    inkInfo = info;
  }
  let inkInfo = null;

  // ---------------------------------------------------------------- update + loop
  function update(w, t, day) {
    if (!root) init();
    last = [w, t, day];
    const p = params(w, t, day);
    P = p;
    const sunB = p.sun ? Math.round(p.sun.sx / 3) + ":" + Math.round(p.sun.sy / 3) : "";
    const k = { sky: [p.kind, p.day, Math.round(p.cover * 20), sunB, p.snow > 0].join("|"),
      cloud: [p.kind, p.day, Math.round(p.cover * 20)].join("|"),
      land: [p.kind, p.day, p.fog, p.wet, Math.round(p.snow * 10), Math.round((p.humidity || 0) / 10)].join("|"),
      precip: [p.precip, Math.round(p.slant)].join("|"), glass: p.kind };
    if (k.sky !== keys.sky) {
      keys.sky = k.sky;
      paintSky(p);
    }
    const repaint = k.sky !== keys.inkSky || k.cloud !== keys.inkCloud || k.land !== keys.inkLand;
    if (k.cloud !== keys.cloud) {
      keys.cloud = k.cloud;
      paintClouds(L.cloudFar, cloudStyle(p, false));
      paintClouds(L.cloudNear, cloudStyle(p, true));
      L.cloudNear.style.display = p.cover < 0.2 ? "none" : "";
    }
    if (k.land !== keys.land) {
      keys.land = k.land;
      paintLand(p);
      const fog = p.kind === "fog";
      L.fogA.style.display = L.fogB.style.display = fog ? "" : "none";
      if (fog) { paintFog(L.fogA, 5, 110); paintFog(L.fogB, 9, 90); L.fogA.style.top = HZ - 84 + "px"; L.fogB.style.top = HZ - 150 + "px"; }
    }
    // the figures' ink, from what was just painted (the fog banks' tops are set above)
    if (repaint && ink() !== false) { keys.inkSky = k.sky; keys.inkCloud = k.cloud; keys.inkLand = k.land; }
    if (k.precip !== keys.precip) { keys.precip = k.precip; setupPrecip(p); }
    if (k.glass !== keys.glass) {
      keys.glass = k.glass;
      paintGlass(p);
      for (const d of L.drops) { d.live = false; d.el.style.opacity = 0; d.wait = 0.5 + Math.random() * 3; }
      // the lightning layers exist only in a storm: hidden, they hold no GPU backing
      L.flashSky.style.display = L.flashRim.style.display = p.kind === "storm" ? "" : "none";
    }
    const fps = cadence(p);
    if ((stopLoop ? stopLoop.fps : 0) !== fps) {
      if (stopLoop) stopLoop();
      stopLoop = fps ? Kiln.loop(frame, { fps }) : null;
      if (stopLoop) stopLoop.fps = fps;
    }
    if (Kiln.reduced) frame(0, 0); // a still window: every layer placed once
    else if (!stopLoop && !Kiln.paused) drift(performance.now() / 1000); // this line moves the clouds
    if (/[?&]wxdebug/.test(location.search)) {
      // development: hide the readings so contrast can be measured on the bare scene
      document.querySelector("#C .over").style.visibility = "hidden";
      const c = L.cloudFar, d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0, s = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; s += d[i]; }
      document.title = `cloudFar ${c.width}x${c.height} css ${c.style.width} opaque ${(n / (d.length / 4)).toFixed(3)} meanA ${(s / Math.max(1, n)).toFixed(0)} tf ${c.style.transform} disp ${getComputedStyle(c).display} z ${[...root.children].indexOf(c)}/${root.children.length}`;
    }
  }

  // How often the window moves (README 8a.4). Rain, drizzle and storm fall at 30 fps and snow at
  // 20. Cloud and fog drift only as often as it takes the fastest visible layer to travel one CSS
  // pixel, at most 15 fps; and when the feed's own lines come at least that often, each line
  // moves them (update above) and no loop runs at all. 0 means no loop.
  function cadence(p) {
    if (p.precip) return p.precip === "snow" ? 20 : 30;
    const v = Math.max(Math.abs(p.cloudV) * (p.cover < 0.2 ? 0.55 : 1), p.kind === "fog" ? Math.abs(p.cloudV * 0.7 + 2) : 0);
    const need = Math.min(15, Math.ceil(v));
    return need > 1000 / Kiln.period ? need : 0;
  }

  const put = (el, tf) => { if (el._tf !== tf) { el._tf = tf; el.style.transform = tf; } };
  function frame(t, dt) {
    if (!P) return;
    drift(t);
    if (P.precip) fall(t, dt);
  }
  // clouds and fog: each strip wraps every TW, so its position is a pure function of time
  function drift(t) {
    const p = P, TW = W * 2;
    if (!p) return;
    // whole device pixels: a write is a compositing pass, and a sub-pixel step shows nothing
    const ox = (v) => Math.round((((t * v) % TW + TW) % TW - TW) * 2) / 2;
    put(L.cloudFar, `translate3d(${ox(p.cloudV * 0.55).toFixed(2)}px,0,0)`);
    put(L.cloudNear, `translate3d(${ox(p.cloudV).toFixed(2)}px,0,0)`);
    if (p.kind === "fog") {
      put(L.fogA, `translate3d(${ox(p.cloudV * 0.7 + 2).toFixed(2)}px,0,0)`);
      put(L.fogB, `translate3d(${ox(p.cloudV * 0.45 + 1).toFixed(2)}px,0,0)`);
    }
  }
  // rain, drizzle, storm and snow: the falling layers, the drops on the glass, the lightning
  let flashAt = null;
  function fall(t, dt) {
    const p = P, snow = p.precip === "snow";
    for (const [el, v, i] of [[L.pFar, p.fallV[1], 0], [L.pNear, p.fallV[0], 1]]) {
      const y = (t * v) % T, sway = snow ? Math.sin(t * (i ? 1.1 : 0.8) + i) * (i ? 10 : 6) : 0;
      el.style.transform = `rotate(${p.slant}deg) translate3d(${sway.toFixed(2)}px,${y.toFixed(2)}px,0)`;
    }
    // running drops on the glass: they wait, start slowly, run, and leave
    L.drops.forEach((d, i) => {
      if (i >= p.drops || !dt) { if (d.live) { d.live = false; d.el.style.opacity = 0; } return; }
      if (!d.live) {
        d.wait -= dt;
        if (d.wait > 0) return;
        d.live = true; d.x = 20 + Math.random() * (W - 40); d.y = Math.random() * H * 0.45; d.v = 6;
        d.el.style.opacity = 0.9;
      }
      d.v = Math.min(140, d.v + dt * (p.kind === "drizzle" ? 40 : 90));
      d.y += d.v * dt;
      d.el.style.transform = `translate3d(${d.x.toFixed(1)}px,${(d.y - 40).toFixed(1)}px,0)`;
      if (d.y > H + 8) { d.live = false; d.el.style.opacity = 0; d.wait = (p.kind === "drizzle" ? 4 : 1.5) + Math.random() * 6; }
    });
    // lightning inside the deck, with one flash on the tile's edge
    if (p.kind === "storm") {
      if (flashAt == null || t > flashAt + 1.2) flashAt = flashAt == null ? t + 2 : t + 6 + Math.random() * 10;
      const e = t - flashAt;
      const a = e < 0 || e > 0.7 ? 0 : e < 0.05 ? e / 0.05 : e < 0.14 ? 1 - (e - 0.05) / 0.09 * 0.8 : e < 0.2 ? 0.2 + (e - 0.14) / 0.06 * 0.6 : 0.8 * (1 - (e - 0.2) / 0.5);
      L.flashSky.style.opacity = a.toFixed(3);
      L.flashRim.style.opacity = (a * 0.8).toFixed(3);
      if (e < 0 && L.flashSky._x !== flashAt) { L.flashSky._x = flashAt; L.flashSky.style.transform = `translate3d(${((flashAt * 997) % 1 * 0.6 - 0.3) * W}px,0,0)`; }
    } else if (L.flashSky.style.opacity !== "0") { L.flashSky.style.opacity = 0; L.flashRim.style.opacity = 0; }
  }

  // ink: what ink() last decided per figure (ink, its 5th-percentile Lc, card or not), for dev
  window.BentoWeather = {
    update,
    get ink() { return inkInfo; },
  };
})();
