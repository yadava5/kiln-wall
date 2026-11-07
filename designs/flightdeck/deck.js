// deck.js: the Flight Deck instruments, live. Every figure is read from Kiln.state on each
// update, and "now" is state.t. The deck is built once and then updated in place: text is
// written only when its string changes (Kiln.num sets it directly below 400 ms). Needles,
// the gauge arc, core sectors, the tape and the rolling traces are small layers of their
// own: each update sets one transform and the compositor glides it (README rule 8a), so
// nothing on the page paints between lines.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const F = Kiln.fmt, CFG = window.FD_CONFIG || {}, q = new URLSearchParams(location.search);
  const PRESET = (CFG.presets || {})[q.get("preset") || CFG.preset] || {};
  const RESERVE = CFG.reservePct == null ? 10 : CFG.reservePct;
  const GB = 2 ** 30, WEEK = 7 * 86400, SVGNS = "http://www.w3.org/2000/svg";

  /* ---------------- formatting and geometry (carried over from the approved still) ---------------- */
  const pad = (n) => String(n).padStart(2, "0");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  // Intl formatters are built once: toLocaleString/toLocaleDateString with options build a
  // new one per call, and were the deck's largest script cost per line (profiled at 100 ms)
  const NF = [0, 1, 2].map((d) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmt = (n, d = 0) => NF[d].format(n);
  const si = (n) =>
    n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + "B"
    : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + "M"
    : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(Math.round(n));
  // at most three figures, so a rate always fits its slot ("999 kB/s", "9.9 MB/s", "123 MB/s")
  const rate = (b) => (b >= 9.995e8 ? (b / 1e9).toFixed(1) + " GB/s" : b >= 9.995e6 ? Math.round(b / 1e6) + " MB/s"
    : b >= 999.5e3 ? (b / 1e6).toFixed(1) + " MB/s" : Math.round(b / 1e3) + " kB/s");
  const polar = (cx, cy, r, deg) => { const a = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const arc = (cx, cy, r, a0, a1) => {
    const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const wedge = (cx, cy, ra, rb, a0, a1) => {
    const [ax, ay] = polar(cx, cy, ra, a0), [bx, by] = polar(cx, cy, rb, a0), [ex, ey] = polar(cx, cy, rb, a1), [dx, dy] = polar(cx, cy, ra, a1);
    return `M${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}A${rb} ${rb} 0 0 1 ${ex.toFixed(1)} ${ey.toFixed(1)}L${dx.toFixed(1)} ${dy.toFixed(1)}A${ra} ${ra} 0 0 0 ${ax.toFixed(1)} ${ay.toFixed(1)}Z`;
  };
  // monotone cubic: smooth without overshoot, so a zero never dips below its axis
  const mono = (p) => {
    const n = p.length, dx = [], m = [], t = [];
    if (n < 2) return "";
    for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0]; m[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
      if (h > 9) { const s = 3 / Math.sqrt(h); t[i] = s * a * m[i]; t[i + 1] = s * b * m[i]; }
    }
    let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${(p[i][0] + h).toFixed(1)} ${(p[i][1] + t[i] * h).toFixed(1)} ${(p[i + 1][0] - h).toFixed(1)} ${(p[i + 1][1] - t[i + 1] * h).toFixed(1)} ${p[i + 1][0].toFixed(1)} ${p[i + 1][1].toFixed(1)}`;
    }
    return d;
  };
  const ease = (a, w = 3) => a.map((_, i) => { const s = a.slice(Math.max(0, i - w + 1), i + 1); return s.reduce((x, y) => x + y, 0) / s.length; });
  const spark = (vals, w, h, max, pad = 1) => {
    const mx = max ?? Math.max(...vals, 1);
    return mono(vals.map((v, i) => [(i / (vals.length - 1)) * w, h - pad - (Math.min(v, mx) / mx) * (h - 2 * pad)]));
  };
  // a rolling trace in time: the newest point sits on the right edge at `now`
  const trace = (ser, now, secs, w, h, max, pad = 1) => {
    const pts = [];
    for (const p of ser) if (p.t >= now - secs - 2 && (!pts.length || p.t > pts[pts.length - 1].t)) pts.push(p);
    if (pts.length < 2) return "";
    const v = ease(pts.map((p) => p.v), 2);
    return mono(pts.map((p, i) => [w - ((now - p.t) / secs) * w, h - pad - (Math.min(v[i], max) / max) * (h - 2 * pad)]));
  };
  const T = (x, y, s, fill, body, extra = "") =>
    `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" font-size="${s}"${fill ? ` fill="${fill}"` : ""} ${extra}>${body}</text>`;
  const loc = (t) => new Date(t * 1000);
  const hhmm = (t) => { const d = loc(t); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  // F.span with every unit after the first padded to two digits ("5 m 09 s"), so a ticking
  // age or countdown keeps its length and nothing beside it moves (README rule 13)
  const span = (sec) => F.span(sec).replace(/ (\d) (d|h|m|s)\b/g, " 0$1 $2");
  const two = (sec) => span(sec).split(" ").slice(0, 4).join(" ");   // the two largest units
  const one = (sec) => span(sec).split(" ").slice(0, 2).join(" ");
  const WDF = new Intl.DateTimeFormat("en-US", { weekday: "short" }), MOF = new Intl.DateTimeFormat("en-US", { month: "short" });
  const WD = (t) => WDF.format(loc(t));
  const MO = (t) => MOF.format(loc(t));
  // Kiln.fmt.date's "Wed 11 Nov 8:00 pm", from the cached formatters
  const dateL = (t) => `${WD(t)} ${loc(t).getDate()} ${MO(t)} ${F.clock(t)}`;
  const model = (m) => { const x = /claude-([a-z]+)-(\d+)-(\d+)/.exec(m || ""); return x ? x[1][0].toUpperCase() + x[1].slice(1) + " " + x[2] + "." + x[3] : m || ""; };

  /* ---------------- writing to the page: only what changed ---------------- */
  function txt(e, s) { s = String(s); if (e.__t !== s) { e.__t = s; e.textContent = s; } }
  function rich(e, h) { if (e.__h !== h) { e.__h = h; e.innerHTML = h; } }
  function att(e, k, v) { v = String(v); const c = e.__a || (e.__a = {}); if (c[k] !== v) { c[k] = v; e.setAttribute(k, v); } }
  function vis(e, on) { if (e.__v !== on) { e.__v = on; e.style.display = on ? "" : "none"; } }
  // A live SVG figure in a fixed-width slot (README rule 13). B612's figures are tabular by
  // design (no tnum feature: every digit advances 0.65 em, none kerned), so an invisible
  // lead that pads the string to its widest form keeps the text's width constant: its
  // right edge, and anything after it, never moves. `el` is a <tspan>; `widest` a template
  // whose leading characters fill the slot ("00.0" pads "6.7" with one figure).
  function slot(el, widest, opts = {}) {
    const lead = document.createElementNS(SVGNS, "tspan"), f = opts.fmt || ((v) => String(Math.round(v)));
    lead.setAttribute("fill-opacity", "0");
    el.parentNode.insertBefore(lead, el);
    return Kiln.num(el, Object.assign({}, opts, { fmt: (v) => { const s = f(v); txt(lead, widest.slice(0, Math.max(0, widest.length - s.length))); return s; } }));
  }
  const lead = (widest, s) => (s.length < widest.length ? `<tspan fill-opacity="0">${widest.slice(0, widest.length - s.length)}</tspan>` : "") + s;

  /* ---------------- moving parts: small layers, one transform per update ---------------- */
  const MV = $("#mv"), TOP = $("#top");
  // an <svg> drawing over stage rect [x, y, w, h], in stage coordinates, inside an HTML box
  // of the same size. `at` is the stage position of its parent box; `pivot` the stage point
  // it rotates or scales about. The box is what moves: Chrome runs a transition of an <svg>
  // element's own transform on the main thread, every frame, and an HTML element's on the
  // compositor (2026-11-05: 4.5% of a core down to 2.25%). WebKit measured the same either way.
  function layer(parent, box, html, o = {}) {
    // whole points, so a layer's pixels line up with the deck's and edges render as before
    const x = Math.floor(box[0]), y = Math.floor(box[1]), w = Math.ceil(box[0] + box[2]) - x, h = Math.ceil(box[1] + box[3]) - y;
    const d = document.createElement("div"), e = document.createElementNS(SVGNS, "svg"), at = o.at || [0, 0];
    e.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    e.setAttribute("width", w); e.setAttribute("height", h);
    d.className = o.cls == null ? "mv" : o.cls;
    if (o.part) d.setAttribute("data-part", o.part);
    d.style.cssText = `left:${x - at[0]}px;top:${y - at[1]}px;width:${w}px;height:${h}px`;
    if (o.pivot) d.style.transformOrigin = `${o.pivot[0] - x}px ${o.pivot[1] - y}px`;
    e.innerHTML = html;
    d.appendChild(e);
    parent.appendChild(d);
    return d;
  }
  function div(parent, cls, css, part) {
    const d = document.createElement("div");
    d.className = cls;
    d.style.cssText = css;
    if (part) d.setAttribute("data-part", part);
    parent.appendChild(d);
    return d;
  }
  const lineBox = (x0, y0, x1, y1, p) => [Math.min(x0, x1) - p, Math.min(y0, y1) - p, Math.abs(x1 - x0) + 2 * p, Math.abs(y1 - y0) + 2 * p];
  const clipBox = (parent, [x, y, w, h], part, radius = 0) =>
    div(parent, "clip", `left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${radius}px`, part);
  // set a layer's transform; the .mv transition (var(--kiln-tween)) glides it there
  // At the 100 ms period a glide lasts 60 ms, four frames: indistinguishable from a step, yet
  // ~40 layers animating every line kept the page's animation clock running at 60 Hz without
  // a break. There, html.snap lands every transform directly and the rolls do not run.
  const SNAP = () => Kiln.tweenMs < 100;
  // The 45 s traces move 0.2-0.55 pt a line at 100 ms: there they redraw every other line
  // (5 a second), each one-line instance keeping its own count.
  const everyOther = () => { let k = 0; return () => !SNAP() || (++k & 1) === 0; };
  Kiln.onPeriod(() => document.documentElement.classList.toggle("snap", SNAP()));
  function move(e, tf) { if (e.__tf !== tf) { e.__tf = tf; e.style.transform = tf; } }
  // a rolling chart: redrawn with the new point on the right, then slid in from where the
  // previous line left it, by the compositor.
  // The box keeps the slides' running total as translateX(-x) and its drawing as +x, so each
  // line moves the box on by dx with the .roll transition, which starts where the last one
  // ended. An Element.animate re-based every line cost more in WebKit: 4.6-4.9% of a core
  // at 300 ms against 4.2-4.6% (KilnWall, 2026-11-05). Past 240 px the total re-bases to 0
  // on one line without a slide: a step of under 2 pt, once in 36 s or more.
  function roll(e, dx) {
    const still = Kiln.reduced || Kiln.paused || SNAP() || !(dx > 0.01 && dx < 400);
    const x = still || (e.__x || 0) + dx > 240 ? 0 : (e.__x || 0) + dx, tr = x ? "" : "none";
    if (e.style.transition !== tr) e.style.transition = tr;
    e.__x = x;
    e.style.transform = x ? `translateX(${(-x).toFixed(2)}px)` : "";
    e.firstElementChild.style.transform = x ? `translateX(${x.toFixed(2)}px)` : "";
  }
  // An arc that fills `span` degrees clockwise from a0, swept by rotation alone: each half is
  // a half-ring that turns out from under a fixed half-plane window (a second half past 180).
  // The second half starts LAP degrees early, under the first: two windows clipped on the
  // same line left a dark anti-aliased seam across the arc in WebKit. (Only the gauge has a
  // second half, and its stroke is opaque, so the overlap cannot show.)
  const LAP = 1;
  function sweep(parent, cx, cy, R, sw, a0, span, attrs) {
    const rho = Math.ceil(R + sw / 2 + 1), halves = [];
    for (let k = 0; k * 180 < span; k++) {
      const fr = div(parent, "", `left:${cx - rho}px;top:${cy - rho}px;width:${2 * rho}px;height:${2 * rho}px;transform:rotate(${a0 + 180 * k - (k ? LAP : 0)}deg)`);
      const win = div(fr, "clip", `left:${rho}px;width:${rho}px;height:${2 * rho}px`);
      halves.push(layer(win, [0, 0, rho, 2 * rho], `<path d="${arc(rho, rho, R, 180, 360)}" fill="none" stroke-width="${sw}" ${attrs}/>`, { at: [rho, 0], pivot: [rho, rho] }));
    }
    return { halves, th: null };
  }
  function fill(S, theta) {
    // crossing 180 would run both halves at once and open a gap: land that one directly
    const cross = S.th != null && (S.th - 180) * (theta - 180) < 0;
    S.th = theta;
    S.halves.forEach((e, k) => {
      const tr = cross ? "none" : "";
      if (e.style.transition !== tr) e.style.transition = tr;
      move(e, `rotate(${clamp(theta - 180 * k + (k ? LAP : 0), 0, 180).toFixed(2)}deg)`);
      if (k) vis(e, theta > 180);
    });
  }
  function group(html, part) {
    const g = document.createElementNS(SVGNS, "g");
    if (part) g.setAttribute("data-part", part);
    g.innerHTML = html;
    $("#ink").appendChild(g);
    return g;
  }
  const refs = (root) => { const o = {}; root.querySelectorAll("[data-r]").forEach((e) => (o[e.dataset.r] = e)); return o; };
  function duTitle(x, y, w, left, ref) {
    return T(x + 16, y + 24, 14, "var(--val)", left) + T(x + w - 16, y + 24, 12.5, "var(--lab)", "", `text-anchor="end" data-r="${ref}"`)
      + `<line x1="${x + 16}" y1="${y + 32}" x2="${x + w - 16}" y2="${y + 32}" stroke="var(--rule)"/>`;
  }

  /* geometry, in screen points. Dock covers x < 66 between y 256 and 760; the notch is x 663-848, y < 32.
     One grid (index.html): columns 72-410, 424-1088, 1102-1440. The PFD's bezel fills the centre
     column between the side panes (127-613); the three lower bezels stand on the same verticals. */
  const PANEL = 622;
  const DU = { pfd: [431, 134, 650, 472], rose: [79, 636, 324, 328], fuel: [431, 636, 650, 328], mix: [1109, 636, 324, 328] };
  // the PFD's three instruments share caption baselines: a title line at 158 over each, and two
  // lines under them at 426 and 441
  const CAP = 158, CAP1 = 426, CAP2 = 441;
  // the flight log's top in the left pane, set by engines() when the session list changes
  let logTop = 380;
  // the lower row's footers share two baselines, 14 and 29 pt above the glass's bottom edge
  const FOOT = 328 - 14, FOOT2 = FOOT - 15;

  /* ---------------- the panel: display bezels and the lower panel (static) ---------------- */
  // A contact shadow: a rectangle blurred by a Gaussian of sigma 7, drawn as nine gradient
  // pieces (solid middle, four edge ramps, four corners). The feGaussianBlur it replaces ran
  // again whenever a figure over it repainted: 2.1% of a core in WebKit's GPU process at 100 ms.
  // Ramp stops are 0.5 erfc(d / (sigma sqrt 2)) for d from -3 sigma to +3 sigma.
  const RAMP = [0.99865, 0.97725, 0.84134, 0.5, 0.15866, 0.02275, 0.00135], SIG3 = 21, shadowOps = new Set();
  function shadow(x, y, w, h, op) {
    const k = String(op).replace(".", ""), e = SIG3, st = (rev) => (rev ? RAMP.slice().reverse() : RAMP).map((a, i) => `<stop offset="${(i / 6).toFixed(3)}" stop-opacity="${(a * op).toFixed(4)}"/>`).join("");
    let d = "";
    if (!shadowOps.has(k)) {
      shadowOps.add(k);
      const lin = (id, x1, y1, x2, y2) => `<linearGradient id="${id}${k}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${st(false)}</linearGradient>`;
      const rad = (id, cx, cy) => `<radialGradient id="${id}${k}" cx="${cx}" cy="${cy}" r="1">${st(false)}</radialGradient>`;
      d = `<defs>${lin("shR", 0, 0, 1, 0)}${lin("shL", 1, 0, 0, 0)}${lin("shB", 0, 0, 0, 1)}${lin("shT", 0, 1, 0, 0)}${rad("shTL", 1, 1)}${rad("shTR", 0, 1)}${rad("shBL", 1, 0)}${rad("shBR", 0, 0)}</defs>`;
    }
    const R = (rx, ry, rw, rh, f) => `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${f}"/>`;
    const x0 = x - e, x1 = x + e, x2 = x + w - e, y0 = y - e, y1 = y + e, y2 = y + h - e, iw = w - 2 * e, ih = h - 2 * e;
    // (stop-color defaults to black)
    return d + R(x1, y1, iw, ih, `rgba(0,0,0,${op})`)
      + R(x0, y1, 2 * e, ih, `url(#shL${k})`) + R(x2, y1, 2 * e, ih, `url(#shR${k})`) + R(x1, y0, iw, 2 * e, `url(#shT${k})`) + R(x1, y2, iw, 2 * e, `url(#shB${k})`)
      + R(x0, y0, 2 * e, 2 * e, `url(#shTL${k})`) + R(x2, y0, 2 * e, 2 * e, `url(#shTR${k})`) + R(x0, y2, 2 * e, 2 * e, `url(#shBL${k})`) + R(x2, y2, 2 * e, 2 * e, `url(#shBR${k})`);
  }
  function bezel([x, y, w, h], over) {
    // one light source: the glareshield floods from above. Top lip catches it, contact shadow falls below.
    // The PFD (over) stands against the windscreen: nothing casts a shadow on the sky, and its
    // soft 21 pt shadow fell across the canopy glass beside it, so it has none.
    return `${over ? "" : shadow(x - 7, y - 3, w + 14, h + 14, 0.55)}
      <rect x="${x - 7}" y="${y - 7}" width="${w + 14}" height="${h + 14}" rx="10" fill="url(#bezelMetal)"/>
      <rect x="${x - 6.5}" y="${y - 6.5}" width="${w + 13}" height="${h + 13}" rx="9.5" fill="none" stroke="url(#bezelLip)" stroke-width="1"/>
      <rect class="du-glass${over ? " over" : ""}" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="url(#sheen)"/>
      <rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="3.5" fill="none" stroke="var(--edge)" stroke-opacity=".9"/>`;
  }
  function panel() {
    // (no scrims: nothing shades or hazes the sky, README "No veils on the sky"; the
    // windscreen's blocks stand on canopy glass, #cg in index.html, smoked by sky.js)
    let g = `<defs>
      <linearGradient id="bezelMetal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--bz0)"/><stop offset=".1" stop-color="var(--bz1)"/><stop offset="1" stop-color="var(--bz2)"/></linearGradient>
      <linearGradient id="bezelLip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--lip)" stop-opacity="var(--lipA)"/><stop offset=".06" stop-color="var(--lip)" stop-opacity=".1"/><stop offset="1" stop-color="var(--lip)" stop-opacity="0"/></linearGradient>
      <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--sheen)" stop-opacity="var(--sheenA)"/><stop offset=".35" stop-color="var(--sheen)" stop-opacity="0"/></linearGradient>
      <linearGradient id="deck" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--pn0)"/><stop offset=".05" stop-color="var(--pn1)"/><stop offset="1" stop-color="var(--pn2)"/></linearGradient>
      <pattern id="grain" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="#fff" opacity=".018"/></pattern>
    </defs>`;
    // lower panel: the nearest surface, with a lit top lip. Its edge is crisp: the 10 pt shade
    // that once faded up onto the sky was a veil (README, "No veils on the sky").
    g += `<rect x="0" y="${PANEL}" width="1512" height="${982 - PANEL}" fill="url(#deck)"/>
      <rect x="0" y="${PANEL}" width="1512" height="${982 - PANEL}" fill="url(#grain)"/>
      <line x1="0" y1="${PANEL + 0.5}" x2="1512" y2="${PANEL + 0.5}" stroke="var(--edgeLit)" stroke-opacity="var(--edgeLitA)"/>`;
    g += bezel(DU.pfd, true);
    for (const k of ["rose", "fuel", "mix"]) g += bezel(DU[k], false);
    $("#panel").innerHTML = g;
  }

  /* ---------------- top row: clock, weather and the derived METAR line ---------------- */
  function clock() {
    const hm = $("#hm"), ss = $("#ss"), dt = $("#dt"), lz = $("#lz");
    return (s) => {
      const d = loc(s.t), w = window.FDSky.weather(s);
      txt(hm, pad(d.getHours()) + ":" + pad(d.getMinutes()));
      txt(ss, pad(d.getSeconds()));
      txt(dt, `${WD(s.t)} ${d.getDate()} ${MO(s.t)} ${d.getFullYear()}`);
      txt(lz, `${w && w.place ? w.place.split(",")[0] + " local" : "Local"}, ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`);
    };
  }
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  // (the METAR-style line is gone, 2026-11-05 15:38: "KXYZ 052015Z 24010KT FEW/// 17/10" is an
  // aviation code most people cannot read, and everything on this page has to be readable)
  function wxText() {
    // (the place is the clock's "<place> local": the weather block names only the weather)
    const c = $("#wc"), wd = $("#ww"), u = $("#wu"), temp = Kiln.num($("#wt"));
    let unit = null;
    return (s) => {
      const w = window.FDSky.weather(s);
      // the unit is the user's (Kiln.tempUnit); a change of unit lands at once, never glides 62 -> 17
      if (unit !== Kiln.tempUnit) { unit = Kiln.tempUnit; txt(u, unit); temp.set(null); }
      if (!w) { txt(c, "Weather offline"); txt(wd, "the feed carries no weather"); temp.set(null); return; }
      const tx = w.text || w.kind || "";
      txt(c,`${tx.charAt(0).toUpperCase() + tx.slice(1)}, ${w.is_day ? "day" : "night"}, ${Math.round(w.humidity)}% humid`);
      // the wind in the user's unit system: Kiln.fmt.wind once the runtime has it (mph with F,
      // km/h with C); the same rule here until then
      const kmh = w.wind_kmh || 0, spd = F.wind ? F.wind(kmh) : Kiln.tempUnit === "C" ? `${Math.round(kmh)} km/h` : `${Math.round(kmh / 1.609)} mph`;
      txt(wd, kmh >= 0.5 ? `Wind ${COMPASS[Math.round((w.wind_dir || 0) / 22.5) % 16]} ${spd}` : "Wind calm");
      temp.set(F.tempValue(w.temp_c));
    };
  }

  /* ---------------- annunciators, and the update-period lamp (btop's corner readout) ---------------- */
  function lamps() {
    // The lamps are set in the glareshield between the clock and the weather, centred on the
    // PFD's axis (756), vertically centred in the pane (40-113). 5-HOUR exists only while the
    // feed carries a live five-hour window: Anthropic removed that limit for this account on
    // 2026-10-30, so it is normally absent and the row centres without it. If it ever returns
    // the row re-centres once; a lamp appearing is a change of state, not a figure moving.
    const defs = [["need", "NEEDS YOU", 128], ["gp", "GEN PURPOSE", 128], ["mem", "MEM PRESSURE", 128], ["fc", "FORECAST", 148], ["five", "5-HOUR", 112], ["upd", "UPDATE", 76]];
    const y = 61, CX = 756, GAP = 8, UW = 76;
    const place = (withFive) => {
      const on = defs.filter(([k]) => k !== "five" || withFive), w = sum(on.map((d) => d[2])) + GAP * (on.length - 1), o = {};
      let x = CX - w / 2;
      for (const [k, , lw] of on) { o[k] = x; x += lw + GAP; }
      return o;
    };
    const P0 = place(false);
    let h = "";
    for (const [k, leg, w] of defs) {
      const up = k === "upd", cx = up ? w / 2 - 6 : w / 2;
      h += `<g class="lamp${up ? " upd" : ""}" data-r="${k}" transform="translate(${P0[k] || 0} 0)"${k === "five" ? ' style="display:none"' : ""}>
        <rect class="lb" x="0" y="${y}" width="${w}" height="30" rx="4"/>
        <rect class="lg" x="1" y="${y + 1}" width="${w - 2}" height="12" rx="3"/>
        ${T(cx, y + 12.5, 11, "", leg, 'class="ll" text-anchor="middle" letter-spacing="1.3"')}
        ${T(cx, y + 25.5, 12, "", "", `class="lv" data-r="${k}V" text-anchor="middle"`)}
      </g>`;
    }
    // UPDATE: the live dot beats and the period highlight covers it, so both are layers of
    // their own (the dot in #mv, the highlight above it in #top)
    const ux = P0.upd, ucx = ux + UW / 2 - 6;
    const dot = div(MV, "pulse", `left:${ux + UW - 12}px;top:${y + 15}px`);
    const hl = layer(TOP, [ux - 1, y - 1, UW + 2, 32], `<rect x="${ux}" y="${y}" width="${UW}" height="30" rx="4" fill="#0D2A33" stroke="var(--cyn)"/>
      ${T(ucx, y + 12.5, 11, "var(--cyn)", "UPDATE", 'text-anchor="middle" letter-spacing="1.3"')}
      ${T(ucx, y + 25.5, 12, "var(--val)", "", 'data-r="hlV" text-anchor="middle"')}
      <circle cx="${ux + UW - 12}" cy="${y + 15}" r="3.2" fill="var(--cyn)"/>`, { cls: "" });
    hl.style.opacity = 0;
    // the lamps sit on the windscreen's glass, so they take its inks (.sk, index.html)
    const lg = group(h);
    lg.setAttribute("class", "sk");
    const r = Object.assign(refs(lg), refs(hl), { dot, hl });
    let five = false;
    function arrange(withFive) {
      const P = place(withFive);
      for (const [k] of defs) if (P[k] != null) att(r[k], "transform", `translate(${P[k]} 0)`);
      vis(r.five, withFive);
      dot.style.left = P.upd + UW - 12 + "px";
      hl.style.left = P.upd - 1 + "px";
    }
    function lamp(k, val, lit) {
      txt(r[k + "V"], val);
      const c = "lamp" + (k === "upd" ? " upd" : "") + (lit ? " " + lit : "");
      if (r[k].__c === c) return;
      const was = r[k].__c;
      r[k].__c = c;
      r[k].setAttribute("class", c);
      // a lamp lights with one 1.2 s pulse and then holds; nothing blinks forever
      if (lit && was !== undefined && !Kiln.reduced) r[k].querySelector(".lg").animate([{ opacity: 0.5 }, { opacity: 0.08 }], { duration: 1200, easing: "ease-out" });
    }
    // the user changed the period: the lamp lights cyan for 1.5 s. The period the host sets on
    // load is not a change, so nothing lights before the first line.
    let live = false;
    Kiln.onPeriod((ms) => {
      txt(r.updV, ms + " ms"); txt(r.hlV, ms + " ms");
      if (live) r.hl.animate([{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1500 });
    });
    // the live dot (rule 6): a soft rise and fall, opacity only, at most about once a second
    // whatever the period. It rests at .5; html.kiln-stale greys it when lines stop.
    Kiln.onBeat(() => {
      if (!Kiln.reduced) r.dot.animate([{ opacity: 0.5 }, { opacity: 1 }, { opacity: 0.5 }], { duration: 600, easing: "ease-in-out" });
    });
    return (s) => {
      live = true;
      const C = s.claude || {}, S = C.sessions || [], A = s.analytics, t = s.t;
      const need = S.filter((x) => x.state === "waiting" || x.ask);
      if (!need.length) lamp("need", "nothing waiting", "");
      else {
        const old = Math.min(...need.map((x) => x.since || t));
        lamp("need", need.length === 1 ? "waiting " + two(t - old) : `${need.length} waiting, ${one(t - old)}`, "amb");
      }
      if (A && A.general_purpose && A.spawns) {
        const g = A.general_purpose.today || 0;
        lamp("gp", `${g} of ${sum(Object.values(A.spawns.today || {}))} today`, g ? "amb" : "");
      } else lamp("gp", "analytics pending", "");
      const pr = s.sys && s.sys.mem && s.sys.mem.pressure;
      lamp("mem", pr || "–", pr === "warn" ? "amb" : pr === "critical" ? "red" : "");
      const lim = C.limits || {}, L = lim.seven_day;
      if (!L || !L.resets_at) lamp("fc", "no limit data", "");
      else if (L.projected == null) {
        const at = L.resets_at - WEEK + 12 * 3600;
        lamp("fc", at > t ? `from ${WD(at)} ${F.clock(at)}` : "pace pending", "");
      } else if (L.runout_at && L.runout_at < L.resets_at) lamp("fc", `runs out ${WD(L.runout_at)} ${hhmm(L.runout_at)}`, "red");
      else lamp("fc", `lands at ${Math.round(L.projected)}%`, L.projected >= 100 - RESERVE ? "amb" : "");
      // 5-HOUR only while it is live: a stale or null window is no lamp at all, not a lamp of nothing
      const f5 = lim.five_hour, liveFive = !!(f5 && !f5.stale && f5.pct != null);
      if (liveFive !== five) { five = liveFive; arrange(five); }
      if (liveFive) lamp("five", `${Math.round(f5.pct)}%` + (f5.resets_at ? ", in " + two(f5.resets_at - t) : ""), f5.pct >= 95 ? "red" : f5.pct >= 80 ? "amb" : "");
      txt(r.updV, Kiln.period + " ms");
      txt(r.hlV, Kiln.period + " ms");
    };
  }

  /* ---------------- left: sessions as engine strips ---------------- */
  function engines() {
    const box = $("#engines"), head = $("#sessCount"), rows = new Map(), log = $("#log");
    // the sessions take at most two plain strips and a fold line; the flight log has the rest
    // of the pane (flightLog reads logTop)
    const AVAIL = 212, BASE = 92, POD = 21, FOLD = 20, a0 = 220, a1 = 500;
    const col = { working: "var(--grn)", background: "var(--cyn)", idle: "var(--idle)", waiting: "var(--amb)", failed: "var(--red)" };
    const rank = { waiting: 0, failed: 1, working: 2, background: 3, idle: 4 };
    // How to count sessions (README): the head counts interactive sessions (open in a
    // terminal); kind "bg" (hosted by the daemon, no window) is counted apart, on the fold
    // line, with its real state. A missing kind is interactive. Idle is never "running".
    const isBg = (x) => x.kind === "bg";
    const BG_WORD = { waiting: "waiting", failed: "failed", working: "working", background: "with agents running", idle: "idle" };
    const bgNote = (bg) => {
      if (!bg.length) return "";
      const c = {};
      bg.forEach((x) => { const k = BG_WORD[x.state] ? x.state : "idle"; c[k] = (c[k] || 0) + 1; });
      const ks = Object.keys(rank).filter((k) => c[k]);
      return ks.length === 1 ? `${bg.length} in the background, ${BG_WORD[ks[0]]}`
        : `${bg.length} in the background: ${ks.map((k) => `${c[k]} ${BG_WORD[k]}`).join(", ")}`;
    };
    const fold = document.createElement("div");
    fold.className = "fold";
    box.appendChild(fold);
    let ticks = "";
    for (let i = 0; i <= 10; i++) {
      const g = a0 + (i / 10) * (a1 - a0), [x0, y0] = polar(35, 35, 28, g), [x1, y1] = polar(35, 35, i % 5 ? 25 : 22, g);
      ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="var(--tick)"/>`;
    }
    function make(sid) {
      const el = document.createElement("div");
      el.className = "eng";
      el.innerHTML = `<svg viewBox="0 0 70 70" width="70" height="70">
          <path d="${arc(35, 35, 32, a0, a1)}" fill="none" stroke="var(--hl)" stroke-opacity=".16" stroke-width="3" stroke-linecap="round"/>
          <path data-r="ring" d="${arc(35, 35, 32, a0, a1)}" pathLength="100" fill="none" stroke-width="3.5" stroke-linecap="round"/>${ticks}
          <text x="35" y="38" text-anchor="middle" font-size="17" font-weight="700" fill="var(--val)"><tspan data-r="pct"></tspan><tspan font-size="11" fill="var(--lab)" font-weight="400">%</tspan></text>
          <text data-r="ctx" x="35" y="51" text-anchor="middle" font-size="11" fill="var(--lab)"></text>
          <text data-r="win" x="35" y="69" text-anchor="middle" font-size="11" fill="var(--lab)"></text>
        </svg>
        <div style="min-width:0">
          <div class="name" data-r="name"></div>
          <div class="figs"><div><span data-r="lm"></span><i>last min</i></div><div><span data-r="q15"></span><i>last 15 min</i></div><div><span data-r="ag"></span><i data-r="agl"></i></div></div>
          <div class="clip" style="position:relative;margin-top:2px;height:16px"><div class="roll" data-r="sg"><svg viewBox="0 0 234 16" width="100%" height="16" preserveAspectRatio="none"><path data-r="sp" fill="none" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg></div></div>
          <div class="foot"><span class="state" data-r="st"></span><span class="bgk" data-r="bg">BG</span><span class="meta" data-r="meta"></span></div>
        </div>
        <div data-r="pods" style="display:contents"></div>`;
      const r = refs(el);
      return { el, r, sid, min: null, sig: "", pods: null, tr: "",
        pct: Kiln.num(r.pct), lm: Kiln.num(r.lm, { fmt: (v) => fmt(Math.round(v)) }), q15: Kiln.num(r.q15, { fmt: si }) };
    }
    function paint(o, x, pods, t, minute) {
      const st = x.state || "idle", c = col[st] || col.idle, r = o.r;
      txt(r.name, x.name || x.sid.slice(0, 8));
      if (r.bg._bg !== isBg(x)) { r.bg._bg = isBg(x); r.bg.style.display = r.bg._bg ? "" : "none"; }
      // the context ring is a dash on the full arc, set once per update (it creeps; no glide)
      att(r.ring, "stroke-dasharray", `${Math.max(x.ctx_pct || 0, 0.5).toFixed(1)} 200`);
      att(r.ring, "stroke", c);
      o.pct.set(Math.round(x.ctx_pct || 0));
      txt(r.ctx, si(x.ctx_tokens || 0));
      const win = x.ctx_window || 0;
      txt(r.win, "of " + (win && win % 1e6 === 0 ? win / 1e6 + "M" : si(win)));
      // the last bin is the minute in progress; "last min" is the last full one
      const opm = x.out_per_min || [], full = opm.slice(0, -1);
      o.lm.set(full.length ? full[full.length - 1] : null);
      o.q15.set(x.out_15m);
      txt(r.ag, x.agents_running || 0);
      txt(r.agl, x.agents_running === 1 ? "agent" : "agents");
      const sig = full.join(",");
      if (sig !== o.sig) {
        o.sig = sig;
        att(r.sp, "d", full.length > 1 ? spark(ease(full, 2), 234, 16, 30000, 1.5) : "");
        // the spark box is 234 px wide (the strip's 314 less the 70 px ring and the 10 px gap)
        if (o.min != null && minute !== o.min) roll(r.sg, 234 / Math.max(1, full.length - 1));
        o.min = minute;
      }
      att(r.sp, "stroke", c);
      att(r.sp, "opacity", st === "idle" ? 0.45 : 0.95);
      txt(r.st, st.toUpperCase());
      if (r.st.className !== "state st-" + st) r.st.className = "state st-" + st;
      // the meta line fills a fixed box right of the badge, so it needs no padding (and
      // "up 22 h 06 m" no longer fit beside "since 17:53, Fable 5.1")
      const since = x.since || t, md = model(x.model), up = F.span(x.up_s || 0).split(" ").slice(0, 4).join(" ");
      txt(r.meta, st === "idle" ? `since ${hhmm(since)}, ${md}, up ${up}`
        : st === "waiting" ? `waiting ${two(t - since)}, ${md}`
        : st === "failed" ? `failed ${hhmm(since)}, ${md}`
        : `${md}, up ${up}`);
      // running agents hang off their session as pods
      const pk = pods.map((a) => a.id).join("|");
      if (pk !== o.pods) {
        o.pods = pk;
        r.pods.innerHTML = pods.map((a) => `<div class="pod"><span class="ty${a.type === "general-purpose" ? " gp" : ""}"></span><span class="ag"><span></span><i></i></span></div>`).join("");
      }
      // agents_running carries started (epoch s), age_s and idle_s; age runs off state.t
      [...r.pods.children].forEach((el, i) => {
        const a = pods[i], age = a.started ? t - a.started : a.age_s;
        txt(el.children[0], a.type || "agent");
        txt(el.children[1].children[0], age == null ? "out –" : "out " + two(Math.max(0, age)));
        txt(el.children[1].children[1], a.idle_s > 600 ? `, quiet ${one(a.idle_s)}` : "");
      });
    }
    let ready = false;   // the first population appears as is; only later arrivals fade in
    return (s) => {
      const C = s.claude || {}, S = C.sessions || [], A = C.agents_running || [], t = s.t, minute = Math.floor(t / 60);
      const open = S.filter((x) => !isBg(x)), back = bgNote(S.filter(isBg));
      txt(head, `${open.length} open, ${A.length} agent${A.length === 1 ? "" : "s"} out`);
      const podsOf = (x) => A.filter((a) => a.sid === x.sid);
      const h = (x) => BASE + POD * podsOf(x).length;
      // keep as many strips as fit: interactive first, then background, the ones that need eyes
      // first within each; the rest fold into one line, which also carries the background count
      const pri = S.slice().sort((a, b) => isBg(a) - isBg(b) || (rank[a.state] ?? 5) - (rank[b.state] ?? 5) || (b.last_activity || 0) - (a.last_activity || 0));
      const keep = new Set();
      let used = 0;
      for (const x of pri) {
        const after = S.length - keep.size - 1;
        if (used + h(x) + (after > 0 || back ? FOLD : 0) > AVAIL) break;
        keep.add(x.sid);
        used += h(x);
      }
      const byKind = open.concat(S.filter(isBg));
      const list = byKind.filter((x) => keep.has(x.sid)), hidden = byKind.filter((x) => !keep.has(x.sid));
      let y = 0;
      list.forEach((x, i) => {
        let o = rows.get(x.sid), fresh = false;
        if (!o) { o = make(x.sid); rows.set(x.sid, o); fresh = true; }
        paint(o, x, podsOf(x), t, minute);
        const tr = `translateY(${y}px)`;
        if (o.tr !== tr) { o.tr = tr; o.el.style.transform = tr; }
        if (o.h !== h(x)) { o.h = h(x); o.el.style.height = o.h + "px"; }
        o.el.classList.toggle("last", i === list.length - 1 && !hidden.length);
        if (fresh) { box.appendChild(o.el); if (ready && !Kiln.reduced) o.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); }
        y += h(x);
      });
      ready = true;
      for (const [sid, o] of rows) {
        if (keep.has(sid)) continue;
        rows.delete(sid);
        if (Kiln.reduced) o.el.remove();
        else o.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250 }).onfinish = () => o.el.remove();
      }
      vis(fold, hidden.length > 0 || !!back);
      if (hidden.length || back) {
        txt(fold, [back && (open.length ? "+" : "") + back,
          hidden.length && `+${hidden.length} more: ` + hidden.map((x) => `${x.name} (${isBg(x) ? "bg, " : ""}${x.state || "idle"})`).join(", ")]
          .filter(Boolean).join("; "));
        fold.style.transform = `translateY(${y + 4}px)`;
      }
      // the flight log starts under the list (#engines starts at 164, the log's heading 12 pt
      // under the last line). It glides with the rows, and changes only when they do.
      const lt = 164 + y + (hidden.length || back ? FOLD : 0) + 12;
      if (lt !== logTop) { logTop = lt; log.style.top = lt + "px"; }
    };
  }

  /* ---------------- the weekly limit's history ---------------- */
  // The feed's limits.week_points holds every recorded reading of the current week, in order;
  // a first [t, pct, "prev"] entry is the previous week's last reading. Recording began
  // 2026-11-04 18:27, so earlier weeks are unknown. Recorded readings only; a gap stays a gap.
  const limitHistory = (() => {
    let memo = null, memoT = null;
    return (s) => {
      if (memoT === s.t) return memo;
      memoT = s.t;
      const lim = s.claude && s.claude.limits, L = lim && lim.seven_day;
      if (!L || !L.resets_at || L.pct == null) return (memo = null);
      const ws = L.resets_at - WEEK, wp = lim.week_points || [], prev = wp.find((p) => p[2] === "prev");
      const week = wp.filter((p) => p[2] !== "prev" && p[0] >= ws && p[0] <= s.t).map((p) => [p[0], p[1]]);
      return (memo = { L, ws, week, lastWeek: prev ? prev[1] : null });
    };
  })();

  /* ---------------- centre DU: the primary flight display ---------------- */
  // The weekly limit: the primary instrument, at the PFD's centre. A 270° dial read like a
  // mechanical gauge: a hairline rim at R with the graduations inside it (every 2%, longer at
  // 10 and 20, numerals outside at 20), a tapered needle on a hub, and the figure in the dial's
  // open quarter under the hub, where the needle never goes. A thin fill arc inside the
  // graduations shows the proportion at a glance; the reserve is an amber band on the rim with
  // a red mark at 100. Last week's close rides the rim as a hollow bug.
  function gauge() {
    const [X, Yt, W] = DU.pfd, cx = X + W / 2, cy = Yt + 150, R = 92, RF = R - 25, a0 = 225, a1 = 495, ang = (p) => a0 + (clamp(p, 0, 100) / 100) * (a1 - a0);
    const memMode = PRESET.gauge === "memory";
    let h = T(cx, CAP, 12, "var(--lab)", memMode ? "Memory used" : "Weekly limit used", 'text-anchor="middle"')
      + `<path d="${arc(cx, cy, R, a0, a1)}" fill="none" stroke="var(--lab)" stroke-opacity=".6" stroke-width="1"/>
      <path d="${arc(cx, cy, RF, a0, a1)}" fill="none" stroke="var(--hl)" stroke-opacity=".14" stroke-width="4"/>
      <path d="${arc(cx, cy, R + 4, ang(100 - RESERVE), ang(100))}" fill="none" stroke="var(--amb)" stroke-width="3" opacity=".9"/>`;
    const tick = (r0, r1, deg, col, w, op = 1) => { const [x0, y0] = polar(cx, cy, r0, deg), [x1, y1] = polar(cx, cy, r1, deg); return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${col}" stroke-width="${w}" stroke-opacity="${op}"/>`; };
    for (let p = 0; p <= 100; p += 2) {
      const major = p % 20 === 0, mid = p % 10 === 0;
      h += tick(R - 1, R - (major ? 14 : mid ? 9 : 5), ang(p), major ? "var(--val)" : "var(--lab)", major ? 1.6 : mid ? 1.2 : 1, major ? 1 : mid ? 0.9 : 0.55);
      if (major) { const [tx, ty] = polar(cx, cy, R + 17, ang(p)); h += T(tx, ty + 4, 12, "var(--lab)", p, 'text-anchor="middle"'); }
    }
    h += tick(R - 9, R + 5, ang(100), "var(--red)", 2)   // the redline crosses the rim at 100, short of the numeral
      // the figure in the open quarter: 50 pt, so its top corners stay clear of the needle at 0
      // and 100 (the dial's gap is ±45° about down; the corners sit at ±41°)
      + T(cx - 7, cy + 72, 50, "var(--val)", `<tspan data-r="big"></tspan><tspan font-size="20" font-weight="400" fill="var(--lab)" dx="2">%</tspan>`, 'text-anchor="middle" font-weight="700" letter-spacing="-1"')
      + T(cx, cy + 102, 12, "var(--lab)", "", 'text-anchor="middle" data-r="rs"')
      + T(cx, cy + 124, 20, "var(--cyn)", "", 'text-anchor="middle" data-r="cd"')
      + T(cx, CAP1 + 15, 12, "var(--lab)", "", 'text-anchor="middle" data-r="bn"');
    const r = refs(group(h));
    // moving: the fill arc, last week's bug and the needle (drawn pointing up, rotated to the
    // reading). The hub turns with the needle; it is round, so that never shows.
    const S = sweep(MV, cx, cy, RF, 4, a0, a1 - a0, 'stroke="var(--grn)"');
    r.lw = layer(MV, [cx - 6, cy - R - 12, 12, 12], `<path d="M${cx - 4} ${cy - R - 10}L${cx + 4} ${cy - R - 10}L${cx} ${cy - R - 2}Z" fill="var(--halo)" stroke="var(--val)" stroke-width="1.2" stroke-linejoin="round"/>`, { pivot: [cx, cy] });
    r.nd = layer(MV, [cx - 10, cy - R + 2, 20, R + 18], `<defs><radialGradient id="hub" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#5A6270"/><stop offset=".6" stop-color="#1C2026"/><stop offset="1" stop-color="#0A0C10"/></radialGradient></defs>
      <path d="M${cx - 3.4} ${cy - 10}L${cx} ${cy - R + 4}L${cx + 3.4} ${cy - 10}L${cx + 2.6} ${cy + 18}L${cx - 2.6} ${cy + 18}Z" fill="var(--val)" stroke="var(--edge)" stroke-width=".6" stroke-opacity=".7" stroke-linejoin="round"/>
      <circle cx="${cx}" cy="${cy}" r="8" fill="url(#hub)" stroke="var(--lip)" stroke-opacity=".5"/><circle cx="${cx}" cy="${cy}" r="2.2" fill="var(--val)"/>`, { pivot: [cx, cy] });
    const big = Kiln.num(r.big);
    if (memMode) document.body.classList.add("g-memory");
    const needle = (v) => {
      fill(S, Math.max(ang(v), a0 + 0.4) - a0);
      move(r.nd, `rotate(${ang(v).toFixed(2)}deg)`);
    };
    return (s) => {
      const t = s.t;
      if (memMode) {
        const M = s.sys && s.sys.mem;
        if (!M) return;
        const p = (M.used / M.total) * 100;
        needle(p);
        big.set(Math.round(p));
        vis(r.lw, false);
        txt(r.rs, `${(M.used / GB).toFixed(1)} of ${Math.round(M.total / GB)} GB in use`);
        txt(r.cd, `kernel pressure ${M.pressure}`);
        att(r.cd, "fill", M.pressure === "critical" ? "var(--red)" : M.pressure === "warn" ? "var(--amb)" : "var(--grn)");
        rich(r.bn, `compressed <tspan fill="var(--val)">${(M.compressed / GB).toFixed(1)} GB</tspan>, swap <tspan fill="var(--val)">${((s.sys.swap || 0) / GB).toFixed(2)} GB</tspan>`);
        return;
      }
      const lh = limitHistory(s);
      if (!lh) { big.set(null); txt(r.rs, "no limit data in the feed"); txt(r.cd, ""); txt(r.bn, ""); return; }
      const L = lh.L, left = L.resets_at - t;
      needle(L.pct);
      big.set(L.pct);
      vis(r.lw, lh.lastWeek != null);
      if (lh.lastWeek != null) move(r.lw, `rotate(${ang(lh.lastWeek).toFixed(2)}deg)`);
      txt(r.rs, `resets ${dateL(L.resets_at)}`);
      // the countdown carries its seconds, small, so it visibly runs
      rich(r.cd, `in ${span(left)}` + (left >= 3600 ? `<tspan font-size="13" fill="var(--lab)" dx="6">${pad(Math.floor(left % 60))} s</tspan>` : ""));
      const bits = [];
      if (L.burn_per_h != null) bits.push(`burn <tspan fill="var(--val)">${L.burn_per_h.toFixed(1)} %/h</tspan>`);
      if (lh.lastWeek != null) bits.push(`last week closed <tspan fill="var(--val)">${lh.lastWeek}%</tspan>`);
      rich(r.bn, bits.join(", "));
    };
  }

  // PFD speed tape: total output, tokens per minute, scrolling under a fixed readout
  // PFD speed tape, on the left as an airspeed tape is: tokens per minute scrolling under a
  // fixed readout. The scale's graduations hang off the well's right wall (ticks every 2.5k,
  // longer with a numeral every 10k), the trend bar runs up the left wall, and the readout is
  // a pointer box over the reference line.
  function tape() {
    const [X, Yt] = DU.pfd, AX = X + 111, tw = 66, tx0 = AX - tw / 2, ty0 = Yt + 36, th = 232, scale = th / 34000, midY = ty0 + th / 2;
    let sc = "";
    for (let v = 0; v <= 200000; v += 2500) {
      const y = -v * scale, major = v % 10000 === 0;
      sc += `<line x1="${tx0 + tw - (major ? 12 : 6)}" y1="${y.toFixed(1)}" x2="${tx0 + tw}" y2="${y.toFixed(1)}" stroke="var(--lab)" stroke-opacity="${major ? 0.9 : 0.5}" stroke-width="${major ? 1.3 : 1}"/>`;
      if (major) sc += T(tx0 + tw - 17, y + 4, 12, "var(--lab)", v ? v / 1000 + "k" : "0", 'text-anchor="end"');
    }
    const h = `<rect x="${tx0}" y="${ty0}" width="${tw}" height="${th}" rx="3" fill="var(--tape)" stroke="var(--hl)" stroke-opacity=".3"/>
      <line x1="${tx0 + tw - 0.5}" y1="${ty0 + 3}" x2="${tx0 + tw - 0.5}" y2="${ty0 + th - 3}" stroke="var(--lab)" stroke-opacity=".6"/>`
      + T(AX, CAP, 12, "var(--lab)", "Output tokens per min", 'text-anchor="middle"')
      + T(AX, CAP1, 12, "var(--lab)", `<tspan fill="var(--mag)" data-r="tv"></tspan> in 5 min`, 'text-anchor="middle"')
      + `<path d="M${AX - 44} ${CAP2 - 8.5}l6 4.5l-6 4.5Z" fill="none" stroke="var(--val)" stroke-width="1.1"/>`
      + T(AX - 34, CAP2, 12, "var(--lab)", `this min <tspan fill="var(--val)" data-r="cm"></tspan>`);
    const r = refs(group(h, "tape"));
    // inside the tape's rounded window: the scale, the trend bar and the bug, each a layer
    const win = clipBox(MV, [tx0, ty0, tw, th], "tape", 3), at = [tx0, ty0];
    r.sc = layer(win, [tx0, -200000 * scale - 10, tw, 200000 * scale + 20], sc, { at });
    r.tr = layer(win, [tx0 + 3, midY - 100, 4, 100], `<line x1="${tx0 + 5}" y1="${midY - 100}" x2="${tx0 + 5}" y2="${midY}" stroke="var(--mag)" stroke-width="3"/>`, { at, pivot: [tx0 + 5, midY] });
    move(r.tr, "scaleY(0)");
    r.bug = layer(win, [tx0 + 10, -8, 11, 16], `<path d="M${tx0 + 11} -6l8 6l-8 6Z" fill="none" stroke="var(--val)" stroke-width="1.3" opacity=".85"/>`, { at });
    // over them: the well's inner shade at both ends, and the readout box
    Object.assign(r, refs(layer(TOP, [tx0 - 14, ty0, tw + 26, th], `<defs><linearGradient id="tapeFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--tape)" stop-opacity=".97"/><stop offset=".2" stop-color="var(--tape)" stop-opacity="0"/><stop offset=".8" stop-color="var(--tape)" stop-opacity="0"/><stop offset="1" stop-color="var(--tape)" stop-opacity=".97"/></linearGradient></defs>
      <rect x="${tx0}" y="${ty0}" width="${tw}" height="${th}" rx="3" fill="url(#tapeFade)"/>
      <path d="M${tx0 - 12} ${midY - 15}H${tx0 + tw - 2}l11 15l-11 15H${tx0 - 12}Z" fill="var(--box)" stroke="var(--val)" stroke-width="1.4" stroke-linejoin="round"/>`
      + T(tx0 + tw / 2 - 6, midY + 7, 19, "var(--val)", `<tspan data-r="rd"></tspan>`, 'text-anchor="middle" font-weight="700"'), { cls: "", part: "tape" })));
    // the readout right-aligns in a slot for "00,000", as a speed tape's drum does
    const rd = slot(r.rd, "00,000", { fmt: (v) => (v >= 1e5 ? si(v) : fmt(Math.round(v))) });
    // the trend always in thousands with one decimal, so its slot holds every value to ±99.9k
    const tv = slot(r.tv, "+00.0k", { fmt: (v) => (v >= 0 ? "+" : "−") + (Math.abs(v) / 1000).toFixed(1) + "k" });
    const cm = Kiln.num(r.cm, { fmt: (v) => fmt(Math.round(v)) });
    return (s) => {
      const S = (s.claude && s.claude.tokens && s.claude.tokens.out_per_min) || [];
      if (S.length < 2) return;
      // the tape reads the last full minute; the minute in progress rides on it as a hollow bug
      const full = S.slice(0, -1), now = full[full.length - 1], cur = S[S.length - 1];
      const trend = full.length > 5 ? now - full[full.length - 6] : 0;
      // translations land on device pixels (half points), so the tape's text rests crisp
      const dp = (v) => (Math.round(v * 2) / 2).toFixed(1);
      move(r.sc, `translateY(${dp(midY + now * scale)}px)`);
      move(r.tr, `scaleY(${((trend * scale) / 100).toFixed(4)})`);
      move(r.bug, `translateY(${dp(midY - (cur - now) * scale)}px)`);
      rd.set(now); tv.set(trend); cm.set(cur);
    };
  }

  // CPU: one sector per core, radial fill on an honest 0-100 scale, and a 45 s trace
  // CPU, on the right where an altitude tape would be: a ring of one radial sector per core,
  // each filling outward from r0 on an honest 0-100 scale, inside a graduated rim whose marks
  // are the core boundaries. The overall figure sits in the ring with a 45 s trace under it;
  // the per-core numerals that once ringed it are gone (ten figures that said what the
  // sectors already show).
  function cpu() {
    const [X, Yt] = DU.pfd, qx = X + 544, qy = Yt + 150, r0 = 64, r1 = 84, RR = r1 + 6, SECS = 45, traceDue = everyOther();
    Kiln.track("cpu", (s) => s.sys && s.sys.cpu, SECS + 5);
    // the readout's slot holds "00.0"; it sits 6 pt left so one- and two-figure readings
    // straddle the centre equally
    const h = T(qx, CAP, 12, "var(--lab)", "", 'text-anchor="middle" data-r="ttl"')
      + `<circle cx="${qx}" cy="${qy}" r="${RR}" fill="none" stroke="var(--lab)" stroke-opacity=".5"/><g data-r="cores"></g>`
      + T(qx - 6, qy + 12, 36, "var(--val)", `<tspan data-r="pc"></tspan><tspan font-size="15" font-weight="400" fill="var(--lab)">%</tspan>`, 'text-anchor="middle" font-weight="700"')
      + T(qx, CAP1, 12, "var(--lab)", `user <tspan fill="var(--val)" data-r="us"></tspan>, sys <tspan fill="var(--val)" data-r="sy"></tspan>`, 'text-anchor="middle"')
      + T(qx, CAP2, 12, "var(--lab)", "", 'text-anchor="middle" data-r="ld"');
    const r = refs(group(h, "cpu"));
    // the trace rolls in its own clipped layer, inside the ring under the figure
    const TW = 80, TY = qy + 20;
    r.tg = layer(clipBox(MV, [qx - TW / 2, TY, TW, 22], "cpu"), [qx - TW / 2, TY, TW, 22],
      `<path data-r="tp" transform="translate(${qx - TW / 2} ${TY + 2})" fill="none" stroke="var(--cyn)" stroke-width="1.4"/>`, { cls: "roll", at: [qx - TW / 2, TY] });
    r.tp = r.tg.querySelector("path");
    // Core fills: a pie slice per core, scaled about the centre, seen through one static
    // annular mask (r0 outwards), is exactly the sector from r0 to the reading, and its
    // radius moves by transform alone.
    const ring0 = [qx - r1 - 1, qy - r1 - 1], ringBox = div(MV, "", `left:${ring0[0]}px;top:${ring0[1]}px;width:${2 * r1 + 2}px;height:${2 * r1 + 2}px;`
      + ["-webkit-mask-image", "mask-image"].map((k) => `${k}:radial-gradient(circle at ${r1 + 1}px ${r1 + 1}px,transparent ${r0 - 0.4}px,#000 ${r0 + 0.4}px)`).join(";"), "cpu");
    const f1 = (v) => (v >= 99.95 ? "100" : v.toFixed(1));
    const pc = slot(r.pc, "00.0", { fmt: f1 }), us = slot(r.us, "00.0", { fmt: f1 }), sy = slot(r.sy, "00.0", { fmt: f1 });
    let n = 0, fills = [], seg = [], prevT = null;
    return (s) => {
      const Y = s.sys;
      if (!Y) return;
      const cores = Y.cores || [];
      if (cores.length !== n) {
        n = cores.length;
        const step = 360 / Math.max(1, n);
        seg = cores.map((_, i) => [i * step + 2, (i + 1) * step - 2]);
        // the sector wells, and a boundary mark on the rim between each pair of cores
        r.cores.innerHTML = seg.map(([s0, s1], i) => {
          const [bx, by] = polar(qx, qy, RR - 4, i * step), [ex, ey] = polar(qx, qy, RR, i * step);
          return `<path d="${wedge(qx, qy, r0, r1, s0, s1)}" fill="var(--hl)" fill-opacity=".06" stroke="var(--hl)" stroke-opacity=".2" stroke-width=".8"/>`
            + `<line x1="${bx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="var(--lab)" stroke-opacity=".7"/>`;
        }).join("");
        ringBox.textContent = "";
        fills = seg.map(([s0, s1]) => {
          const pts = [[qx, qy], polar(qx, qy, r1, s0), polar(qx, qy, r1, s1), polar(qx, qy, r1, (s0 + s1) / 2)];
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), bx = Math.floor(Math.min(...xs)) - 2, by = Math.floor(Math.min(...ys)) - 2;
          const [ax, ay] = pts[1], [ex, ey] = pts[2];
          return layer(ringBox, [bx, by, Math.ceil(Math.max(...xs)) + 2 - bx, Math.ceil(Math.max(...ys)) + 2 - by],
            `<path d="M${qx} ${qy}L${ax.toFixed(1)} ${ay.toFixed(1)}A${r1} ${r1} 0 0 1 ${ex.toFixed(1)} ${ey.toFixed(1)}Z" fill="var(--grnF)" opacity=".9"/>`, { at: ring0, pivot: [qx, qy] });
        });
      }
      cores.forEach((v, i) => {
        // a sector moves only when its edge would move half a device pixel (0.25 pt, under 1%
        // of a core): each glide is an animation the page services every frame, and idle
        // cores jitter by fractions of a percent every line
        const rad = r0 + (Math.max(v, 1) / 100) * (r1 - r0), f = fills[i];
        if (f.__rad != null && Math.abs(rad - f.__rad) < 0.25) return;
        f.__rad = rad;
        move(f, `scale(${(rad / r1).toFixed(4)})`);
      });
      txt(r.ttl, `CPU, ${n} cores`);
      pc.set(Y.cpu); us.set(Y.user); sy.set(Y.sys);
      const ser = Kiln.series("cpu").filter((p) => p.t >= s.t - SECS);
      const peak = ser.length ? Math.max(...ser.map((p) => p.v)) : Y.cpu, top = peak > 60 ? 100 : 60;
      if (traceDue()) att(r.tp, "d", trace(ser, s.t, SECS, TW, 18, top));
      if (prevT != null) roll(r.tg, ((s.t - prevT) / SECS) * TW);
      prevT = s.t;
      // the seconds the trace really covers (a fresh feed starts with a few), never a fixed 45
      const got = ser.length > 1 ? ser[ser.length - 1].t - ser[0].t : 0, ld = (Y.load || [0])[0];
      // fixed lengths: load keeps four figures, the peak and the seconds sit in slots
      rich(r.ld, `load <tspan fill="var(--val)">${ld < 10 ? ld.toFixed(2) : ld.toFixed(1)}</tspan>, peak <tspan fill="var(--val)">${lead("00.0", f1(peak))}%</tspan> in ${lead("00", String(Math.round(got)))} s`);
    };
  }

  // output, last 60 minutes; the minute in progress is left out, and the chart steps left each minute
  function flow() {
    const [X, Yt, W] = DU.pfd, fx = X + 22, fy = Yt + 362, fw = W - 74, fh = 72;
    let h = `<line x1="${X + 14}" y1="${fy - 31}" x2="${X + W - 14}" y2="${fy - 31}" stroke="var(--rule)"/>`
      + T(fx, fy - 13, 13, "var(--lab)", "Output tokens per minute, last hour")
      + T(fx + fw + 38, fy - 13, 13, "var(--lab)", `average <tspan fill="var(--val)" data-r="avg"></tspan>`, 'text-anchor="end"')
      + `<g data-r="grid"></g>`;
    for (const m of [60, 45, 30, 15, 0]) h += T(fx + ((60 - m) / 60) * fw, fy + fh + 16, 12, "var(--lab)", m ? m + " min ago" : "last full min", `text-anchor="${m === 60 ? "start" : m === 0 ? "end" : "middle"}"`);
    const r = refs(group(h, "flow")), avg = Kiln.num(r.avg, { fmt: (v) => fmt(Math.round(v)) });
    // the average line slides, the chart rolls in its clip, the peak label rides above both
    r.al = layer(MV, [fx, -2, fw, 4], `<line x1="${fx}" x2="${fx + fw}" stroke="var(--val)" stroke-dasharray="2 4" opacity=".45"/>`, { part: "flow" });
    vis(r.al, false);
    const cb = [fx, fy - 24, fw + 6, fh + 26];
    r.sg = layer(clipBox(MV, cb, "flow"), cb, `<defs><linearGradient id="flowFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--flow)" stop-opacity=".3"/><stop offset="1" stop-color="var(--flow)" stop-opacity="0"/></linearGradient></defs>
        <path data-r="ar" fill="url(#flowFill)"/><path data-r="ln" fill="none" stroke="var(--cyn)" stroke-width="1.8"/>
        <circle data-r="pd" r="3.5" fill="var(--val)"/><circle data-r="ld" r="4" fill="var(--cyn)" stroke="var(--halo)" stroke-width="2"/>`, { cls: "roll", at: cb });
    Object.assign(r, refs(r.sg), refs(layer(TOP, [fx - 4, fy - 30, fw + 44, fh + 46], T(0, 0, 12, "var(--val)", "", 'data-r="pl" stroke="var(--halo)" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke"'), { cls: "", part: "flow" })));
    let top = 0, sig = "", min = null;
    return (s) => {
      const S = (s.claude && s.claude.tokens && s.claude.tokens.out_per_min) || [], full = S.slice(0, -1);
      if (full.length < 2) return;
      const mx = Math.max(...full, 1), step = [5000, 10000, 20000, 25000, 50000, 100000, 250000].find((x) => Math.ceil(mx / x) <= 3) || 500000;
      const nt = Math.max(step * Math.ceil(mx / step), 20000), yv = (v) => fy + fh - (v / nt) * fh;
      if (nt !== top) {
        top = nt;
        let g = "";
        for (let v = 0; v <= top; v += step) g += `<line x1="${fx}" y1="${yv(v)}" x2="${fx + fw}" y2="${yv(v)}" stroke="var(--hl)" stroke-opacity="${v ? 0.1 : 0.3}"/>` + T(fx + fw + 7, yv(v) + 4, 12, "var(--lab)", v ? `${v / 1000}k` : "0");
        rich(r.grid, g);
        sig = "";
      }
      const a = sum(full) / full.length;
      avg.set(a);
      move(r.al, `translateY(${yv(a).toFixed(1)}px)`);
      vis(r.al, true);
      const ns = full.join(",");
      if (ns === sig) return;
      sig = ns;
      const p = full.map((v, i) => [fx + (i / (full.length - 1)) * fw, yv(v)]), line = mono(p), pk = full.indexOf(mx);
      att(r.ln, "d", line);
      att(r.ar, "d", `${line}L${fx + fw} ${fy + fh}L${fx} ${fy + fh}Z`);
      att(r.pd, "cx", p[pk][0].toFixed(1)); att(r.pd, "cy", p[pk][1].toFixed(1));
      att(r.ld, "cx", p[p.length - 1][0].toFixed(1)); att(r.ld, "cy", p[p.length - 1][1].toFixed(1));
      // the label sits right of the peak, or left of it near the right edge, on the peak's own
      // level: its baseline 1 pt under the dot's centre, so nothing lower than the peak can
      // reach its glyphs. Hung 9 pt lower, its "min ago" sat on the next spikes (2026-11-05).
      const right = p[pk][0] < fx + fw - 190;
      att(r.pl, "x", (p[pk][0] + (right ? 9 : -9)).toFixed(1)); att(r.pl, "y", (p[pk][1] + 1).toFixed(1));
      att(r.pl, "text-anchor", right ? "start" : "end");
      txt(r.pl, `peak ${fmt(mx)}, ${full.length - 1 - pk} min ago`);
      const minute = Math.floor(s.t / 60);
      if (min != null && minute !== min) roll(r.sg, fw / (full.length - 1));
      min = minute;
    };
  }

  /* ---------------- right: the systems page ---------------- */
  function systems() {
    // CW: one column of the GPU/battery pair. Their SVGs are drawn at that width: a 160-wide
    // viewBox scaled to it was centred with 9.5 px of slack, off the column's left edge.
    const box = $("#sys"), W = 314, CW = (W - 18) / 2, NW = W - 118, SECS = 45, traceDue = everyOther();
    Kiln.track("gpu", (s) => s.sys && s.sys.gpu, SECS + 5);
    Kiln.track("rx", (s) => s.sys && s.sys.net && s.sys.net.rx_bps, SECS + 5);
    Kiln.track("tx", (s) => s.sys && s.sys.net && s.sys.net.tx_bps, SECS + 5);
    const lv = ["normal", "warn", "critical"];
    box.innerHTML = `
    <div class="memblk">
      <div class="h">Memory <b data-r="mpct"></b></div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end">
        <div class="big"><span data-r="mused"></span><small data-r="mtot"></small></div>
        <div style="text-align:right"><div style="font-size:11px;color:var(--lab);margin-bottom:3px">kernel pressure</div>
          <svg class="press" viewBox="0 0 176 18" width="176" height="18">${lv.map((l, i) => `<g data-r="p${i}" class="${l}"><rect x="${i * 60 + 0.5}" y=".5" width="55" height="17" rx="3"/><text x="${i * 60 + 28}" y="13" text-anchor="middle" font-size="11">${l}</text></g>`).join("")}</svg></div>
      </div>
      <svg viewBox="0 0 ${W} 10" width="100%" height="10" style="margin:8px 0 3px">
        <rect data-r="bw" y="0" height="10" rx="2" fill="var(--wired)" opacity=".9"/><rect data-r="ba" y="0" height="10" rx="2" fill="var(--grn)" opacity=".9"/>
        <rect data-r="bc" y="0" height="10" rx="2" fill="var(--amb)" opacity=".9"/><rect data-r="bf" y="0" height="10" rx="2" fill="var(--hl)" fill-opacity=".14"/></svg>
      <div class="kv kv3"><span class="lab">wired <span data-r="mw"></span></span><span class="lab">active <span data-r="ma"></span></span><span class="lab">compressed <span class="warn" data-r="mc"></span> GB</span></div>
      <div class="kv">swap in use <span data-r="sw"></span></div>
    </div>
    <div class="alt">
      <div class="h">Weekly limit <b data-r="lpct"></b></div>
      <div class="big"><span data-r="lbig"></span><small> % used</small></div>
      <svg viewBox="0 0 ${W} 10" width="100%" height="10" style="margin:8px 0 3px"><rect width="${W}" height="10" rx="2" fill="var(--hl)" fill-opacity=".14"/><rect data-r="lbar" height="10" rx="2" fill="var(--grn)"/></svg>
      <div class="kv" style="--vw:300px">resets <span data-r="lrs"></span></div>
      <div class="kv" style="--vw:140px">burn <span data-r="lburn"></span></div>
    </div>
    <div class="pair">
      <div><div class="h">GPU <b data-r="gpu"></b></div>
        <div style="position:relative;height:24px"><svg viewBox="0 0 ${CW} 24" width="${CW}" height="24"><line x1="0" y1="23" x2="${CW}" y2="23" stroke="var(--hl)" stroke-opacity=".2"/></svg>
          <div class="clip" style="position:absolute;inset:0"><div class="roll" data-r="gg"><svg viewBox="0 0 ${CW} 24" width="${CW}" height="24"><path data-r="gp" fill="none" stroke="var(--grn)" stroke-width="1.4"/></svg></div></div></div>
        <div class="kv">VRAM <span data-r="vram"></span></div></div>
      <div><div class="h">Battery <b data-r="bp"></b></div>
        <svg viewBox="0 0 ${CW} 24" width="${CW}" height="24"><rect x="1" y="3" width="${CW - 14}" height="18" rx="4" fill="none" stroke="var(--lab)" stroke-width="1.2"/><rect x="${CW - 11}" y="8" width="4" height="8" rx="1.5" fill="var(--lab)"/><rect data-r="bb" x="4" y="6" height="12" rx="2" fill="var(--grn)" opacity=".85"/></svg>
        <div class="kv" style="grid-template-columns:1fr"><span class="lab" data-r="bst"></span></div></div>
    </div>
    <div>
      <div class="h">Network <b data-r="npk"></b></div>
      <div style="display:grid;grid-template-columns:108px ${NW}px;gap:10px;align-items:center">
        <div><div class="big nr" style="color:var(--cyn)"><span>↓</span><span data-r="rx"></span></div><div class="big nr" style="color:var(--mag);margin-top:6px"><span>↑</span><span data-r="tx"></span></div></div>
        <div style="position:relative;width:${NW}px;height:46px"><svg viewBox="0 0 ${NW} 46" width="${NW}" height="46"><line x1="0" y1="23" x2="${NW}" y2="23" stroke="var(--hl)" stroke-opacity=".2"/></svg>
          <div class="clip" style="position:absolute;inset:0"><div class="roll" data-r="ng"><svg viewBox="0 0 ${NW} 46" width="${NW}" height="46"><path data-r="nrx" fill="none" stroke="var(--cyn)" stroke-width="1.5"/><path data-r="ntx" fill="none" stroke="var(--mag)" stroke-width="1.5"/></svg></div></div></div>
      </div>
    </div>
    <div>
      <div class="h">Disk <b data-r="dfree"></b></div>
      <svg viewBox="0 0 ${W} 8" width="100%" height="8"><rect width="${W}" height="8" rx="2" fill="var(--hl)" fill-opacity=".14"/><rect data-r="dbar" height="8" rx="2" fill="var(--lab)" opacity=".8"/></svg>
      <div class="kv kvd"><span class="lab" data-r="dpct"></span><span class="lab">read</span><span class="rd" data-r="drd"></span><span class="lab">write</span><span class="wr" data-r="dwr"></span></div>
    </div>
    <div>
      <div class="h">Busiest processes <b>CPU now</b></div>
      ${[0, 1, 2].map((i) => `<div class="kv" style="--vw:52px"><span class="lab" data-r="pn${i}"></span><span data-r="pv${i}"></span></div>`).join("")}
    </div>`;
    const r = refs(box), N = (k, f) => Kiln.num(r[k], { fmt: f });
    const n = {
      mpct: N("mpct", (v) => Math.round(v) + "% used"), mused: N("mused", (v) => v.toFixed(1)), mw: N("mw", (v) => v.toFixed(1)), ma: N("ma", (v) => v.toFixed(1)),
      mc: N("mc", (v) => v.toFixed(1)), sw: N("sw", (v) => v.toFixed(2) + " GB"), gpu: N("gpu", (v) => Math.round(v) + "%"), vram: N("vram", (v) => v.toFixed(2) + " GB"),
      bp: N("bp", (v) => Math.round(v) + "%"), rx: N("rx", rate), tx: N("tx", rate), drd: N("drd", rate), dwr: N("dwr", rate),
      lbig: N("lbig", (v) => Math.round(v)), lpct: N("lpct", (v) => Math.round(v) + "% used"),
    };
    // The bars here are set once per update, not glided: their per-update change is under a
    // pixel (memory, disk) or 1.4 px every few minutes (battery), so a layer of their own would
    // cost memory and buy no visible motion. att() writes only when the 0.1 px string changes.
    const drawMem = (M) => {
      let x = 0;
      for (const [k, v] of [["bw", M.wired], ["ba", M.active], ["bc", M.compressed]]) { const ww = (v / M.total) * W; att(r[k], "x", x.toFixed(1)); att(r[k], "width", Math.max(0, ww - 2).toFixed(1)); x += ww; }
      att(r.bf, "x", x.toFixed(1)); att(r.bf, "width", Math.max(0, W - x).toFixed(1));
    };
    let prevT = null;
    return (s) => {
      const Y = s.sys;
      if (!Y) return;
      const M = Y.mem, t = s.t;
      if (M) {
        n.mpct.set((M.used / M.total) * 100); n.mused.set(M.used / GB); txt(r.mtot, ` of ${Math.round(M.total / GB)} GB`);
        n.mw.set(M.wired / GB); n.ma.set(M.active / GB); n.mc.set(M.compressed / GB);
        drawMem(M);
        lv.forEach((l, i) => att(r["p" + i], "class", l + (l === M.pressure ? " on" : "")));
      }
      n.sw.set((Y.swap || 0) / GB);
      // maintenance: the weekly limit takes memory's place here
      if (PRESET.gauge === "memory") {
        const lh = limitHistory(s);
        if (lh) {
          n.lbig.set(lh.L.pct); n.lpct.set(lh.L.pct);
          att(r.lbar, "width", ((lh.L.pct / 100) * W).toFixed(1));
          txt(r.lrs, `${dateL(lh.L.resets_at)}, in ${span(lh.L.resets_at - t)}`);
          txt(r.lburn, lh.L.burn_per_h == null ? "not reported yet" : lh.L.burn_per_h.toFixed(1) + " %/h");
        }
      }
      n.gpu.set(Y.gpu);
      n.vram.set(Y.gpu_detail && Y.gpu_detail.vram_used != null ? Y.gpu_detail.vram_used / GB : null);
      const gs = Kiln.series("gpu").filter((p) => p.t >= t - SECS), gmax = Math.max(25, Math.ceil(Math.max(0, ...gs.map((p) => p.v)) / 25) * 25);
      const due = traceDue();
      if (due) att(r.gp, "d", trace(gs, t, SECS, CW, 24, gmax));
      const B = Y.batt;
      if (B) {
        n.bp.set(B.pct);
        att(r.bb, "width", (((CW - 20) / 100) * B.pct).toFixed(1));   // the cell's inside, 4 pt in from each wall
        // one line under the cell, at most 18 characters for the 148 pt column ("on battery,
        // 1 h 34 m left" ran past it on the real host); a time left is only ever on battery
        rich(r.bst, B.ac ? (B.charging ? "on power, charging" : "on power") : B.mins_left ? `<span>${two(B.mins_left * 60)}</span> left` : "on battery");
      }
      const net = Y.net || {};
      n.rx.set(net.rx_bps); n.tx.set(net.tx_bps);
      const rs = Kiln.series("rx").filter((p) => p.t >= t - SECS), ts = Kiln.series("tx").filter((p) => p.t >= t - SECS);
      const mxN = Math.max(1, ...rs.map((p) => p.v), ...ts.map((p) => p.v)), got = rs.length > 1 ? rs[rs.length - 1].t - rs[0].t : 0;
      txt(r.npk, `peak ${rate(Math.max(0, ...rs.map((p) => p.v)))} in ${Math.round(got)} s`);
      // mirrored on a square-root scale: download up, upload down
      const half = (ser, sgn) => {
        const pts = [];
        for (const p of ser) if (!pts.length || p.t > pts[pts.length - 1].t) pts.push(p);
        if (pts.length < 2) return "";
        const v = ease(pts.map((p) => p.v), 3);
        return mono(pts.map((p, i) => [NW - ((t - p.t) / SECS) * NW, 23 + sgn * (1 + Math.sqrt(v[i] / mxN) * 20)]));
      };
      if (due) { att(r.nrx, "d", half(rs, -1)); att(r.ntx, "d", half(ts, 1)); }
      if (prevT != null) { roll(r.ng, ((t - prevT) / SECS) * NW); roll(r.gg, ((t - prevT) / SECS) * CW); }
      prevT = t;
      const D = Y.disk;
      if (D) {
        const used = 1 - D.free / D.total;
        txt(r.dfree, `${Math.round(D.free / 1e9)} GB free of ${Math.round(D.total / 1e9)}`);
        att(r.dbar, "width", (used * W).toFixed(1));
        txt(r.dpct, `${Math.round(used * 100)}% used`);
        n.drd.set(D.read_bps); n.dwr.set(D.write_bps);
      }
      const top = Y.top_cpu || [];
      for (let i = 0; i < 3; i++) { txt(r["pn" + i], top[i] ? top[i][0] : ""); txt(r["pv" + i], top[i] ? top[i][1].toFixed(1) + "%" : ""); }
    };
  }

  /* ---------------- lower DU 1: the week as fuel planning ---------------- */
  function fuel() {
    const [X, Yt, W, H] = DU.fuel, px = X + 44, py = Yt + 70, pw = W - 112, ph = 190, xe = px + pw;
    const yp = (p) => py + ph - (p / 100) * ph;
    let h = duTitle(X, Yt, W, "Fuel plan: weekly limit", "ttl") + T(X + 16, Yt + 46, 12, "var(--lab)", "", 'data-r="dest"');
    h += `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--amb)" stroke-opacity=".35" stroke-width="1.4"/></pattern>
        <pattern id="hatchM" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--hatchM)" stroke-opacity=".3" stroke-width="1.2"/></pattern></defs>`;
    // reserve band (a planning setting, not a measurement) and the grid
    h += `<rect x="${px}" y="${yp(100)}" width="${pw}" height="${yp(100 - RESERVE) - yp(100)}" fill="url(#hatch)"/>`
      + T(px + pw - 6, yp(100 - RESERVE) + 14, 12, "var(--amb)", `reserve, last ${RESERVE}% (preset)`, 'text-anchor="end"');
    for (const p of [0, 25, 50, 75, 100]) h += `<line x1="${px}" y1="${yp(p)}" x2="${px + pw}" y2="${yp(p)}" stroke="var(--hl)" stroke-opacity="${p ? 0.1 : 0.32}"/>` + T(px - 8, yp(p) + 4, 11, "var(--lab)", p, 'text-anchor="end"');
    h += `<g data-r="days"></g><g data-r="fc"></g>
      <path d="M${xe} ${py - 6}V${py + ph}" stroke="var(--cyn)" stroke-width="1.5"/>
      <g data-r="lw"></g><g data-r="rsl"></g>
      <path data-r="gap" fill="none" stroke="var(--grn)" stroke-width="1.5" stroke-dasharray="1.5 4" stroke-linecap="round" opacity=".7"/>
      <path data-r="tr" stroke="var(--grn)" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <circle data-r="now" r="3.5" fill="var(--grn)"/>
      <g data-r="inset"></g>`
      // the footer, on the lower row's common baseline (FOOT); its right end says how fresh
      // the limit reading is, so a still chart reads as current rather than stuck
      + T(X + 16, Yt + FOOT, 12, "var(--lab)", "", 'data-r="bot"') + T(X + W - 16, Yt + FOOT, 12, "var(--lab)", "", 'text-anchor="end" data-r="age"');
    const r = refs(group(h, "lower"));
    let weekKey = null, insetSig = "", fcSig = "";
    // sample a polyline every few points so a box can be tested against its segments
    const dense = (pts) => pts.flatMap((p, i) => {
      if (!i) return [p];
      const [x0, y0] = pts[i - 1], n = Math.ceil(Math.hypot(p[0] - x0, p[1] - y0) / 6);
      return Array.from({ length: n }, (_, k) => [x0 + ((p[0] - x0) * (k + 1)) / n, y0 + ((p[1] - y0) * (k + 1)) / n]);
    });
    function inset(lh, t, xt, keepOut, keepOutPts) {
      const { L, ws, week } = lh, el = t - ws, span = Math.max(1800, Math.min(el, 6 * 3600)), i0 = Math.max(ws, t - span);
      const win = week.filter((p) => p[0] >= i0).concat([[t, L.pct]]);
      const prior = week.filter((p) => p[0] < i0).pop();
      if (prior) win.unshift([i0, prior[1]]);
      const vs = win.map((p) => p[1]), lo = Math.max(0, Math.floor(Math.min(...vs) / 2) * 2), rg = 6 * Math.ceil((Math.max(...vs) - lo + 1) / 6);
      const IW = 150, IH = 70, mag = Math.round(IW / (t - i0) / (pw / WEEK));
      // put the magnifier wherever the week has drawn nothing
      const cands = [[px + 74, py + 100], [px + pw - 196, py + 108], [px + 124, py + 40], [px + pw - 196, py + 40]];
      const pts = keepOutPts.concat(dense(week.map(([tt, p]) => [xt(tt), yp(p)]).concat([[xt(t), yp(L.pct)]])));
      const hit = ([x, y]) => {
        const b = [x - 12, y - 22, x + IW + 22, y + IH + 22];
        return pts.some(([a, c]) => a > b[0] && a < b[2] && c > b[1] && c < b[3]) || keepOut.some(([a0, c0, a1, c1]) => a0 < b[2] && a1 > b[0] && c0 < b[3] && c1 > b[1]);
      };
      const [ix, iy] = cands.find((c) => !hit(c)) || cands[0];
      const ixt = (tt) => ix + ((tt - i0) / (t - i0)) * IW, iyp = (p) => iy + IH - ((p - lo) / rg) * IH;
      const xn = xt(t), yn = yp(L.pct), side = ix > xn ? ix : ix + IW;
      let g = `<path d="M${xn.toFixed(1)} ${yn.toFixed(1)}L${side} ${iy}M${xn.toFixed(1)} ${yn.toFixed(1)}L${side} ${iy + IH}" stroke="var(--hl)" stroke-opacity=".28" stroke-dasharray="2 3"/>
        <rect x="${ix}" y="${iy}" width="${IW}" height="${IH}" fill="var(--halo)" stroke="var(--hl)" stroke-opacity=".3"/>`;
      for (let k = 0; k <= 3; k++) { const p = lo + (k * rg) / 3; g += `<line x1="${ix}" y1="${iyp(p)}" x2="${ix + IW}" y2="${iyp(p)}" stroke="var(--hl)" stroke-opacity=".08"/>` + T(ix + IW + 4, iyp(p) + 4, 11, "var(--lab)", p); }
      let step = "";
      win.forEach(([tt, p], i) => { const x = ixt(tt).toFixed(1), y = iyp(p).toFixed(1); step += i ? `H${x}V${y}` : `M${x} ${y}`; });
      step += `H${ixt(t).toFixed(1)}`;
      g += `<path d="${step}" fill="none" stroke="var(--grn)" stroke-width="2"/>`;
      const changes = win.filter(([, p], i) => i === 0 || p !== win[i - 1][1]).slice(-6);
      // every step gets its dot; a figure only where it clears the newer one to its right
      // (steps a few minutes apart printed "1213 14" over each other)
      let room = Infinity, roomY = null;
      for (const [tt, p] of changes.slice().reverse()) {
        const x = ixt(tt), y = iyp(p), w = 7.2 * String(p).length;
        g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="var(--grn)"/>`;
        if (x - 5 > room - 3 && Math.abs(y - roomY) < 12) continue;
        // haloed in the inset's glass, so the step line passing behind never cuts the figure
        g += T(x - 5, y + 4, 11, "var(--val)", p, 'text-anchor="end" stroke="var(--halo)" stroke-width="3" stroke-linejoin="round" paint-order="stroke"');
        room = x - 5 - w; roomY = y;
      }
      g += T(ix, iy + IH + 15, 12, "var(--lab)", F.clock(i0)) + T(ix + IW, iy + IH + 15, 12, "var(--lab)", F.clock(t), 'text-anchor="end"')
        + T(ix, iy - 7, 12, "var(--lab)", `${el <= 6 * 3600 ? "first " + two(el) : "last 6 h"}, time ×${mag}`);
      return g;
    }
    return (s) => {
      const lh = limitHistory(s);
      if (!lh) { txt(r.dest, "no weekly limit in the feed"); return; }
      const { L, ws, week } = lh, t = s.t, xt = (tt) => px + ((tt - ws) / WEEK) * pw;
      rich(r.ttl, `<tspan fill="var(--val)">${L.pct}%</tspan> used, <tspan fill="var(--val)">${100 - L.pct}%</tspan> left`);
      txt(r.dest, `destination: reset ${dateL(L.resets_at)}, in ${span(L.resets_at - t)}`);
      if (ws !== weekKey) {
        weekKey = ws;
        // day waypoints at local midnight
        const first = loc(ws);
        first.setHours(24, 0, 0, 0);
        let g = "";
        for (let tt = first.getTime() / 1000; tt < L.resets_at; tt += 86400) {
          const x = xt(tt);
          g += `<line x1="${x}" y1="${py}" x2="${x}" y2="${py + ph}" stroke="var(--hl)" stroke-opacity=".07"/>`
            + T(x, py + ph + 16, 12, "var(--lab)", WD(tt), 'text-anchor="middle"') + T(x, py + ph + 30, 12, "var(--lab)", loc(tt).getDate(), 'text-anchor="middle"');
        }
        rich(r.days, g);
      }
      // last week's landing for reference, and the destination label clear of it
      const lw = lh.lastWeek, ry = lw != null && Math.abs(yp(lw) - (py + ph / 2 + 10)) < 36 ? py + ph - 34 : py + ph / 2 + 10;
      rich(r.lw, lw == null ? "" : `<path d="M${xe - 5} ${yp(lw)}l5 -5l5 5l-5 5Z" fill="var(--halo)" stroke="var(--val)" stroke-width="1.5"/>`
        + T(xe + 9, yp(lw) - 2, 12, "var(--val)", "last wk") + T(xe + 9, yp(lw) + 12, 12, "var(--val)", `${lw}%`));
      rich(r.rsl, T(xe + 9, ry, 12, "var(--cyn)", "reset") + T(xe + 9, ry + 15, 12, "var(--lab)", `${WD(L.resets_at)} ${loc(L.resets_at).getDate()}`) + T(xe + 9, ry + 29, 12, "var(--lab)", F.clock(L.resets_at)));
      // forecast: not computed until 12 h in, said as a bracket on the time axis, never as a line
      const xn = xt(t), fcAt = ws + 12 * 3600, xf = xt(fcAt), keepOut = [[px + pw - 170, yp(100 - RESERVE) + 2, px + pw, yp(100 - RESERVE) + 16]], keepPts = [];
      let fc = "";
      if (L.projected == null) {
        if (t < fcAt) {
          fc = `<rect x="${xn.toFixed(1)}" y="${py}" width="${(xf - xn).toFixed(1)}" height="${ph}" fill="url(#hatchM)"/>
            <line x1="${xf.toFixed(1)}" y1="${py - 6}" x2="${xf.toFixed(1)}" y2="${py + ph}" stroke="var(--mag)" stroke-dasharray="3 3"/>`
            + T(xf + 6, py + 40, 12, "var(--mag)", "forecast starts here,") + T(xf + 6, py + 55, 12, "var(--mag)", `${dateL(fcAt)}, 12 h in;`)
            + T(xf + 6, py + 70, 12, "var(--lab)", "no pace line until then");
          keepOut.push([xf, py + 28, xf + 190, py + 76]);
        } else {
          fc = T(xn + 8, py + 40, 12, "var(--lab)", "the feed has no forecast yet");
          keepOut.push([xn, py + 28, xn + 180, py + 46]);
        }
      } else {
        const y2 = yp(Math.min(L.projected, 104)), yn = yp(L.pct);
        fc = `<path d="M${xn.toFixed(1)} ${yn.toFixed(1)}L${xe} ${y2.toFixed(1)}" stroke="var(--mag)" stroke-width="1.6" stroke-dasharray="5 4" fill="none"/>`
          + T(xe - 6, y2 - 7, 12, "var(--mag)", `projected ${Math.round(L.projected)}%`, 'text-anchor="end"');
        keepPts.push(...dense([[xn, yn], [xe, y2]]));
        if (L.runout_at && L.runout_at < L.resets_at) {
          const xr = xt(L.runout_at);
          fc += `<path d="M${xr - 4} ${yp(100) - 4}l8 8m0 -8l-8 8" stroke="var(--mag)" stroke-width="1.6"/>` + T(xr, yp(100) - 9, 12, "var(--mag)", `runs out ${WD(L.runout_at)} ${hhmm(L.runout_at)}`, 'text-anchor="middle"');
        }
      }
      if (fc !== fcSig) { fcSig = fc; rich(r.fc, fc); }
      // what has been burned, as recorded; before the first reading the week is unknown
      const pts = week.map(([tt, p]) => [xt(tt), yp(p)]);
      // set once per update; att() rewrites the path only when it moves a tenth of a point
      const all = pts.concat([[xt(t), yp(L.pct)]]);
      att(r.tr, "d", "M" + all.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L"));
      att(r.now, "cx", xt(t).toFixed(1)); att(r.now, "cy", yp(L.pct).toFixed(1));
      const first = week.length ? week[0] : [t, L.pct];
      att(r.gap, "d", first[0] - ws > 1800 ? `M${xt(ws).toFixed(1)} ${yp(0)}L${xt(first[0]).toFixed(1)} ${yp(first[1]).toFixed(1)}` : "");
      const isig = [week.length, week.length ? week[week.length - 1].join() : "", L.pct, Math.floor(t / 60), fc.length].join("|");
      if (isig !== insetSig) { insetSig = isig; rich(r.inset, inset(lh, t, xt, keepOut, keepPts)); }
      // "used N% since" repeated the title; the reading's age is what a still chart lacks
      rich(r.bot, L.burn_per_h == null ? "burn not reported yet" : `burn <tspan fill="var(--val)">${L.burn_per_h.toFixed(1)} %/h</tspan>, last 6 h`);
      const ra = (s.claude.limits || {}).read_at;
      rich(r.age, ra ? `last reading <tspan fill="var(--val)">${two(Math.max(0, t - ra))}</tspan> ago` : "");
    };
  }

  /* ---------------- lower DU 2: today's output on a 24-hour rose, heading-up like a nav display ---------------- */
  function rose() {
    const [X, Yt, W] = DU.rose, cx = X + W / 2, cy = Yt + 170, r0 = 34, rmax = 90;
    let ticks = "", wedges = "";
    for (let hr = 0; hr < 24; hr++) {
      const [x0, y0] = polar(cx, cy, rmax + 4, hr * 15), [x1, y1] = polar(cx, cy, rmax + (hr % 3 ? 8 : 12), hr * 15);
      ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="var(--lab)"/>`;
      wedges += `<path data-r="w${hr}" fill="var(--grnF)" fill-opacity=".78" stroke="var(--grn)" stroke-width="0"/>`;
    }
    let nums = "";
    for (let hr = 0; hr < 24; hr += 3) nums += T(0, 0, 12, "var(--lab)", pad(hr), `text-anchor="middle" data-r="n${hr}"`);
    const h = duTitle(X, Yt, W, "Output by hour, today", "ttl")
      + `<g data-r="rings"></g><g data-r="card">${wedges}<path data-r="typ" fill="none" stroke="var(--val)" stroke-width="1.3" stroke-dasharray="3 2.5"/>${ticks}</g>${nums}
      <line x1="${cx}" y1="${cy - rmax - 2}" x2="${cx}" y2="${cy - r0}" stroke="var(--amb)" stroke-width="1.5"/>
      <rect x="${cx - 27}" y="${cy - rmax - 30}" width="54" height="20" rx="2" fill="var(--box)" stroke="var(--val)"/>`
      + T(cx, cy - rmax - 15, 13, "var(--val)", "", 'text-anchor="middle" font-weight="700" data-r="hd"')
      + `<g data-r="pkg"><circle data-r="pkd" r="2.5" fill="var(--val)"/><path data-r="pkl" fill="none" stroke="var(--val)" stroke-opacity=".45"/></g>`
      // 11 pt: at 12 the callout ran into the heading box beside it
      + T(X + 16, Yt + 57, 11, "var(--val)", "", 'data-r="pkt"')
      + T(cx, cy + 2, 17, "var(--val)", "", 'text-anchor="middle" font-weight="700" data-r="tot"') + T(cx, cy + 17, 12, "var(--lab)", "today", 'text-anchor="middle"')
      + `<rect x="${X + 16}" y="${Yt + FOOT2 - 9}" width="12" height="9" fill="var(--grnF)" opacity=".78"/>` + T(X + 33, Yt + FOOT2, 12, "var(--lab)", "today")
      + `<path d="M${X + 82} ${Yt + FOOT2 - 4.5}h16" stroke="var(--val)" stroke-dasharray="3 2.5" stroke-width="1.3"/>`
      + T(X + 103, Yt + FOOT2, 12, "var(--lab)", "", 'data-r="typl"') + T(X + 16, Yt + FOOT, 12, "var(--lab)", "", 'data-r="calls"');
    const r = refs(group(h, "lower")), tot = Kiln.num(r.tot, { fmt: si });
    let vmax = 0, rot = null, typSig = "", curH = -1;
    const rr = (v) => r0 + Math.sqrt(Math.max(0, v) / vmax) * (rmax - r0);
    return (s) => {
      const A = s.analytics, tok = s.claude && s.claude.tokens;
      if (!A || !A.days || !A.days.length || !tok || !tok.today) return;
      const t = s.t, d = loc(t), nowH = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600, ch = d.getHours();
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, last = A.days[A.days.length - 1], isToday = last.date === key;
      const hours = isToday ? last.hours.slice() : new Array(24).fill(0);
      // tokens that landed after analytics last counted belong to the hour in progress
      const live = tok.today.out - (isToday ? last.out : 0);
      if (live > 0) hours[ch] += live;
      // the typical day: per-hour mean of the days before today
      const prev = isToday ? A.days.slice(0, -1) : A.days;
      const typ = Array.from({ length: 24 }, (_, hr) => (prev.length ? sum(prev.map((x) => x.hours[hr] || 0)) / prev.length : 0));
      const peakV = Math.max(...hours, ...typ, 1), nv = [1e6, 2.2e6, 3e6, 5e6, 1e7, 2e7, 5e7].find((v) => v >= peakV * 1.02) || peakV * 1.1;
      if (nv !== vmax) {
        vmax = nv;
        let g = "";
        // range rings from 500k; only the million rings carry a figure (four labels in the
        // wedges read as clutter, and the sqrt scale packs the small rings together)
        for (const [v, lab] of [[5e5, ""], [1e6, "1M"], [2e6, "2M"], [5e6, "5M"], [1e7, "10M"]]) {
          if (v > vmax) continue;
          g += `<circle cx="${cx}" cy="${cy}" r="${rr(v).toFixed(1)}" fill="none" stroke="var(--hl)" stroke-opacity="${v === 1e6 ? 0.22 : 0.12}" ${v === 1e6 ? "" : 'stroke-dasharray="2 4"'}/>`;
          if (!lab) continue;
          const [lx, ly] = polar(cx, cy, rr(v), 152);
          // haloed in the glass colour: the typical-day line and the wedges pass under them
          g += T(lx + 3, ly + 3, 11, "var(--lab)", lab, 'stroke="var(--halo)" stroke-width="3" stroke-linejoin="round" paint-order="stroke"');
        }
        rich(r.rings, g);
        typSig = "";
      }
      // heading-up: the card turns so the current time sits under the lubber line
      const nr = (-nowH * 15).toFixed(1);
      if (nr !== rot) {
        rot = nr;
        att(r.card, "transform", `rotate(${nr} ${cx} ${cy})`);
        // a numeral gives way to the heading box and to the peak callout in the top-left corner
        const busy = [[cx - 40, cy - rmax - 34, cx + 40, cy - rmax - 6], [X + 12, Yt + 42, X + 150, Yt + 66]];
        for (let hr = 0; hr < 24; hr += 3) {
          const a = (hr - nowH) * 15, [tx, ty] = polar(cx, cy, rmax + 21, a), e = r["n" + hr];
          att(e, "x", tx.toFixed(1)); att(e, "y", (ty + 4).toFixed(1));
          vis(e, !busy.some(([x0, y0, x1, y1]) => tx + 9 > x0 && tx - 9 < x1 && ty + 6 > y0 && ty - 8 < y1));
        }
      }
      txt(r.hd, hhmm(t));
      // only the hour in progress grows, a step each time a response lands: set, not glided
      hours.forEach((v, hr) => att(r["w" + hr], "d", v > 0 ? wedge(cx, cy, r0, rr(v), hr * 15 + 1.2, (hr + 1) * 15 - 1.2) : ""));
      if (curH !== ch) {   // the hour in progress is drawn open: it is still filling
        curH = ch;
        for (let hr = 0; hr < 24; hr++) { att(r["w" + hr], "fill-opacity", hr === ch ? 0 : 0.78); att(r["w" + hr], "stroke-width", hr === ch ? 1.3 : 0); }
      }
      const ts = typ.map(Math.round).join(",");
      if (ts !== typSig) {
        typSig = ts;
        att(r.typ, "d", "M" + typ.map((v, hr) => polar(cx, cy, rr(v), (hr + 0.5) * 15).map((x) => x.toFixed(1)).join(" ")).join("L") + "Z");
      }
      // peak, called out to the corner so it never sits on the hour numerals
      const pk = hours.indexOf(Math.max(...hours));
      vis(r.pkg, hours[pk] > 0);
      if (hours[pk] > 0) {
        const [qx, qy] = polar(cx, cy, rr(hours[pk]), (pk + 0.5 - nowH) * 15);
        att(r.pkd, "cx", qx.toFixed(1)); att(r.pkd, "cy", qy.toFixed(1));
        att(r.pkl, "d", `M${qx.toFixed(1)} ${qy.toFixed(1)}L${X + 70} ${Yt + 62}H${X + 16}`);
        txt(r.pkt, `peak ${pad(pk)}:00, ${si(hours[pk])}`);
      } else txt(r.pkt, "");
      tot.set(tok.today.out);
      rich(r.ttl, `<tspan fill="var(--val)">${si(tok.today.out)}</tspan> so far`);
      rich(r.typl, `typical day, avg <tspan fill="var(--val)">${si(prev.length ? sum(prev.map((x) => x.out)) / prev.length : 0)}</tspan>`);
      const T0 = tok.today, hit = (T0.cache_read / Math.max(1, T0.cache_read + T0.cache_write + T0.input)) * 100;
      rich(r.calls, `<tspan fill="var(--val)">${fmt(T0.calls || 0)}</tspan> calls, cache hit <tspan fill="var(--val)">${hit.toFixed(1)}%</tspan>`);
    };
  }

  /* ---------------- lower DU 3: agent mix as one engine-page instrument ---------------- */
  // Six agent types on one graduated scale (0-50% of the fortnight's spawns), as an ECAM system
  // page reads six quantities: a name, a tape with its fill, a boxed digital readout. Today's
  // share rides under each tape as a cyan bug. (Six separate 30 pt dials said the same with
  // less room for the figures.)
  function mix() {
    const [X, Yt, W] = DU.mix, smax = 50, x0 = X + 16, bx = X + 124, bw = 126, rx = X + W - 16 - 44, y0 = Yt + 60, RH = 36;
    const sx = (p) => bx + (clamp(p, 0, smax) / smax) * bw;
    let h = duTitle(X, Yt, W, "Agent mix, 14 days", "ttl")
      + `<line x1="${bx}" y1="${y0}" x2="${bx + bw}" y2="${y0}" stroke="var(--lab)" stroke-opacity=".6"/>`;
    for (let p = 0; p <= smax; p += 5) {
      const major = p % 10 === 0;
      h += `<line x1="${sx(p).toFixed(1)}" y1="${y0}" x2="${sx(p).toFixed(1)}" y2="${y0 + (major ? 5 : 3)}" stroke="var(--lab)" stroke-opacity="${major ? 0.9 : 0.5}"/>`;
      if (major) h += T(sx(p), y0 - 5, 11, "var(--lab)", p, 'text-anchor="middle"');
    }
    h += T(bx + bw + 8, y0 - 5, 11, "var(--lab)", "%");
    const rows = [], movers = [];
    for (let i = 0; i < 6; i++) {
      const ry = y0 + 10 + i * RH, by = ry + 9;   // the tape's top edge
      let g = `<rect x="${bx}" y="${by}" width="${bw}" height="8" fill="var(--hl)" fill-opacity=".1" stroke="var(--hl)" stroke-opacity=".25" stroke-width=".8"/>`
        + `<rect x="${rx}" y="${ry + 4}" width="44" height="19" rx="2" fill="var(--box)" stroke="var(--hl)" stroke-opacity=".45"/>`
        + T(rx + 40, ry + 18.5, 13, "", "", 'text-anchor="end" font-weight="700" data-r="v"')
        + T(x0, ry + 14, 12, "", "", 'data-r="k"')
        + T(x0, ry + 28, 11, "var(--lab)", "", 'data-r="sp"');
      h += `<g data-r="s${i}">${g}</g>`;
      // moving, per row: the fill, scaled about the tape's left end, and today's bug
      const fl = layer(MV, [bx, by, bw, 8], `<rect x="${bx}" y="${by + 0.5}" width="${bw}" height="7" fill="var(--grnF)" opacity=".9"/>`, { pivot: [bx, by], part: "lower" });
      const td = layer(MV, [bx - 4, by + 9, 8, 7], `<path d="M${bx - 3.5} ${by + 15}L${bx} ${by + 9.5}L${bx + 3.5} ${by + 15}Z" fill="var(--cyn)"/>`, { part: "lower" });
      movers.push({ fl, f: fl.querySelector("rect"), td });
      rows.push(ry);
    }
    // the legend on the lower row's footer baselines; analytics is recounted every 10 s, and
    // the count's age on the right shows it (the tapes move only when a type's share does)
    h += T(X + 16, Yt + FOOT2, 12, "var(--lab)", `tape and box: share of 14-day spawns; <tspan fill="var(--cyn)">▲</tspan> today's`)
      + T(X + 16, Yt + FOOT, 12, "var(--lab)", "", 'data-r="f2"') + T(X + W - 16, Yt + FOOT, 12, "var(--lab)", "", 'text-anchor="end" data-r="age"');
    const root = group(h, "lower"), r = refs(root);
    const S = rows.map((ry, i) => { const g = r["s" + i], o = Object.assign(refs(g), movers[i]); return { g, o, v: Kiln.num(o.v, { fmt: (x) => x.toFixed(1) }) }; });
    return (s) => {
      const A = s.analytics;
      if (!A || !A.spawns) return;
      const d14 = Object.entries(A.spawns.d14 || {}).sort((a, b) => b[1] - a[1]), today = A.spawns.today || {};
      const tot = sum(d14.map((e) => e[1])), tt = sum(Object.values(today)), toks = (A.agent_tokens && A.agent_tokens.d14) || {};
      rich(r.ttl, `<tspan fill="var(--val)">${tot}</tspan> spawns, <tspan fill="var(--val)">${tt}</tspan> today`);
      S.forEach((sl, i) => {
        const e = d14[i];
        vis(sl.g, !!e); vis(sl.o.fl, !!e);
        if (!e) { vis(sl.o.td, false); return; }
        const [k, v] = e, gp = k === "general-purpose", c = gp ? "var(--amb)" : "var(--val)", o = sl.o;
        const share = tot ? (v / tot) * 100 : 0, td = tt ? ((today[k] || 0) / tt) * 100 : 0;
        move(o.fl, `scaleX(${(clamp(share, 0, smax) / smax).toFixed(4)})`);
        att(o.f, "fill", gp ? "var(--amb)" : "var(--grnF)");
        vis(o.td, td > 0);
        move(o.td, `translateX(${(sx(td) - bx).toFixed(1)}px)`);
        sl.v.set(share);
        att(o.v, "fill", gp ? "var(--ambv)" : "var(--grn)");
        txt(o.k, k); att(o.k, "fill", c);
        rich(o.sp, `<tspan fill="var(--val)">${v}</tspan> spawns, <tspan fill="var(--val)">${si((toks[k] && toks[k].out) || 0)}</tspan> out`);
      });
      const rest = d14.slice(6);
      // general-purpose spawns today take the line, in amber; with none (the GEN PURPOSE lamp
      // already says "0 of N"), it counts the types too small for a dial
      const gp = A.general_purpose || {};
      rich(r.f2, gp.today ? `general-purpose: <tspan fill="var(--ambv)">${gp.today}</tspan> today` : `${rest.length} smaller types, ${sum(rest.map((e) => e[1]))} spawns`);
      att(r.f2, "fill", gp.today ? "var(--amb)" : "var(--lab)");
      rich(r.age, A.derived_at ? `counted <tspan fill="var(--val)">${two(Math.max(0, s.t - A.derived_at))}</tspan> ago` : "");
    };
  }

  /* ---------------- lower DU 4: the flight log ---------------- */
  /* ---------------- the flight log, under the sessions in the left pane ---------------- */
  function flightLog() {
    const box = $("#logRows"), head = $("#logCount"), rows = new Map();
    // rows fill the pane from the log's heading (28 under logTop) to 8 pt above its foot (613)
    const ROW = 38, ASK = 55, avail = () => 605 - (logTop + 28);
    let ready = false;
    const what = (e) => {
      const d = e.detail || "", i = d.indexOf(": "), ty = i > 0 ? d.slice(0, i) : d, rest = i > 0 ? d.slice(i + 2) : "";
      switch (e.kind) {
        // n: turns the feed coalesced into this one event (within 10 min)
        case "done": return [e.n > 1 ? `${e.n} turns finished` : "turn finished", ""];
        case "ask": return [/^perm /.test(d) ? `asked: permission, ${d.slice(5)}` : `asked: ${d || "a question"}`, "ask"];
        case "answered": { const m = /(\d+(?:\.\d+)?)\s*s/.exec(d); return [m ? `answered after ${two(+m[1])}` : ("answered " + d).trim(), "ok"]; }
        case "agent_start": return [`${ty} out: ${rest}`, ty === "general-purpose" ? "gp" : ""];
        case "agent_done": return [`${ty} back: ${rest}`, ty === "general-purpose" ? "gp" : ""];
        case "failed": case "fail": return [d ? `failed: ${d}` : "failed", "bad"];
        case "reset": return ["reset to 0%, week began", "sys"];
        default: { const k = e.kind.replace(/_/g, " "); return [d ? `${k}: ${d}` : k, ""]; }
      }
    };
    return (s) => {
      const C = s.claude || {}, ev = (C.events || []).slice(), t = s.t, L = C.limits && C.limits.seven_day;
      // the weekly reset is an event too, read off resets_at
      if (L && L.resets_at && L.resets_at - WEEK <= t) ev.push({ t: L.resets_at - WEEK, kind: "reset", name: "weekly limit", sid: "", detail: "" });
      ev.sort((a, b) => b.t - a.t);
      // reminders fold into the question they nag about, so the strip shows one line per thing that happened
      const list = [], nags = {};
      let used = 0;
      for (const e of ev) {
        const who = e.sid || e.name;
        if (e.kind === "remind") { (nags[who] = nags[who] || []).push(hhmm(e.t)); continue; }
        const w = what(e);
        if (e.kind === "ask" && nags[who]) { w[0] += `; nudged ${nags[who].reverse().join(", ")}`; delete nags[who]; }
        const tall = w[1] === "ask" && w[0].length > 26, hgt = tall ? ASK : ROW;
        if (used + hgt > avail()) break;
        list.push({ key: `${e.t}|${e.kind}|${e.sid}|${e.detail}`, e, w, tall, y: used });
        used += hgt;
      }
      txt(head, `last ${list.length}, local`);
      const keep = new Set(list.map((x) => x.key));
      list.forEach((x, i) => {
        let o = rows.get(x.key), fresh = false;
        if (!o) {
          const el = document.createElement("div");
          el.className = "e";
          el.innerHTML = `<span class="tm"></span><span class="who"><b></b><i></i></span><span class="what"></span>`;
          o = { el, tm: el.children[0], nm: el.children[1].children[0], age: el.children[1].children[1], what: el.children[2], tr: "" };
          rows.set(x.key, o);
          fresh = true;
        }
        txt(o.tm, hhmm(x.e.t));
        // a run of events from one session names it once, at the top, as a log's ditto does
        // (seven rows repeating one truncated session name said one thing seven times)
        const above = list[i - 1], same = above && (x.e.sid || x.e.name) && (above.e.sid || above.e.name) === (x.e.sid || x.e.name);
        txt(o.nm, same ? "" : x.e.name || "");
        txt(o.age, two(Math.max(0, t - x.e.t)));
        txt(o.what, x.w[0]);
        const c = "what" + (x.w[1] ? " " + x.w[1] : "");
        if (o.what.className !== c) o.what.className = c;
        const tr = `translateY(${x.y}px)`;
        if (o.tr !== tr) { o.tr = tr; o.el.style.transform = tr; }
        o.el.classList.toggle("last", i === list.length - 1);
        if (fresh) { box.appendChild(o.el); if (ready && !Kiln.reduced) o.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); }
      });
      ready = true;
      for (const [k, o] of rows) {
        if (keep.has(k)) continue;
        rows.delete(k);
        if (Kiln.reduced) o.el.remove();
        else o.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250 }).onfinish = () => o.el.remove();
      }
    };
  }

  /* ---------------- presets ---------------- */
  function presets() {
    for (const p of PRESET.hide || []) document.body.classList.add("hide-" + p);
    if (PRESET.dim != null) document.documentElement.style.setProperty("--dim", PRESET.dim);
    return (s) => {
      if (PRESET.dimFrom == null) return;
      // night shift: dim from dimFrom until sunrise (6 am when the weather feed is down)
      const d = loc(s.t), hr = d.getHours() + d.getMinutes() / 60, w = s.weather;
      const rise = w && w.sunrise ? loc(w.sunrise).getHours() + loc(w.sunrise).getMinutes() / 60 : 6;
      document.body.classList.toggle("dimmed", hr >= PRESET.dimFrom || hr < rise);
    };
  }

  function fitStage() {
    const k = Math.max(innerWidth / 1512, innerHeight / 982);
    $("#stage").style.transform = `translate(${(innerWidth - 1512 * k) / 2}px, ${(innerHeight - 982 * k) / 2}px) scale(${k})`;
  }
  addEventListener("resize", fitStage);
  fitStage();
  panel();
  // README 8a.6b: a section runs only when what it reads has changed. Sticky blocks keep their
  // identity between lines, so comparing them is free; the second ticks the ages and
  // countdowns. Per line (at 100 ms, ten times a second) only the fast figures run: the
  // sessions, CPU and the systems page. Everything else runs at most once a second.
  function gate(fn, key) {
    let last = null;
    return (s, p) => {
      const k = key(s);
      if (last && k.every((v, i) => v === last[i])) return;
      last = k;
      fn(s, p);
    };
  }
  const sec = (s) => Math.floor(s.t), C_ = (s) => s.claude || {};
  // the user's preferences (Kiln.onPrefs): only the temperature unit matters here (one look,
  // Kiln.appearance is never read); it is text, so the parts that print one run again at once
  let prefsSeen = 0;
  const memGauge = PRESET.gauge === "memory";
  const parts = [
    gate(clock(), (s) => [sec(s), s.weather]),
    gate(wxText(), (s) => [s.weather, prefsSeen]),
    gate(lamps(), (s) => [sec(s), s.analytics, C_(s).limits, s.sys && s.sys.mem && s.sys.mem.pressure,
      (C_(s).sessions || []).map((x) => x.state + (x.ask ? "?" : "")).join()]),
    engines(),
    memGauge ? gauge() : gate(gauge(), (s) => [sec(s), C_(s).limits]),
    gate(tape(), (s) => [C_(s).tokens]),
    cpu(),
    gate(flow(), (s) => [C_(s).tokens]),
    systems(),
    gate(fuel(), (s) => [sec(s), C_(s).limits]),
    // the card turns 0.1° every 24 s and the heading box reads the minute
    gate(rose(), (s) => [Math.floor(s.t / 60), Math.floor(s.t / 24), s.analytics, C_(s).tokens]),
    gate(mix(), (s) => [sec(s), s.analytics]),
    gate(flightLog(), (s) => [sec(s), C_(s).events, C_(s).limits, logTop]),
    gate(presets(), (s) => [Math.floor(s.t / 60), s.weather]),
  ];

  // ?sim, dev replay only: the captured fixture has no running agents and predates
  // limits.week_points, so synthesize both from the line itself (two agents on the working
  // session; the week from limits.history, as the feed now records it) to check pods and the fuel plan.
  const hosted = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.kiln);
  let sim0 = null;
  function simulate(s) {
    const C = s.claude;
    if (!C) return;
    sim0 = sim0 || s.t;
    const add = {}, S = C.sessions || [], host = S.find((x) => x.state === "working") || S[0], lim = C.limits;
    if (host && !(C.agents_running || []).length) {
      const up = s.t - sim0;
      add.agents_running = [
        { id: "sim-a", sid: host.sid, session: host.name, type: "Explore", desc: "map the repo", started: sim0 - 2635, age_s: up + 2635, idle_s: up + 1320 },
        { id: "sim-b", sid: host.sid, session: host.name, type: "general-purpose", desc: "draft notes", started: sim0 - 95, age_s: up + 95, idle_s: 4 },
      ];
      add.sessions = S.map((x) => (x === host ? Object.assign({}, x, { agents_running: 2 }) : x));
    }
    if (lim && lim.seven_day && lim.seven_day.resets_at && !lim.week_points) {
      const ws = lim.seven_day.resets_at - WEEK, h = (lim.history || []).filter((row) => row[2] != null);
      const before = h.filter((row) => row[0] < ws).pop();
      add.limits = Object.assign({}, lim, { week_points: (before ? [[before[0], before[2], "prev"]] : []).concat(h.filter((row) => row[0] >= ws).map((row) => [row[0], row[2]])) });
    }
    s.claude = Object.assign({}, C, add);
  }
  const sim = !hosted && q.has("sim");

  let lines = 0;
  function run(s, prev) {
    let err = null;
    for (const u of parts) { try { u(s, prev); } catch (e) { err = err || e; } }
    if (err) throw err;   // the runtime reports it to the host
  }
  Kiln.on((s, prev) => {
    // the first line lands as is (no needle sweeping up from zero); later ones glide. A dev
    // still (?still) keeps every transition off, as the runtime lands its tweens for a shot.
    if (++lines === 2 && !q.has("still")) document.documentElement.classList.remove("boot");
    if (sim) simulate(s);
    run(s, prev);
  });
  Kiln.onPrefs(() => { prefsSeen++; if (Kiln.state) run(Kiln.state, null); });
})();
