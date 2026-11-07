// Glass Control Room, live. Every figure is computed from Kiln.state on each update: the v2
// concept's build_data.py, ported (month totals, medians, shares, countdowns, labels). "Now" is
// state.t, never the wall clock. Text is written only when its string changes.
//
// Motion (README 8a, measured): the page must idle between updates. So no figure, bar or chart
// is driven from JS per frame unless Kiln.glide is true (400 ms and slower), and then only text:
// - figures are set directly; at glide periods they tween through the runtime (Kiln.tweenMs);
// - bars, core capsules, the memory stack and chart heads take one transform per update and
//   glide on the compositor (CSS transition, var(--kiln-tween));
// - rolling charts redraw once per update and slide in by one compositor animation;
// - rings, the battery and SVG bars are SVG attributes, so they are written once per update.
(function () {
  "use strict";
  const Q = new URLSearchParams(location.search);
  const CFG = window.GLASS_CONFIG || {};
  const PRESET = Q.get("preset") || CFG.preset || "control";
  const SHARE = PRESET === "share";
  const GIB = 2 ** 30, WEEK = 7 * 86400, NB = " ";
  const $ = (id) => document.getElementById(id);
  let seq = 0;

  /* ---------------- writing to the page without churn ---------------- */
  function txt(e, s) { s = s == null ? "" : String(s); if (e._t !== s) { e._t = s; e.textContent = s; } }
  function html(e, s) { if (e._h !== s) { e._h = s; e.innerHTML = s; } }
  function attr(e, k, v) { v = String(v); const key = "_a_" + k; if (e[key] !== v) { e[key] = v; e.setAttribute(k, v); } }
  function css(e, k, v) { const key = "_s_" + k; if (e[key] !== v) { e[key] = v; e.style[k] = v; } }
  function refs(root) { const o = {}; root.querySelectorAll("[data-r]").forEach((e) => (o[e.dataset.r] = e)); return o; }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // A live figure. f returns a string or [figure, unit]. Below 400 ms it is set directly (a glide
  // could not be seen before the next value, and every glide frame repaints text); at 400 ms and
  // slower it glides through the runtime, which clamps it to Kiln.tweenMs. A tween from a value
  // to itself cancels any glide in flight and paints at once.
  function live(numEl, unitEl, f) {
    let cur = null;
    const key = "lv" + ++seq;
    const paint = (v) => {
      cur = v;
      const p = f(v);
      if (Array.isArray(p)) { txt(numEl, p[0]); if (unitEl) txt(unitEl, p[1]); } else txt(numEl, p);
    };
    return {
      set(v) {
        if (v == null || !isFinite(v)) { Kiln.tweenKey(key, 0, 0, () => {}); cur = null; txt(numEl, "–"); if (unitEl) txt(unitEl, ""); return; }
        Kiln.tweenKey(key, cur != null && Kiln.glide ? cur : v, v, paint);
      },
    };
  }
  // A freshly redrawn strip slides in from where its old drawing sat: one compositor animation
  // per update, Kiln.tweenMs long, the same ease as the CSS transitions; then it rests.
  const EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
  // At 200 ms and faster the compositor glides are switched off (.snap in index.html): a strip
  // redrawn ten times a second already scrolls by a fraction of a pixel per line.
  // The glass's grain (index.html, .glass): a 128 px tile shown at 64 css px, one speck per
  // device pixel, light and dark in equal measure so it adds tooth without shifting the tone.
  // Made once; a still image in every pane's background, never animated.
  (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const x = c.getContext("2d"), img = x.createImageData(128, 128), d = img.data;
    let r = 0x2f6b9d;
    for (let i = 0; i < d.length; i += 4) {
      r = (r * 1664525 + 1013904223) >>> 0;
      const v = r / 4294967296 - 0.5, light = v > 0 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = light;
      d[i + 3] = Math.round(Math.abs(v) * 2 * 15);   // at most 6 % per speck
    }
    x.putImageData(img, 0, 0);
    document.documentElement.style.setProperty("--grain", `url(${c.toDataURL()})`);
  })();
  const SNAP = () => Kiln.period <= 200;
  const snapClass = () => document.documentElement.classList.toggle("snap", SNAP());
  snapClass();
  Kiln.onPeriod(snapClass);
  function slideIn(el, dx) {
    if (Kiln.reduced || SNAP() || !(dx > 0.02) || !el.animate) return;
    el.animate([{ transform: `translate3d(${dx.toFixed(2)}px,0,0)` }, { transform: "translate3d(0,0,0)" }], { duration: Kiln.tweenMs, easing: EASE });
  }

  /* ---------------- formats (as build_data.py prints them) ---------------- */
  function compact(n, d = 1) {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(d + 1).replace(/\.?0+$/, "") + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(d).replace(/\.0+$/, "") + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : d).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
  }
  function parts(n, d = 1) { const s = compact(n, d), m = s.match(/^(-?[\d.]+)([kMB]?)$/); return m ? [m[1], m[2]] : [s, ""]; }
  // fixed decimals so a tween never flickers between "18.3" and "18.34"
  function partsFixed(n, d) {
    const a = Math.abs(n);
    if (a >= 1e9) return [(n / 1e9).toFixed(d + 1), "B"];
    if (a >= 1e6) return [(n / 1e6).toFixed(d), "M"];
    if (a >= 1e3) return [(n / 1e3).toFixed(1), "k"];
    return [String(Math.round(n)), ""];
  }
  // At most three figures ("9.9", "99", "999"), so a 1.8em slot holds every rate. The bounds sit
  // where rounding would carry: 999.6 B/s is "1.0 KB/s", never "1000 B/s".
  function bytes(b) {
    b = Math.max(0, b || 0);
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let i = 0;
    while (i < 3 && b >= 999.5) { b /= 1e3; i++; }
    return [i && b < 9.95 ? b.toFixed(1) : String(Math.round(b)), units[i]];
  }
  // a fixed, right-aligned slot for a changing figure (README rule 13); widths live in the CSS
  const slot = (r, cls = "") => `<i class="slot ${cls}" data-r="${r}"></i>`;
  // a duration whose trailing counts sit in two-digit slots: "3 h  9 m" and "3 h 10 m" are one
  // width. The leading count stays bare: it changes digit count rarely, and a slot there only
  // opened a gap ("done   4 h").
  const durSlots = (s, two = true) => { let k = 0; return esc(dur(s, two)).replace(/\d+/g, (n) => (k++ ? `<i class="d2">${n}</i>` : n)); };
  // one decimal under 10, none from 10 up: "9.9" and "12" take one 3-figure slot
  const f3 = (v) => (v < 9.95 ? v.toFixed(1) : String(Math.round(v)));
  // 6 d 22 h / 1 h 25 m / 6 m 46 s, joined with no-break spaces so it never wraps
  function dur(s, two = true) {
    s = Math.max(0, Math.round(s));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const out = d ? [[d, "d"], [h, "h"], [m, "m"]] : h ? [[h, "h"], [m, "m"]] : m ? [[m, "m"], [x, "s"]] : [[x, "s"]];
    return (two ? out : out.slice(0, 1)).map(([v, u]) => v + NB + u).join(NB);
  }
  function mclock(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), x = s % 60;
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
  }
  const hm = (t) => Kiln.fmt.clock(t).replace(" ", NB);
  const int = (n) => Math.round(n).toLocaleString("en-US");
  function dayname(t) {
    const d = new Date(t * 1000);
    return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })}`;
  }
  const model = (m) => { const x = /claude-([a-z]+)/.exec(m || ""); return x ? x[1][0].toUpperCase() + x[1].slice(1) : m || ""; };
  function niceStep(v) { const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }
  function scale(max, n) { const st = niceStep(Math.max(max, 1e-6) / n); const top = Math.max(st, Math.ceil(max / st - 1e-9) * st); const grid = []; for (let v = 0; v <= top + st / 1e6; v += st) grid.push(v); return { top, grid }; }
  const axisK = (v) => (v === 0 ? "0" : v >= 1e6 ? +(v / 1e6).toFixed(1) + "M" : v >= 1e3 ? +(v / 1e3).toFixed(1) + "k" : String(+v.toFixed(1)));

  // Monotone cubic (Fritsch-Carlson): smooth, never overshoots the data.
  function smooth(pts) {
    const n = pts.length;
    if (n < 2) return n ? `M${pts[0][0]},${pts[0][1]}` : "";
    const dx = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0] || 1e-6); m.push((pts[i + 1][1] - pts[i][1]) / dx[i]); }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
    t.push(m[n - 2]);
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + t[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
    }
    return d;
  }
  const poly = (pts) => pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join("");
  // how many segments of a trace (points in x order) pass through the box x0..x1, y0..y1?
  // Each segment is clipped to the box's x span and its y range tested; 0 means clear. Pad
  // the box for a smoothed curve.
  function traceNear(pts, x0, x1, y0, y1) {
    let n = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      if (bx < x0 || ax > x1) continue;
      const k = (x) => ay + ((by - ay) * (Math.min(Math.max(x, ax), bx) - ax)) / (bx - ax || 1);
      const ya = k(x0), yb = k(x1);
      if (Math.max(ya, yb) >= y0 && Math.min(ya, yb) <= y1) n++;
    }
    return n;
  }
  // The label of a chart's average line, kept off the data (2026-11-05: it sat on the trace
  // and the endpoint dot). slots: [start x, below the line] in order of preference. It keeps
  // its slot while that stays clear, else takes the first clear one; it jumps between fixed
  // slots, never slides (rule 13). With no clear slot it takes the least crossed one and a
  // chip in the pane's tone (--halo) goes behind it, so the trace passes under a plate rather
  // than through the glyphs. Returns [slot index, chip?].
  function placeAvg(cur, slots, cost) {
    const c = slots.map(cost);
    if (c[cur] === 0) return [cur, false];
    const k = c.indexOf(0);
    if (k >= 0) return [k, false];
    let m = 0;
    c.forEach((v, i) => { if (v < c[m]) m = i; });
    return [m, true];
  }

  // Screen-share preset: names and words go, figures stay.
  const names = new Map();
  const hide = (s, what) => { if (!SHARE) return s; if (!names.has(what + s)) names.set(what + s, `${what} ${names.size + 1}`); return names.get(what + s); };

  const STATE = {
    waiting: { c: "var(--claude)", label: "Waiting on you" },
    failed: { c: "var(--alert)", label: "Failed" },
    working: { c: "var(--ok)", label: "Working" },
    // state "background": the session's own turn is over and its agents still run. "Background"
    // read as a background session (the "bg" tag means that), so the label says what it is.
    background: { c: "var(--machine)", label: "Agents running" },
    idle: { c: "var(--idle)", label: "Idle" },
  };
  const ORDER = ["waiting", "failed", "working", "background", "idle"];
  // How to count sessions (README): the headline counts interactive sessions (open in a
  // terminal); kind "bg" (hosted by the daemon, no window) is counted apart, with its real
  // state. A missing kind is interactive. Idle is never "running".
  const isBg = (x) => x.kind === "bg";
  const WORD = { waiting: "waiting on you", failed: "failed", working: "working", background: "with agents running", idle: "idle" };
  const stateOf = (x) => (STATE[x.state] ? x.state : "idle");
  function tally(list) {
    const c = {};
    list.forEach((x) => (c[stateOf(x)] = (c[stateOf(x)] || 0) + 1));
    return ORDER.filter((k) => c[k]).map((k) => [k, c[k]]);
  }
  function bgNote(bg) {
    if (!bg.length) return "";
    const by = tally(bg);
    return by.length === 1 ? `${bg.length} in the background, ${WORD[by[0][0]]}`
      : `${bg.length} in the background: ${by.map(([k, n]) => `${n} ${WORD[k]}`).join(", ")}`;
  }

  // Rows keyed by id, placed by transform; arrivals fade in, departures fade out, the rest slide.
  function keyed(box, items, keyOf, make, update, slotH, max) {
    const map = box._map || (box._map = new Map());
    const seen = new Set();
    items.slice(0, max).forEach((it, i) => {
      const k = keyOf(it);
      seen.add(k);
      let r = map.get(k);
      const y = `translate3d(0,${i * slotH}px,0)`;
      if (!r) {
        r = make(it);
        r.el.classList.add("row");
        css(r.el, "transform", y);
        box.appendChild(r.el);
        map.set(k, r);
        // fades by Web Animations: no forced layout to start a transition, no frames from JS
        if (!Kiln.reduced && r.el.animate) r.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease" });
      }
      css(r.el, "transform", y);
      update(r, it, i);
    });
    for (const [k, r] of map) {
      if (seen.has(k)) continue;
      map.delete(k);
      if (Kiln.reduced || !r.el.animate) { r.el.remove(); continue; }
      r.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "ease", fill: "forwards" }).onfinish = () => r.el.remove();
    }
  }

  /* ================= left wing ================= */

  /* ---- weekly limit: the ring is the week itself ---- */
  function mountLimit() {
    const root = $("limit");
    root.innerHTML = `<div class="hd"><h2>Weekly limit</h2><span class="aside k" data-r="fivebox" style="display:none;gap:6px;align-items:center"><span class="dot" style="background:var(--mute);width:6px;height:6px"></span><span data-r="five"></span></span></div>
      <div class="limit">
        <div style="margin-top:2px"><svg width="168" height="168" viewBox="0 0 168 168">
          <defs><linearGradient id="ringGrad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" style="stop-color:var(--claude-deep)"/><stop offset="1" style="stop-color:var(--claude)"/></linearGradient></defs>
          <circle cx="84" cy="84" r="68" fill="none" class="s-track" stroke-width="10"/>
          <circle cx="84" cy="84" r="68" fill="none" stroke="url(#ringGrad)" stroke-width="10" stroke-linecap="round" transform="rotate(-90 84 84)" data-r="arc"/>
          <g data-r="days"></g>
          <circle cx="84" cy="84" r="58" fill="none" class="s-ink" stroke-width="3" stroke-linecap="round" transform="rotate(-90 84 84)" opacity="0.9" data-r="elapsed"/>
          <text x="84" y="94" text-anchor="middle" class="ringnum"><tspan data-r="pct"></tspan><tspan class="ringunit" dx="2" dy="-21">%</tspan></text>
          <text x="84" y="114" text-anchor="middle" class="ringcap" data-r="cap"></text>
        </svg></div>
        <div class="facts">
          <div class="fact"><span class="k">Resets</span><div class="big" data-r="reset"></div><div class="note" data-r="resetIn"></div></div>
          <div class="fact"><span class="k">Burn rate, recent</span><div class="big num"><span data-r="burn"></span><small>% per hour</small></div><div class="note" data-r="forecast"></div></div>
          <div><svg width="300" height="66" data-r="hist"></svg></div>
        </div>
      </div>`;
    const R = refs(root);
    const C68 = 2 * Math.PI * 68, C58 = 2 * Math.PI * 58;
    const pct = live(R.pct, null, (v) => String(Math.round(v)));
    // the arcs are SVG dashes: written once per update (and only when the string changes)
    const arc = { set: (v) => attr(R.arc, "stroke-dasharray", `${(Math.max(0.4, Math.min(100, v)) / 100 * C68).toFixed(2)} ${C68.toFixed(2)}`) };
    const el = { set: (v) => attr(R.elapsed, "stroke-dasharray", `${(Math.max(0.006, v) * C58).toFixed(2)} ${C58.toFixed(2)}`) };
    let daysKey = "", histKey = "";
    // the facts column's width (522 wing - 2 x 16 padding - 168 ring - 20 gap), and a canvas
    // to measure a note in the note's own font: no layout read in the update path
    const NOTE_W = 302, MC = document.createElement("canvas").getContext("2d"), noteW = new Map();
    let noteFont = "";
    function fitNote(cands) {
      if (!noteFont) { const cs = getComputedStyle(R.forecast); noteFont = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; }
      const ready = !document.fonts || document.fonts.status === "loaded";
      for (const c of cands) {
        let w = noteW.get(c);
        if (w == null) { MC.font = noteFont; w = MC.measureText(c).width; if (ready) noteW.set(c, w); }
        if (w <= NOTE_W - 2) return c;
      }
      return cands[cands.length - 1];
    }
    return (s) => {
      const lim = s.claude && s.claude.limits;
      const sd = lim && lim.seven_day;
      if (!sd) return;
      const t = s.t, reset = sd.resets_at, start = reset - WEEK, five = lim.five_hour;
      // the five-hour window only while Claude Code reports a live one (the plan has none since
      // 2026-10-30): otherwise nothing at all, no "not reported" footnote and never a 0%
      const live5 = !!(five && five.pct != null && !five.stale);
      const fd = live5 ? "flex" : "none";
      if (R.fivebox.style.display !== fd) R.fivebox.style.display = fd;
      txt(R.five, live5 ? `Five-hour window ${Math.round(five.pct)}%${five.resets_at ? ", resets in " + dur(five.resets_at - t) : ""}` : "");
      pct.set(sd.pct);
      arc.set(sd.pct);
      el.set(Math.min(1, Math.max(0, (t - start) / WEEK)));
      txt(R.cap, `used, ${dur(t - start)} in`);
      if (daysKey !== String(reset)) {
        daysKey = String(reset);
        let g = "";
        const c = 84, Rr = 68;
        for (let i = 0; i < 7; i++) {
          const a = ((i / 7) * 360 - 90) * (Math.PI / 180);
          if (i > 0) g += `<line x1="${c + Math.cos(a) * (Rr - 5)}" y1="${c + Math.sin(a) * (Rr - 5)}" x2="${c + Math.cos(a) * (Rr + 5)}" y2="${c + Math.sin(a) * (Rr + 5)}" style="stroke:var(--glass)" stroke-width="2.5"/>`;
          const am = (((i + 0.5) / 7) * 360 - 90) * (Math.PI / 180);
          const L = new Date((start + i * 86400 + 43200) * 1000).toLocaleDateString("en-US", { weekday: "narrow" });
          g += `<text x="${(c + Math.cos(am) * (Rr + 12)).toFixed(1)}" y="${(c + Math.sin(am) * (Rr + 12) + 3.5).toFixed(1)}" text-anchor="middle" class="axis">${L}</text>`;
        }
        // where forecasting begins, 12 h into the week
        const fa = ((43200 / WEEK) * 360 - 90) * (Math.PI / 180);
        g += `<line x1="${c + Math.cos(fa) * (Rr - 13)}" y1="${c + Math.sin(fa) * (Rr - 13)}" x2="${c + Math.cos(fa) * (Rr - 7)}" y2="${c + Math.sin(fa) * (Rr - 7)}" class="s-claude" stroke-width="1.5"/>`;
        R.days.innerHTML = g;
        html(R.reset, `${dayname(reset)},${NB}<small style="margin:0">${hm(reset)}</small>`);
      }
      txt(R.resetIn, `in ${dur(reset - t)}`);
      txt(R.burn, sd.burn_per_h == null ? "–" : sd.burn_per_h.toFixed(1));
      // pace and projection are null until 12 h after the reset: say so, never draw a pace line
      if (sd.pace == null || sd.projected == null) {
        const fat = start + 43200;
        txt(R.forecast, t < fat ? `No forecast until ${dayname(fat)}, ${hm(fat)}, 12 h in.` : "No forecast reported yet.");
      } else {
        // One line in a fixed slot (the facts column, 302 px, which no longer grows with its
        // text): "…; runs out Sat 7 Nov, 3:20 am." ran onto the card's edge (2026-11-05). The
        // longest wording that fits is used, measured off-layout.
        const P = Math.round(sd.projected), r = sd.runout_at;
        txt(R.forecast, !r ? `On pace for ${P}% at the reset.` : fitNote([
          `On pace for ${P}% at the reset; runs out ${dayname(r)}, ${hm(r)}.`,
          `On pace for ${P}%; runs out ${dayname(r)}, ${hm(r)}.`,
          `On pace for ${P}%; runs out ${new Date(r * 1000).toLocaleDateString("en-US", { weekday: "short" })} ${hm(r)}.`,
        ]));
      }
      // the history the feed really holds: last week closing, the reset, the new week climbing
      const hist = (lim.history || []).filter((h) => h[2] != null).map((h) => ({ t: h[0], pct: h[2] }));
      const hk = hist.length + "|" + (hist.length ? hist[0].t : 0) + "|" + sd.pct + "|" + Math.floor(t / 20);
      if (hk !== histKey) { histKey = hk; R.hist.innerHTML = limitHistory(hist, sd, t, start); }
    };
  }
  function limitHistory(hist, sd, now, resetT) {
    const HW = 300, HH = 66, pl = 30, pt = 6, pb = 16;
    const pts = hist.filter((p) => p.t < now).concat([{ t: now, pct: sd.pct }]);
    const t0 = pts[0].t, t1 = now;
    if (t1 - t0 < 300) return `<text x="${pl}" y="30" class="axis">History starts with the next reading.</text>`;
    const hx = (t) => pl + ((t - t0) / (t1 - t0)) * (HW - pl - 8), hy = (p) => pt + (1 - Math.min(100, p) / 100) * (HH - pt - pb);
    let g = "";
    for (const v of [0, 50, 100]) g += `<line x1="${pl}" x2="${HW - 8}" y1="${hy(v)}" y2="${hy(v)}" class="${v ? "g1" : "g0"}"/><text x="${pl - 6}" y="${hy(v) + 3.5}" text-anchor="end" class="axis">${v}%</text>`;
    const path = (ps) => ps.map((p, i) => `${i ? "L" : "M"}${hx(p.t).toFixed(1)},${hy(p.pct).toFixed(1)}`).join("");
    const inRange = resetT > t0 && resetT < t1;
    const pre = inRange ? pts.filter((p) => p.t < resetT) : [], post = inRange ? pts.filter((p) => p.t >= resetT) : pts;
    if (inRange) {
      g += `<line x1="${hx(resetT)}" x2="${hx(resetT)}" y1="${hy(100) - 2}" y2="${hy(0)}" class="s-ink" opacity="0.45" stroke-dasharray="2 3"/>`;
      if (pre.length) {
        const lc = pre[pre.length - 1];
        g += `<path d="${path(pre)}L${hx(resetT)},${hy(lc.pct)}" class="s-claude" opacity="0.55" stroke-width="1.8" fill="none"/>`;
        // the label ends left of the point, on last week's side; when that side is too narrow it
        // hangs just past the reset line, where the new week has not climbed yet. It used to
        // start at the point and straddle the dashed line.
        const lx = hx(lc.t), rx = hx(resetT), after = lx - 5 - 80 < pl - 4;
        g += `<circle cx="${lx}" cy="${hy(lc.pct)}" r="2.6" class="f-claude" opacity="0.8"/><text x="${(after ? rx + 5 : lx - 5).toFixed(1)}" y="${hy(lc.pct) + 13}" text-anchor="${after ? "start" : "end"}" class="axis peak">${lc.pct}% at ${hm(lc.t)}</text>`;
      }
      g += `<path d="M${hx(resetT)},${hy(0)}${path(post).replace(/^M/, "L")}" class="s-claude" stroke-width="2.2" fill="none" stroke-linejoin="round"/>`;
    } else g += `<path d="${path(post)}" class="s-claude" stroke-width="2.2" fill="none" stroke-linejoin="round"/>`;
    g += `<circle cx="${hx(t1)}" cy="${hy(sd.pct)}" r="3.4" class="f-mark"/><text x="${hx(t1)}" y="${hy(sd.pct) - 7}" text-anchor="end" class="axis hi">${sd.pct}%</text>`;
    g += `<text x="${pl}" y="${HH - 2}" class="axis">${hm(t0)}</text>`;
    if (inRange && hx(resetT) - pl > 70 && HW - 8 - hx(resetT) > 50) g += `<text x="${hx(resetT)}" y="${HH - 2}" text-anchor="middle" class="axis">reset ${hm(resetT)}</text>`;
    return g + `<text x="${HW - 8}" y="${HH - 2}" text-anchor="end" class="axis">now</text>`;
  }

  /* ---- needs you: the one attention moment ---- */
  function mountNeeds() {
    const root = $("needs");
    root.innerHTML = `<div class="needs"><svg class="icon" viewBox="0 0 44 44" data-r="icon"></svg><div style="min-width:0"><div class="state" data-r="state"></div><div class="sub" data-r="sub"></div></div></div>`;
    const R = refs(root);
    let mode = "";
    const C = 2 * Math.PI * 18.25;
    let ringA = null, mins = null;
    return (s) => {
      const t = s.t, C_ = s.claude || {}, A = s.analytics || {};
      const waiting = (C_.sessions || []).filter((x) => x.state === "waiting");
      const aw = A.ask_wait || {};
      const median = aw.median_s;
      root.classList.toggle("warm", waiting.length > 0);
      if (waiting.length) {
        if (mode !== "wait") {
          mode = "wait";
          R.icon.innerHTML = `<circle cx="22" cy="22" r="18.25" fill="none" class="s-track" stroke-width="3.5"/><circle cx="22" cy="22" r="18.25" fill="none" class="s-claude" stroke-width="3.5" stroke-linecap="round" transform="rotate(-90 22 22)" data-r="ra"/><text x="22" y="26.5" text-anchor="middle" class="axis hi" style="font-size:12.5px" data-r="rm"></text>`;
          const r2 = refs(R.icon);
          ringA = { set: (v) => attr(r2.ra, "stroke-dasharray", `${(Math.max(0.02, Math.min(1, v)) * C).toFixed(2)} ${C.toFixed(2)}`) };
          mins = r2.rm;
        }
        const w = waiting.slice().sort((a, b) => a.since - b.since)[0];
        const waited = t - w.since;
        // the ring fills toward your median answer time
        ringA.set(median ? waited / median : 0);
        txt(mins, waited < 3600 ? Math.floor(waited / 60) + "m" : Math.floor(waited / 3600) + "h");
        txt(R.state, waiting.length > 1 ? `${waiting.length} sessions are waiting on you` : `${hide(w.name, "Session")} is waiting on you`);
        // the ask's text (a subagent's too, since 2026-11-05); "" when the feed could not find it
        const ask = w.ask, atx = ask ? String(ask.text || "").trim() : "";
        const from = ask && ask.agent_type && !SHARE ? `, from ${esc(ask.agent_type)}` : "";
        const what = !ask ? "" : SHARE || !atx ? `${ask.kind === "question" ? "A question" : "Permission for " + esc(ask.tool || "a tool")}${from}. ` :
          ask.kind === "question" ? `<b>Asks${from}:</b> ${esc(atx.replace(/[.?!]?$/, (m) => m || "?"))} ` : `<b>${esc(ask.tool)}${from}:</b> ${esc(atx.replace(/\.?$/, "."))} `;
        html(R.sub, `${what}Waiting <b>${dur(waited)}</b>${median ? `; your median is ${dur(median)}` : ""}.`);
        return;
      }
      if (mode !== "ok") {
        mode = "ok";
        R.icon.innerHTML = `<circle cx="22" cy="22" r="18.25" fill="none" class="s-ok" stroke-width="3.5"/><path d="M14,23 l6,6 l11,-12.5" fill="none" class="s-ok" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      txt(R.state, "Nothing is waiting on you");
      const ev = C_.events || [];
      let last = null;
      for (let i = ev.length - 1; i >= 0; i--) if (ev[i].kind === "ask") { last = ev[i]; break; }
      const med = median ? `your median is ${dur(median)}` : "";
      if (!last) { html(R.sub, aw.count ? `No asks in the recent log. Over ${aw.count} asks, ${med}.` : "No asks in the recent log."); return; }
      const ans = ev.find((e) => e.kind === "answered" && e.t >= last.t && (e.sid === last.sid || e.name === last.name));
      const after = ans && /(\d+(?:\.\d+)?)\s*s/.exec(ans.detail || "");
      const what = SHARE ? "" : (last.detail || "").replace(/^perm\s+/, "run ");
      html(R.sub, `Last ask: <b>${esc(hide(last.name, "Session"))}</b>${what ? ", " + esc(what) : ""}, ${hm(last.t)}. ` +
        (after ? `Answered in <b>${dur(+after[1])}</b>${med ? "; " + med : ""}.` : med ? `${med[0].toUpperCase() + med.slice(1)}.` : ""));
    };
  }

  /* ---- sessions ---- */
  // Sessions' height in the left wing; Agents fills the rest (index.html, .wing.left)
  let leftSplit = 268;
  const LEFT_REST = 928 - 3 * 10 - 262 - 74;   // the two panes' share of the wing: 562
  function mountSessions() {
    const root = $("sessions");
    root.innerHTML = `<div class="hd"><h2>Sessions</h2><span class="aside" data-r="sum"></span></div>
      <div class="scol k"><span></span><span data-r="ctxh"></span><span class="rate"><span>15 min</span><span data-r="peakh"></span></span><span style="text-align:right">Ag.</span></div>
      <div class="rows" data-r="rows" style="height:192px"></div>`;
    const R = refs(root);
    const make = () => {
      const e = document.createElement("div");
      e.innerHTML = `<div class="srow">
        <div style="min-width:0"><div class="sname" data-r="name"></div><div class="smeta"><span class="bgk" data-r="bgk">bg</span><span class="dot" data-r="dot"></span><span data-r="st"></span><span data-r="model"></span><span data-r="for"></span></div></div>
        <div><div class="cnum num">${slot("ctx", "ctxv")}<small data-r="ctxp"></small></div><div class="bar"><i data-r="bar"></i></div></div>
        <div class="rate"><div class="cnum num">${slot("o", "ov")}<small class="u1" data-r="ou"></small></div><svg width="88" height="24" viewBox="0 0 88 24"><path data-r="fa" stroke="none" fill-opacity="0.22"/><path data-r="ln" fill="none" stroke-width="1.5" stroke-linecap="round"/></svg></div>
        <div class="cnum num" style="text-align:right" data-r="ag"></div></div>
        <div class="sdet"><div style="min-width:0"><span class="k">Its agents now</span><div class="dv" data-r="sag"></div></div>
          <div><span class="k">Process</span><div class="dv num">${slot("pc", "ov")}<small>% CPU</small></div></div>
          <div><span class="k">Memory</span><div class="dv num"><span class="memv">${slot("pm", "pmv")}<small class="u2" data-r="pmu"></small></span><small data-r="up"></small></div></div></div>`;
      const r = refs(e);
      return { el: e, r, ctx: live(r.ctx, null, (v) => compact(v, 0)), o: live(r.o, r.ou, (v) => (v < 1 ? ["0", ""] : parts(v))),
        bar: { set: (v) => css(r.bar, "transform", `scaleX(${Math.min(1, v / 100).toFixed(4)})`) }, sk: "" };
    };
    // the session's own process, as the feed reports it: three figures, MB under a gigabyte
    const rss = (b) => (b == null ? ["–", ""] : b < 999.5e6 ? [String(Math.round(b / 1e6)), "MB"] : [f3(b / 1e9), "GB"]);
    // its running agents by type, the most common first: "tester, builder, 4 designer"
    let agentsBy = new Map();
    const agentLine = (sid) => {
      const by = agentsBy.get(sid);
      if (!by) return "None running";
      return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => (n > 1 ? `${n} ${k}` : k)).join(", ");
    };
    let peak = 1, now = 0;
    const wing = root.parentElement;
    wing.addEventListener("transitionend", (e) => { if (e.target === wing && window.GlassSky) GlassSky.layout(); });
    const update = (row, x) => {
      const r = row.r, st = STATE[x.state] || STATE.idle;
      txt(r.name, hide(x.name, "Session"));
      css(r.bgk, "display", isBg(x) ? "" : "none");
      css(r.dot, "background", st.c); css(r.dot, "boxShadow", `0 0 6px ${st.c}`);
      txt(r.st, st.label); css(r.st, "color", st.c);
      txt(r.for, x.since ? "for " + dur(now - x.since, false) : "");
      txt(r.model, model(x.model));
      row.ctx.set(x.ctx_tokens);
      txt(r.ctxp, x.ctx_pct == null ? "" : Math.round(x.ctx_pct) + "%");
      row.bar.set(x.ctx_pct || 0);
      row.o.set(x.out_15m || 0);
      txt(r.ag, x.agents_running || 0);
      txt(r.sag, agentLine(x.sid));
      txt(r.pc, x.cpu == null ? "–" : f3(x.cpu));
      const [mv, mu] = rss(x.rss);
      txt(r.pm, mv); txt(r.pmu, mu);
      txt(r.up, x.up_s == null ? "" : `up ${dur(x.up_s, false)}`);
      const ser = x.out_per_min || [], key = ser.join(",") + "|" + peak;
      if (key !== row.sk) {
        row.sk = key;
        const pts = ser.map((v, i) => [(i / Math.max(1, ser.length - 1)) * 88, 23 - (v / peak) * 22]);
        const d = smooth(pts);
        const on = (x.out_15m || 0) > 0 ? "claude" : "mute";
        attr(r.ln, "d", d); attr(r.ln, "class", "s-" + on);
        attr(r.fa, "d", d ? `${d}L88,24L0,24Z` : ""); attr(r.fa, "class", "f-" + on);
      }
    };
    return (s) => {
      const all = (s.claude && s.claude.sessions) || [];
      now = s.t;
      // interactive first, then background; each keeps the feed's order
      const open = all.filter((x) => !isBg(x)), bg = all.filter(isBg), list = open.concat(bg);
      const other = (s.claude && s.claude.sessions_other) || 0;
      const sum = tally(open).map(([k, n]) => `${n} ${WORD[k]}`).join(", ");
      const head = open.length ? `${open.length} open: ${sum}` : "None open";
      const back = bgNote(bg);
      txt(R.sum, list.length ? `${head}${back ? `; ${open.length ? "+" : ""}${back}` : ""}${other ? `, ${other} more elsewhere` : ""}` : "None open");
      // every sparkline shares one scale, so its top is printed once in the column head
      peak = Math.max(1, ...list.flatMap((x) => x.out_per_min || [0]));
      txt(R.peakh, `hour, to ${compact(peak)}`);
      const win = list.length && list.every((x) => x.ctx_window === list[0].ctx_window) ? list[0].ctx_window : null;
      txt(R.ctxh, win ? `Context of ${compact(win, 0)}` : "Context");
      // four rows fit; if more are open, the ones that need you come first
      const shown = list.length > 4 ? list.slice().sort((a, b) => isBg(a) - isBg(b) || ORDER.indexOf(stateOf(a)) - ORDER.indexOf(stateOf(b))).slice(0, 4) : list;
      const keep = list.filter((x) => shown.includes(x));
      // two or fewer: each row opens to a second band (its agents, its process), so the pane
      // holds what the feed knows about them instead of empty glass; three or four stay compact
      agentsBy = new Map();
      for (const a of (s.claude && s.claude.agents_running) || []) {
        const m = agentsBy.get(a.sid) || new Map();
        m.set(a.type || "agent", (m.get(a.type || "agent") || 0) + 1);
        agentsBy.set(a.sid, m);
      }
      const roomy = keep.length <= 2;
      if (R.rows._roomy !== roomy) { R.rows._roomy = roomy; R.rows.classList.toggle("roomy", roomy); }
      // the pane is as tall as its rows (header 62 + rows + foot 14); Agents gets the rest
      const sh = roomy ? 76 + Math.max(1, keep.length) * 96 : 76 + keep.length * 48;
      if (sh !== leftSplit) {
        leftSplit = sh;
        wing.style.setProperty("--sh", sh + "px");
        // the frost is cut to the panes' outlines: recut now, and again when the glide ends
        if (window.GlassSky) GlassSky.layout();
      }
      keyed(R.rows, keep, (x) => x.sid, make, update, roomy ? 96 : 48, 4);
    };
  }

  /* ---- agents: who is running, and who has been spawned ---- */
  function mountAgents() {
    const root = $("agents");
    root.innerHTML = `<div class="hd"><h2>Agents</h2><span class="aside" data-r="sum"></span></div>
      <div class="rows" data-r="rows" style="height:92px"></div>
      <div class="spawns">
        <div class="share" style="margin-top:0"><span class="k" style="color:var(--ink-2)">Spawned today <b class="v num" data-r="nt"></b></span><div class="sharebar" data-r="bt"></div></div>
        <div class="share"><span class="k" style="color:var(--ink-2)">In 14 days <b class="v num" data-r="n14"></b></span><div class="sharebar" data-r="b14"></div></div>
        <div class="legend" data-r="legend"></div>
        <div class="flag" data-r="flag"></div>
      </div>`;
    const R = refs(root);
    const make = (a) => {
      const e = document.createElement("div");
      e.innerHTML = `<div class="arow"><div class="atype"><span class="dot" data-r="dot"></span><span data-r="type"></span><span class="k" data-r="in"></span></div>
        <div class="age num" data-r="age"></div><div class="adesc" data-r="desc"></div><div class="k" style="text-align:right;white-space:nowrap" data-r="act"></div></div>`;
      return { el: e, r: refs(e) };
    };
    let now = 0, compact = false;
    const update = (row, a) => {
      const r = row.r;
      if (row.c !== compact) { row.c = compact; row.el.firstElementChild.classList.toggle("c", compact); }
      // finished agents fill the spare two-line slots: dimmed, each with when it finished
      // (review, 2026-11-05: fine to keep, as long as each says how long ago it was done)
      if (a.done || a.none) {
        // dim the content, not the row: the row's own opacity is its enter/leave fade
        row.el.firstElementChild.style.opacity = a.none ? "" : "0.72";
        css(r.dot, "background", "var(--mute)");
        txt(r.type, a.none ? "No agents running" : a.type);
        txt(r.in, a.none ? "" : "in " + a.name);
        txt(r.age, a.none ? "" : hm(a.t));
        txt(r.desc, a.none ? "None finished in the recent log" : SHARE ? "Task hidden" : a.desc);
        html(r.act, a.none ? "" : `done ${durSlots(now - a.t)} ago`);
        return;
      }
      row.el.firstElementChild.style.opacity = "";
      const gp = a.type === "general-purpose";
      css(r.dot, "background", gp ? "var(--claude)" : "var(--agent)");
      txt(r.type, a.type);
      txt(r.in, "in " + hide(a.session || a.sid, "Session"));
      const start = a.started != null ? a.started : a.start != null ? a.start : now - (a.age_s || 0);
      const idle = a.last != null ? now - a.last : a.idle_s || 0;
      txt(r.age, mclock(now - start));
      txt(r.desc, SHARE ? "Task hidden" : a.desc || "");
      html(r.act, idle > 120 ? `idle ${durSlots(idle, false)}` : "active");
    };
    const COLS = ["var(--machine)", "var(--agent)", "var(--ok)"];
    let shareKey = "";
    return (s) => {
      now = s.t;
      const C_ = s.claude || {}, A = s.analytics || {};
      const names = {};
      (C_.sessions || []).forEach((x) => (names[x.sid] = x.name));
      const list = (C_.agents_running || []).map((a) => Object.assign({ session: a.session || names[a.sid] }, a))
        .sort((a, b) => (a.started || a.start || 0) - (b.started || b.start || 0));
      // As many rows as the pane holds under its header and above the spawn block (181 px of
      // fixed chrome), from the split Sessions set: two-line rows while they fit, one-line rows
      // when more are running, and spare two-line slots go to the last agents to finish.
      const area = LEFT_REST - leftSplit - 181;
      const cap2 = Math.max(1, Math.floor(area / 46)), capC = Math.max(1, Math.floor(area / 23));
      const finished = (n) => (C_.events || []).filter((e) => e.kind === "agent_done").slice(-n).reverse().map((e) => {
        const i = (e.detail || "").indexOf(":");
        return { done: true, key: "d" + e.t + e.detail, t: e.t, name: hide(e.name, "Session"),
          type: i > 0 ? e.detail.slice(0, i) : "agent", desc: i > 0 ? e.detail.slice(i + 1).trim() : "" };
      });
      if (list.length) {
        compact = list.length > cap2;
        const n = compact ? Math.min(list.length, capC) : list.length;
        const back = compact ? [] : finished(cap2 - n);
        const where = new Set(list.map((a) => a.sid)).size;
        const sess = where === 1 ? `, all in ${hide(list[0].session || list[0].sid, "Session")}` : `, in ${where} sessions`;
        txt(R.sum, n < list.length ? `${list.length} running now, the ${n} longest shown`
          : compact ? `${list.length} running now${sess}` : `${list.length} running now${back.length ? "; then the last to finish" : ""}`);
        keyed(R.rows, list.slice(0, n).concat(back), (a) => a.key || a.id, make, update, compact ? 23 : 46, compact ? capC : cap2);
      } else {
        compact = false;
        const done = finished(cap2);
        txt(R.sum, done.length ? "None running; the last to finish" : "None running");
        keyed(R.rows, done.length ? done : [{ none: true, key: "none" }], (a) => a.key, make, update, 46, cap2);
      }
      // spawn share: today against the 14-day mix, same colours, general-purpose in sodium
      const sp = A.spawns || {}, d14 = sp.d14 || {}, td = sp.today || {};
      const tot14 = Object.values(d14).reduce((x, y) => x + y, 0), totT = Object.values(td).reduce((x, y) => x + y, 0);
      const kinds = Object.keys(d14).sort((a, b) => d14[b] - d14[a]).filter((k) => k !== "general-purpose");
      const top = (d14["general-purpose"] || td["general-purpose"] ? ["general-purpose"] : []).concat(kinds).slice(0, 4);
      const col = {}; let ci = 0;
      top.forEach((k) => (col[k] = k === "general-purpose" ? "var(--claude)" : COLS[ci++ % COLS.length]));
      col.other = "var(--mute)";
      const segs = (m, total) => top.map((k) => [k, m[k] || 0]).concat([["other", total - top.reduce((a, k) => a + (m[k] || 0), 0)]]);
      const key = JSON.stringify([d14, td]);
      if (key !== shareKey) {
        shareKey = key;
        const bar = (m, total) => total ? segs(m, total).filter(([, n]) => n > 0).map(([k, n]) =>
          `<i style="width:calc(${((n / total) * 100).toFixed(2)}% - 2px);background:${col[k]}">${n / total > 0.07 ? n : ""}</i>`).join("") : "";
        html(R.bt, bar(td, totT)); html(R.b14, bar(d14, tot14));
        html(R.legend, top.concat(["other"]).map((k) => `<span><span class="dot" style="background:${col[k]}"></span>${esc(k)}</span>`).join(""));
        txt(R.nt, int(totT)); txt(R.n14, int(tot14));
        const G = A.general_purpose || {}, gp = G.today || 0, pctT = totT ? Math.round((gp / totT) * 100) : 0, p14 = G.share_d14;
        const by = G.by_session_today || [];
        const from = !by.length ? "" : by.length === 1 || by[0][1] === gp ? `, all from ${esc(hide(by[0][0], "Session"))}` :
          by[0][1] / gp > 0.5 ? `, mostly from ${esc(hide(by[0][0], "Session"))} (${by[0][1]})` : `, from ${by.length} sessions`;
        const over = totT && gp >= 10 && pctT >= 25 && (p14 == null || pctT >= p14 * 1.5);
        R.flag.classList.toggle("quiet", !over);
        html(R.flag, !totT ? `No agents spawned today; ${int(tot14)} over 14 days.` : over
          ? `<b>General-purpose is over-spawned:</b> ${pctT}% of today${from}; ${p14 == null ? "–" : Math.round(p14)}% over 14 days.`
          : `General-purpose is <b>${pctT}%</b> of today's spawns, ${p14 == null ? "–" : Math.round(p14)}% over 14 days.`);
      }
    };
  }

  /* ---- recent activity: the event log, under the weather in the window column ---- */
  // claude.events as it stands: turns finished, asks and answers, agents started and done. Rows
  // are keyed by event, so a new one slides the others down and the oldest fades out. Each row
  // shows its clock time, not an age, so nothing in it ticks.
  function mountActivity() {
    const root = $("activity");
    root.innerHTML = `<div class="hd"><h2>Recent activity</h2><span class="aside">newest first</span></div><div class="rows" data-r="rows"></div>`;
    const R = refs(root);
    // As many rows as the pane holds: its inner height below the header, in fixed 39 px rows
    // (9 at 414 px). Counted at mount and again whenever a ResizeObserver sees the pane change
    // size, never in the update path, so a count read before layout settled cannot stick.
    const ROW_H = 39;
    let ROWS = 0, last = null;
    const fit = () => {
      const n = Math.max(1, Math.floor((root.clientHeight - R.rows.offsetTop - 14) / ROW_H));
      if (n === ROWS) return false;
      ROWS = n;
      R.rows.style.height = n * ROW_H + "px";
      return true;
    };
    fit();
    if (window.ResizeObserver) new ResizeObserver(() => { if (fit() && last) render(last); }).observe(root);
    const make = () => {
      const e = document.createElement("div");
      e.innerHTML = `<div class="erow"><span class="dot" data-r="dot"></span><span class="ename" data-r="name"></span><span class="etime" data-r="at"></span><span class="edesc" data-r="desc"></span></div>`;
      return { el: e, r: refs(e) };
    };
    const task = (d) => { const i = (d || "").indexOf(":"); return i > 0 ? [d.slice(0, i), SHARE ? "task hidden" : d.slice(i + 1).trim()] : [d || "agent", ""]; };
    function says(e) {
      const d = e.detail || "";
      switch (e.kind) {
        // n: turns the feed coalesced into this one event (within 10 min)
        case "done": return ["var(--ok)", e.n > 1 ? `${e.n} turns finished` : "Finished a turn"];
        case "ask": { const m = /^perm\s+(.+)/.exec(d); return ["var(--claude)", m ? `Asked permission for ${m[1]}` : SHARE || !d ? "Asked you a question" : `Asked: ${d}`]; }
        case "answered": { const m = /(\d+(?:\.\d+)?)\s*s/.exec(d); return ["var(--idle)", m ? `You answered after ${dur(+m[1])}` : "You answered"]; }
        case "remind": { const m = /(\d+)/.exec(d); return ["var(--claude)", m ? `Reminder ${m[1]} sent` : "Reminder sent"]; }
        case "agent_start": { const [ty, tk] = task(d); return [ty === "general-purpose" ? "var(--claude)" : "var(--agent)", `Started ${ty}${tk ? ": " + tk : ""}`]; }
        case "agent_done": { const [ty, tk] = task(d); return ["var(--mute)", `${ty} finished${tk ? ": " + tk : ""}`]; }
        default: return ["var(--mute)", (e.kind || "event").replace(/_/g, " ") + (d && !SHARE ? ": " + d : "")];
      }
    }
    const update = (row, e) => {
      const [c, what] = says(e);
      css(row.r.dot, "background", c);
      if (row.same !== e.same) { row.same = e.same; row.el.firstElementChild.classList.toggle("same", e.same); }
      txt(row.r.name, e.kind === "none" ? e.name : hide(e.name || "Claude", "Session"));
      txt(row.r.at, e.t ? hm(e.t) : "");
      txt(row.r.desc, e.kind === "none" ? "Turns, asks and agents show here as they happen" : what);
    };
    // keyed by event identity (t, kind, sid, id); a repeat of the same identity, counted from the
    // oldest so an arriving event never re-keys the ones already shown, gets a #n suffix
    const KEY = Symbol("key");
    function render(s) {
      last = s;
      const all = (s.claude && s.claude.events) || [];
      const n = new Map();
      const ev = all.map((e) => {
        const k = `${e.t}|${e.kind}|${e.sid}|${e.id == null ? "" : e.id}`;
        const c = n.get(k) || 0;
        n.set(k, c + 1);
        return { e, k: c ? `${k}#${c}` : k };
      }).slice(-ROWS).reverse().map(({ e, k }, i, a) => ({ ...e, [KEY]: k, same: i > 0 && a[i - 1].e.name === e.name }));
      if (!ev.length) ev.push({ kind: "none", name: "No events in the log", detail: "", [KEY]: "none" });
      keyed(R.rows, ev, (e) => e[KEY], make, update, ROW_H, ROWS);
    }
    return render;
  }

  /* ================= the window ================= */
  const DIRS = "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split(" ");
  function mountWindow() {
    const root = $("window");
    // the two figures on the sky (their panes, .figcard, show only when the sky will not carry
    // them: sky.js ink()); the words on panes, the slip and the plate
    root.innerHTML = `<i class="figcard c"></i><i class="figcard t"></i>
      <div class="clock num"><b class="hh" data-r="hh"></b><b data-r="mm"></b><span data-r="ap"></span></div>
      <div class="slip"><div class="date" data-r="date"></div>
        <div class="period" data-r="period"><span class="pulse" data-r="pulse"></span><span>Live, every</span><span class="pv num" data-r="pv"></span></div></div>
      <div class="wx">
        <div class="temp num"><span data-r="temp"></span>°</div>
        <div class="plate">
        <div class="cond" data-r="cond"></div>
        <div class="place" data-r="place"></div>
        <dl>
          <div><dt>Feels like</dt><dd class="num"><span data-r="feels"></span>°</dd></div>
          <div><dt>Wind</dt><dd class="num"><span data-r="wind"></span> <small data-r="windu"></small></dd></div>
          <div><dt>Humidity</dt><dd class="num"><span data-r="hum"></span><small>%</small></dd></div>
          <div><dt data-r="pl"></dt><dd class="num"><span data-r="prec"></span> <small data-r="precu"></small></dd></div>
          <div><dt data-r="s1l"></dt><dd class="num"><span data-r="s1"></span> <small data-r="s1u"></small></dd></div>
          <div><dt data-r="s2l"></dt><dd class="num"><span data-r="s2"></span> <small data-r="s2u"></small></dd></div>
        </dl>
        </div>
      </div>`;
    const R = refs(root);
    const temp = live(R.temp, null, (v) => String(Math.round(v)));
    const feels = live(R.feels, null, (v) => String(Math.round(v)));
    // the feed is Celsius; the user's unit (the host's menu) comes from the runtime
    const F = (c) => Kiln.fmt.tempValue(c);
    // rule 6: the period, quiet but legible. The dot beats on Kiln.onBeat, about once a second
    // whatever the period (beating on every line strobed at 100 ms), and a period change lights
    // the readout for 1.5 s. Both are CSS animations; two identical ones, alternated, restart it.
    let beat = false, flag = false;
    Kiln.onBeat(() => {
      R.pulse.className = "pulse " + (beat ? "b1" : "b2");
      beat = !beat;
    });
    const showPeriod = (ms) => txt(R.pv, `${ms}${NB}ms`);
    showPeriod(Kiln.period);
    Kiln.onPeriod((ms) => {
      showPeriod(ms);
      R.period.classList.remove(flag ? "f1" : "f2");
      R.period.classList.add(flag ? "f2" : "f1");
      flag = !flag;
    });
    const split = (t) => { const s = Kiln.fmt.clock(t); const i = s.lastIndexOf(" "); return [s.slice(0, i), s.slice(i + 1)]; };
    // The unit menu, live: both figures land in the new unit at once (a null first cancels the
    // glide, so 53 never runs down to 12) and the pane is written again now, not next minute.
    Kiln.onPrefs((p) => {
      if (p.tempUnit === seenUnit || !Kiln.state) return;
      seenUnit = p.tempUnit;
      temp.set(null); feels.set(null);
      render(Kiln.state);
    });
    let seenUnit = Kiln.tempUnit;
    const render = (s) => {
      const t = s.t, d = new Date(t * 1000);
      const [a, b] = split(t);
      const c = a.indexOf(":");
      txt(R.hh, a.slice(0, c)); txt(R.mm, a.slice(c)); txt(R.ap, b);
      txt(R.date, d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }));
      showPeriod(Kiln.period);
      const w = window.GlassSky ? GlassSky.weather(s) : s.weather;
      if (!w) {
        temp.set(null); feels.set(null); txt(R.cond, "No weather reading"); txt(R.place, "The feed has not reported weather yet");
        for (const k of ["wind", "windu", "hum", "prec", "precu", "s1", "s1u", "s2", "s2u"]) txt(R[k], k.endsWith("u") ? "" : "–");
        txt(R.pl, "Precipitation"); txt(R.s1l, "Sunset"); txt(R.s2l, "Sunrise");
        return;
      }
      temp.set(F(w.temp_c));
      feels.set(F(w.feels_c));
      txt(R.cond, w.text ? w.text[0].toUpperCase() + w.text.slice(1) : w.kind);
      // (the reading to a tenth in °C used to follow the place; in the user's own unit it only
      // repeated the figure above, so it went with the unit menu)
      txt(R.place, [w.place, w.observed_at ? `at ${hm(w.observed_at)}` : ""].filter(Boolean).join(", "));
      // the unit follows the temperature's (Kiln.fmt.wind): mph under °F, km/h under °C
      txt(R.wind, Kiln.fmt.wind(w.wind_kmh, { unit: false }));
      txt(R.windu, w.wind_kmh == null ? "" : `${Kiln.fmt.wind(0, { unit: "only" })} ${w.wind_dir == null ? "" : DIRS[Math.round(w.wind_dir / 22.5) % 16]}`);
      txt(R.hum, w.humidity == null ? "–" : Math.round(w.humidity));
      const snow = w.kind === "snow" || (w.snow_cm || 0) > 0;
      txt(R.pl, snow ? "Snowfall" : "Precipitation");
      txt(R.prec, snow ? (w.snow_cm || 0).toFixed(1) : +(w.precip_mm || 0).toFixed(1));
      txt(R.precu, snow ? "cm" : "mm");
      // by day sunrise then sunset; by night the coming dark first, then the morning
      const ev = [["Sunrise", w.sunrise], ["Sunset", w.sunset]];
      if (!w.is_day) ev.reverse();
      ev.forEach(([label, at], i) => {
        const k = "s" + (i + 1);
        txt(R[k + "l"], label);
        if (!at) { txt(R[k], "–"); txt(R[k + "u"], ""); return; }
        const [x, y] = split(at);
        txt(R[k], x); txt(R[k + "u"], y);
      });
    };
    return render;
  }

  /* ================= right wing ================= */

  // A rolling chart: a static frame (grid, axis numbers), a clipped strip that is redrawn once per
  // update with the newest point at the right edge and slid in from where the old drawing sat,
  // and a small head (16 px, its own layer) that glides to the newest value by transform. Time
  // is state.t, so the scroll speed is real time.
  function scroller(box, w, h, pad, secs) {
    box.classList.add("chart");
    box.style.width = w + "px"; box.style.height = h + "px";
    box.innerHTML = `<svg width="${w}" height="${h}" data-r="frame"></svg>
      <div class="clip" style="left:${pad.l}px;width:${w - pad.l - pad.r + 2}px;height:${h}px"><svg width="${w + 40}" height="${h}" style="left:${-pad.l}px" data-r="strip"></svg></div>
      <svg class="head" width="16" height="16" viewBox="-8 -8 16 16" style="left:${w - pad.r - 8}px;top:-8px" data-r="head"></svg>`;
    const R = refs(box), pw = w - pad.l - pad.r, pps = pw / secs;
    let last = null;
    return {
      R, pw, ph: h - pad.t - pad.b,
      x: (t, now) => pad.l + pw - (now - t) * pps,
      slide(now) {
        if (last != null && now > last && now - last < secs / 2) slideIn(R.strip, (now - last) * pps);
        last = now;
      },
      head(y) { css(R.head, "transform", `translate3d(0,${y.toFixed(1)}px,0)`); },
    };
  }

  /* ---- output tokens: the hour, and the fortnight ---- */
  function mountTokens() {
    const root = $("tokens");
    root.innerHTML = `<div class="hd"><h2>Output tokens</h2><span class="aside" data-r="aside"></span></div>
      <div class="tokhero"><div class="hero num">${slot("hv")}<small><span class="u1" data-r="hu"></span>per min at <span data-r="hat"></span></small></div>
        <div class="k" data-r="fill"></div></div>
      <div class="charts2"><div class="chart" style="width:348px;height:118px" data-r="hour">
          <svg width="348" height="118" data-r="frame"></svg>
          <div class="clip" style="left:30px;width:320px;height:118px"><svg width="400" height="118" style="left:-30px" data-r="strip">
            <defs><linearGradient id="tokGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--claude)" stop-opacity="0.42"/><stop offset="1" style="stop-color:var(--claude)" stop-opacity="0.02"/></linearGradient></defs>
            <path data-r="area" fill="url(#tokGrad)"/><path data-r="line" fill="none" class="s-claude" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            <circle r="3.5" class="f-claude" data-r="pk"/><text class="axis peak" data-r="pkl"></text>
            <circle r="7" class="f-claude" opacity="0.22" data-r="halo"/><circle r="3.6" class="f-mark" data-r="dot"/>
            <path data-r="fl" class="s-claude" stroke-width="1.4" stroke-dasharray="2 3" fill="none"/><circle r="3" fill="none" class="s-claude" stroke-width="1.4" data-r="fc"/>
          </svg></div>
          <svg width="348" height="118" style="position:absolute;left:0;top:0"><line data-r="avg" x1="30" x2="344" class="s-ref" stroke-dasharray="3 4"/><rect data-r="avgc" width="${76 + 8}" height="14" rx="4" opacity="0" style="fill:var(--halo)"/><text data-r="avgl" x="276" class="axis peak"></text></svg>
        </div>
        <div><svg width="186" height="118" data-r="bars"></svg></div></div>
      <div class="today">
        <div><span class="k">Output today</span><div class="n num"><span data-r="ot"></span><small data-r="otu"></small></div></div>
        <div><span class="k">Cache reads</span><div class="n num"><span data-r="cr"></span><small data-r="cru"></small></div></div>
        <div><span class="k">API calls</span><div class="n num" data-r="calls"></div></div>
        <div><span class="k">Cache hit</span><div class="n num" style="color:var(--ok)"><span data-r="hit"></span><small data-r="hit14"></small></div></div>
      </div>`;
    const R = refs(root);
    const hero = live(R.hv, R.hu, (v) => parts(v));
    const ot = live(R.ot, R.otu, (v) => partsFixed(v, 2)), cr = live(R.cr, R.cru, (v) => partsFixed(v, 2));
    const calls = live(R.calls, null, int), hit = live(R.hit, null, (v) => v.toFixed(1));
    const PL = 30, PW = 314, PT = 8, PH = 94;
    let dataKey = "", frameKey = "", minute = null, top = 1, fillHead = null;
    const xi = (i, n) => PL + (i / (n - 1)) * PW, yv = (v) => PT + PH - (Math.min(v, top) / top) * PH;
    // the average's label slots, [start x, below the line]: from the right end (short of the
    // newest point's halo) leftwards in quarter-label steps, above the line before below it.
    // Start-anchored and sized for "average 88.8k" (AVW), so its digits never drag the word.
    const AVW = 76, AVS = [];
    for (let x = PL + PW - 16 - AVW; x > PL + 4; x -= AVW / 4) AVS.push([Math.round(x), 0], [Math.round(x), 1]);
    AVS.push([PL + 4, 0], [PL + 4, 1]);
    let avSlot = 0;
    // the minute in progress: its dashed segment and open circle step as responses land
    // (SVG attributes, so once per update; tokens land in steps, and this shows the step)
    const fill = { set(v) {
      if (!fillHead) return;
      const [lx, ly, fx] = fillHead, fy = yv(v);
      attr(R.fl, "d", `M${lx.toFixed(1)},${ly.toFixed(1)}L${fx.toFixed(1)},${fy.toFixed(1)}`);
      attr(R.fc, "cx", fx.toFixed(1)); attr(R.fc, "cy", fy.toFixed(1));
    } };
    // fortnight bars
    const BW = 186, BH = 118, bpl = 28, bpb = 16;
    let barKey = "", btop = 1, todayBar = null;
    const by = (v) => 8 + (1 - Math.min(v, btop) / btop) * (BH - 8 - bpb);
    const todayH = { set(v) { if (!todayBar) return; const y = by(v); attr(todayBar, "y", y.toFixed(1)); attr(todayBar, "height", Math.max(1.5, by(0) - y).toFixed(1)); } };
    return (s) => {
      const C_ = s.claude || {}, tk = C_.tokens || {}, ser = tk.out_per_min || [], A = s.analytics || {};
      const t = s.t, n = ser.length;
      if (n >= 3) {
        const full = ser.slice(0, -1), lastFull = full[full.length - 1], filling = ser[n - 1];
        const m0 = Math.floor(t / 60) * 60;
        hero.set(lastFull);
        txt(R.hu, parts(lastFull)[1]);
        txt(R.hat, hm(m0 - 60));
        txt(R.fill, `${hm(m0)} so far ${compact(filling)}`);
        let pi = 0;
        full.forEach((v, i) => { if (v > full[pi]) pi = i; });
        const avg = full.reduce((a, b) => a + b, 0) / full.length;
        const sc = scale(Math.max(full[pi], filling, 10) * 1.08, 4);
        if (sc.top + "|" + m0 !== frameKey) {
          frameKey = sc.top + "|" + m0;
          top = sc.top;
          let f = "";
          for (const g of sc.grid) f += `<line x1="${PL}" x2="344" y1="${yv(g)}" y2="${yv(g)}" class="${g ? "g1" : "g0"}"/><text x="${PL - 7}" y="${yv(g) + 4}" text-anchor="end" class="axis">${axisK(g)}</text>`;
          const m = Math.floor((n - 1) / 2);
          f += `<text x="${PL}" y="115" class="axis">${hm(m0 - (n - 1) * 60)}</text><text x="${xi(m, n)}" y="115" text-anchor="middle" class="axis">${hm(m0 - (n - 1 - m) * 60)}</text><text x="344" y="115" text-anchor="end" class="axis">${hm(m0)}</text>`;
          R.frame.innerHTML = f;
          dataKey = "";
        }
        attr(R.avg, "y1", yv(avg).toFixed(1)); attr(R.avg, "y2", yv(avg).toFixed(1));
        txt(R.avgl, `average ${compact(avg)}`);
        const dk = full.join(",");
        if (dk !== dataKey) {
          dataKey = dk;
          const pts = full.map((v, i) => [xi(i, n), yv(v)]);
          const d = smooth(pts), lp = pts[pts.length - 1];
          attr(R.line, "d", d);
          attr(R.area, "d", `${d}L${lp[0].toFixed(1)},${PT + PH}L${PL},${PT + PH}Z`);
          const [px, py] = pts[pi], right = px < PL + PW * 0.62;
          attr(R.pk, "cx", px.toFixed(1)); attr(R.pk, "cy", py.toFixed(1));
          attr(R.pkl, "x", (right ? px + 7 : px - 7).toFixed(1)); attr(R.pkl, "y", (py + 4).toFixed(1)); attr(R.pkl, "text-anchor", right ? "start" : "end");
          txt(R.pkl, `${compact(full[pi])} at ${hm(m0 - (n - 1 - pi) * 60)}`);
          for (const e of [R.halo, R.dot]) { attr(e, "cx", lp[0].toFixed(1)); attr(e, "cy", lp[1].toFixed(1)); }
          fillHead = [lp[0], lp[1], xi(n - 1, n)];
          // The average's label takes the first fixed slot the trace and the peak's label leave
          // clear, and keeps it while it stays clear. At one spot over the newest minutes it sat
          // on the trace and the endpoint dot (2026-11-05). Slots end before the newest point's
          // halo, so the minute in progress, which moves every line, never reaches one; the
          // choice changes only when a minute closes, and a slot never slides (rule 13).
          // the collision box is this label's own width (5.3 px a character, measured on the
          // 10.5 px semibold axis face), not the widest label's
          const ay = yv(avg), pkw = (compact(full[pi]).length + 9) * 5.9, pkx = right ? px + 7 : px - 7 - pkw;
          const avw = `average ${compact(avg)}`.length * 5.3;
          const cost = ([x, below]) => {
            const y0 = below ? ay + 3 : ay - 14, y1 = y0 + 12;
            if (y0 < 0 || y1 > PT + PH + 2) return Infinity;
            if (x < pkx + pkw + 3 && x + avw > pkx - 3 && y0 < py + 9 && y1 > py - 7) return Infinity;
            return traceNear(pts, x - 2, x + avw + 2, y0 - 2, y1 + 2);
          };
          const [k, chip] = placeAvg(avSlot, AVS, cost), [ax, below] = AVS[k], aty = below ? ay + 12 : ay - 5;
          avSlot = k;
          attr(R.avgl, "x", ax); attr(R.avgl, "y", aty.toFixed(1));
          attr(R.avgc, "x", ax - 4); attr(R.avgc, "y", (aty - 10).toFixed(1)); attr(R.avgc, "width", Math.round(avw + 8));
          attr(R.avgc, "opacity", chip ? 1 : 0);
        }
        fill.set(filling);
        // a new minute: everything shifts one bucket left, smoothly, over one period
        if (minute != null && m0 > minute) slideIn(R.strip, PW / (n - 1));
        minute = m0;
      }
      // fortnight: one bar a day from analytics, today's bar live from the token counter
      const days = A.days || [];
      const outToday = tk.today && tk.today.out;
      if (days.length) {
        const vals = days.map((d, i) => (i === days.length - 1 && outToday != null ? Math.max(outToday, d.out) : d.out));
        const prev = vals.slice(0, -1);
        const pIdx = prev.indexOf(Math.max(...prev));
        const bs = scale(Math.max(...vals) * 1.05, 2);
        const bk = days.map((d) => d.date + d.out).join() + "|" + bs.top;
        const bw = (BW - bpl) / days.length;
        if (bk !== barKey) {
          barKey = bk; btop = bs.top;
          let g = "";
          for (const v of bs.grid) g += `<line x1="${bpl}" x2="${BW}" y1="${by(v)}" y2="${by(v)}" class="${v ? "g1" : "g0"}"/><text x="${bpl - 6}" y="${by(v) + 3.5}" text-anchor="end" class="axis">${axisK(v)}</text>`;
          vals.forEach((v, i) => {
            const last = i === vals.length - 1, x = bpl + i * bw + 1.5, tp = by(v);
            g += `<rect x="${x.toFixed(1)}" y="${tp.toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${Math.max(1.5, by(0) - tp).toFixed(1)}" rx="2" class="f-claude" ${last ? 'data-r="today"' : 'opacity="0.45"'}/>`;
            if (i % 4 === 0 && i < vals.length - 2) g += `<text x="${(x + (bw - 3) / 2).toFixed(1)}" y="${BH - 3}" text-anchor="middle" class="axis">${+days[i].date.slice(8)}</text>`;
          });
          if (pIdx >= 0) g += `<text x="${(bpl + pIdx * bw + bw / 2).toFixed(1)}" y="${(by(prev[pIdx]) - 5).toFixed(1)}" text-anchor="middle" class="axis peak">${compact(prev[pIdx])}</text>`;
          g += `<text x="${BW - bw / 2}" text-anchor="end" class="axis hi" data-r="tl"></text>`;
          const ld = new Date(days[days.length - 1].date + "T12:00:00");
          g += `<text x="${BW}" y="${BH - 3}" text-anchor="end" class="axis">${ld.toLocaleDateString("en-US", { month: "short" })} ${ld.getDate()}</text>`;
          R.bars.innerHTML = g;
          const r2 = refs(R.bars);
          todayBar = r2.today; R.tl = r2.tl;
        }
        const tv = vals[vals.length - 1];
        todayH.set(tv);
        attr(R.tl, "y", (Math.max(14, by(tv) - 5)).toFixed(1));
        txt(R.tl, `today ${compact(tv)}`);
        const d0 = new Date(days[0].date + "T12:00:00");
        txt(R.aside, `per minute this hour, per day since ${d0.toLocaleDateString("en-US", { month: "short" })} ${d0.getDate()}`);
      } else txt(R.aside, "per minute this hour");
      const today = tk.today || {};
      ot.set(today.out); cr.set(today.cache_read); calls.set(today.calls);
      const ch = A.cache_hit_pct || {};
      hit.set(ch.today);
      txt(R.hit14, ch.d14 == null ? "%" : `%, 14 d ${ch.d14}%`);
    };
  }

  /* ---- this Mac ---- */
  function mountCompute() {
    const root = $("compute");
    root.innerHTML = `<div class="hd"><h2>This Mac</h2><span class="aside">GPU <i class="slot" style="width:1.9em" data-r="gpu"></i>%, load <span data-r="load"></span></span></div>
      <div class="compute">
        <div>
          <div class="hero num cpuhero" style="font-size:34px">${slot("cpu")}<small>% CPU</small></div>
          <div class="k split" style="margin:4px 0 6px"><span>user ${slot("us")}%</span><span>system ${slot("sy")}%</span></div>
          <div data-r="chart"></div>
        </div>
        <div><div class="k" style="margin-bottom:5px" data-r="ch"></div><div class="cores" data-r="cores"></div></div>
        <div>
          <div class="k">Memory used</div>
          <div class="mid num" style="margin-top:3px">${slot("mu")}<small data-r="mt"></small></div>
          <div class="memstack" data-r="stack"><i style="background:var(--machine-2)"></i><i style="background:var(--machine)"></i><i style="background:var(--machine-3)"></i></div>
          <div class="k ml"><span>wired ${slot("mw")}</span><span>active ${slot("ma")}</span><span>compressed ${slot("mc")}</span></div>
          <div class="levels" data-r="lv"><span>Normal</span><span>Warn</span><span>Critical</span></div>
          <div class="k" style="margin-top:4px;font-size:11.5px;white-space:nowrap" data-r="swap"></div>
        </div>
      </div>`;
    const R = refs(root);
    const cpu = live(R.cpu, null, (v) => (v >= 99.95 ? "100" : v.toFixed(1)));
    const mu = live(R.mu, null, (v) => v.toFixed(1));
    // the stack: each segment is the full bar, moved and scaled into place (no relayout); the
    // CSS transition glides it on the compositor
    const segs = [...R.stack.children];
    const paintMem = (share) => {
      let acc = 0;
      segs.forEach((e, i) => { css(e, "transform", `translate3d(${(acc * 100).toFixed(2)}%,0,0) scaleX(${Math.max(0, share[i] - 0.002).toFixed(4)})`); acc += share[i]; });
    };
    const sc = scroller(R.chart, 192, 64, { l: 28, r: 4, t: 6, b: 14 }, 45);
    sc.R.strip.innerHTML = `<defs><linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--machine)" stop-opacity="0.35"/><stop offset="1" style="stop-color:var(--machine)" stop-opacity="0.02"/></linearGradient></defs>
      <path data-r="a" fill="url(#cpuGrad)"/><path data-r="l" fill="none" class="s-machine" stroke-width="1.6" stroke-linejoin="round"/><circle r="3.5" class="f-machine" data-r="pk"/>`;
    // The peak's figure is anchored in the time axis, between "45 s ago" and "now"; only its dot
    // rides the scrolling strip. Riding along, the label flipped sides and jumped up to 66 px.
    let pkl = null;
    sc.R.head.innerHTML = `<circle r="7" class="f-machine" opacity="0.22"/><circle r="3.6" class="f-mark"/>`;
    const S = refs(sc.R.strip);
    let ctop = 0, cores = [], coreKey = -1, now = 0;
    const cy = (v) => 6 + sc.ph - (Math.min(v, ctop) / ctop) * sc.ph;
    Kiln.track("cpu", (s) => s.sys && s.sys.cpu, 60);
    return (s) => {
      const S_ = s.sys;
      if (!S_) return;
      now = s.t;
      // three figures and a point at any load ("1.37", "12.3"), so the aside never changes width
      txt(R.load, S_.load ? S_.load.map((l) => (l < 9.995 ? l.toFixed(2) : l < 99.95 ? l.toFixed(1) : String(Math.round(l)))).join(", ") : "–");
      cpu.set(S_.cpu);
      const p1 = (v) => (v >= 99.95 ? "100" : v.toFixed(1));
      txt(R.us, p1(S_.user)); txt(R.sy, p1(S_.sys));
      txt(R.gpu, S_.gpu == null ? "–" : Math.round(S_.gpu));
      // CPU, the last 45 s, scrolling
      const ser = Kiln.series("cpu").filter((p) => p.t >= now - 47);
      if (ser.length) {
        let pk = ser[0];
        for (const p of ser) if (p.v >= pk.v) pk = p;
        // CPU is a share of the whole machine: the axis stops at 100% (a 100% peak drew 150%)
        const st = scale(Math.min(100, Math.max(pk.v * 1.1, 10)), 3);
        if (st.top !== ctop) {
          ctop = st.top;
          sc.R.frame.innerHTML = st.grid.map((g) => `<line x1="28" x2="188" y1="${cy(g)}" y2="${cy(g)}" class="${g ? "g1" : "g0"}"/><text x="21" y="${cy(g) + 4}" text-anchor="end" class="axis">${axisK(g)}%</text>`).join("")
            + `<text x="28" y="61" class="axis">45 s ago</text><text x="90" y="61" class="axis peak" data-r="pkl"></text><text x="188" y="61" text-anchor="end" class="axis">now</text>`;
          pkl = sc.R.frame.querySelector("[data-r=pkl]");
        }
        const pts = ser.map((p) => [sc.x(p.t, now), cy(p.v)]);
        const d = poly(pts);
        attr(S.l, "d", d);
        attr(S.a, "d", `${d}L${pts[pts.length - 1][0].toFixed(1)},${6 + sc.ph}L${pts[0][0].toFixed(1)},${6 + sc.ph}Z`);
        attr(S.pk, "cx", sc.x(pk.t, now).toFixed(1)); attr(S.pk, "cy", cy(pk.v).toFixed(1));
        txt(pkl, `peak ${pk.v.toFixed(1)}%`);
        sc.slide(now);
        sc.head(cy(S_.cpu));
      }
      // cores: one capsule each, filled by transform
      const cs = S_.cores || [];
      if (cs.length !== coreKey) {
        coreKey = cs.length;
        txt(R.ch, `${cs.length} cores, %`);
        R.cores.style.gridTemplateColumns = `repeat(${cs.length}, minmax(0, 1fr))`;
        R.cores.innerHTML = cs.map(() => `<div class="core"><div class="cap"><i></i></div><b class="num"></b></div>`).join("");
        cores = [...R.cores.children].map((c) => {
          const bar = c.querySelector("i");
          // height is load^0.7 of the capsule, from 0: 5% fills 9 px, 15% 19, 30% 32, 60% 52.
          // Monotonic, and the figure under it is the true value. A 5% floor made 0-5% one
          // shape, and linear left 5% a 4 px sliver in the capsule's round foot (2026-11-05).
          return { bar: { set: (v) => css(bar, "transform", `scaleY(${Math.pow(Math.max(0, Math.min(100, v)) / 100, 0.7).toFixed(3)})`) }, n: live(c.querySelector("b"), null, (v) => String(Math.round(v))) };
        });
      }
      cs.forEach((v, i) => { cores[i].bar.set(v); cores[i].n.set(v); });
      // memory: GiB, as macOS reports it; a stacked bar of what is held
      const m = S_.mem;
      if (m) {
        mu.set(m.used / GIB);
        txt(R.mt, `GB of ${Math.round(m.total / GIB)}`);
        paintMem([m.wired / m.total, m.active / m.total, m.compressed / m.total]);
        txt(R.mw, f3(m.wired / GIB)); txt(R.ma, f3(m.active / GIB)); txt(R.mc, f3(m.compressed / GIB));
        [...R.lv.children].forEach((e, i) => { const on = ["normal", "warn", "critical"][i] === m.pressure, c = on ? "on " + m.pressure : ""; if (e.className !== c) e.className = c; });
      }
      txt(R.swap, `Pressure, kernel level. Swap ${S_.swap == null ? "–" : (S_.swap / GIB).toFixed(1)} GB`);
    };
  }

  /* ---- network, disk, battery ---- */
  function mountIO() {
    const root = $("io");
    root.innerHTML = `<div class="io">
      <div><div class="hd" style="margin-bottom:6px"><h2>Network</h2><span class="aside">45 s, peak <i class="slot" style="width:1.9em" data-r="na"></i><span style="display:inline-block;width:2.65em;padding-left:0.25em" data-r="nau"></span></span></div>
        <div style="display:flex;gap:14px;align-items:center">
          <div style="white-space:nowrap;width:118px;flex:none"><div class="mid num" style="color:var(--machine)">${slot("rx")}<small data-r="rxu"></small></div><div class="mid num" style="color:var(--agent);margin-top:8px">${slot("tx")}<small data-r="txu"></small></div></div>
          <div data-r="chart"></div></div></div>
      <div><div class="hd" style="margin-bottom:6px"><h2>Disk</h2><span class="aside" data-r="dt"></span></div>
        <div class="mid num"><span data-r="df"></span><small>GB free</small></div>
        <div class="bar ice" style="margin:8px 0 7px"><i data-r="db"></i></div>
        <div class="k rw"><span>read</span>${slot("rd")}<span data-r="rdu"></span><span>write</span>${slot("wr")}<span data-r="wru"></span></div></div>
      <div><div class="hd" style="margin-bottom:6px"><h2>Battery</h2></div>
        <div class="mid num"><span data-r="bp"></span><small>%</small></div>
        <svg width="76" height="20" style="margin:8px 0 6px"><rect x="0.5" y="0.5" width="68" height="19" rx="5.5" fill="none" class="s-ink" opacity="0.4"/><rect x="71" y="6.5" width="3" height="7" rx="1.5" class="f-ink" opacity="0.4"/><rect x="3" y="3" width="63" height="14" rx="3.5" class="batt-fill" data-r="bf"/></svg>
        <div class="k" data-r="bs"></div></div>
    </div>`;
    const R = refs(root);
    const rx = live(R.rx, R.rxu, (v) => { const b = bytes(v); return [b[0], b[1] + " down"]; });
    const tx = live(R.tx, R.txu, (v) => { const b = bytes(v); return [b[0], b[1] + " up"]; });
    const df = live(R.df, null, (v) => String(Math.round(v)));
    const bp = live(R.bp, null, (v) => String(Math.round(v)));
    const db = { set: (v) => css(R.db, "transform", `scaleX(${v.toFixed(4)})`) };
    const bf = { set: (v) => attr(R.bf, "width", ((63 * Math.max(2, Math.min(100, v))) / 100).toFixed(2)) };
    const NW = 150, NH = 52, mid = NH / 2;
    const sc = scroller(R.chart, NW + 34, NH, { l: 0, r: 34, t: 0, b: 0 }, 45);
    sc.R.strip.innerHTML = `<path data-r="ua" class="f-machine" fill-opacity="0.28"/><path data-r="ul" class="s-machine" fill="none" stroke-width="1.4"/><path data-r="da" class="f-agent" fill-opacity="0.26"/><path data-r="dl" class="s-agent" fill="none" stroke-width="1.4"/>`;
    const S = refs(sc.R.strip);
    Kiln.track("rx", (s) => s.sys && s.sys.net && s.sys.net.rx_bps, 60);
    Kiln.track("tx", (s) => s.sys && s.sys.net && s.sys.net.tx_bps, 60);
    let top = 0;
    return (s) => {
      const S_ = s.sys;
      if (!S_) return;
      const now = s.t, net = S_.net || {};
      rx.set(net.rx_bps); tx.set(net.tx_bps);
      const r = Kiln.series("rx").filter((p) => p.t >= now - 47), t_ = Kiln.series("tx").filter((p) => p.t >= now - 47);
      const peak = Math.max(1000, ...r.map((p) => p.v), ...t_.map((p) => p.v));
      const st = scale(peak, 1);
      if (st.top !== top) {
        top = st.top;
        sc.R.frame.innerHTML = `<line x1="0" x2="${NW}" y1="${mid}" y2="${mid}" class="g0"/><text x="${NW + 4}" y="7" class="axis">${axisK(top)}</text><text x="${NW + 4}" y="${mid + 3.5}" class="axis">0</text><text x="${NW + 4}" y="${NH}" class="axis">${axisK(top)}</text>`;
      }
      // mirrored: download above the axis, upload below, one scale
      const yU = (v) => mid - (Math.min(v, top) / top) * (mid - 2), yD = (v) => mid + (Math.min(v, top) / top) * (mid - 2);
      const draw = (ser, y, l, a) => {
        if (!ser.length) return;
        const pts = ser.map((p) => [sc.x(p.t, now), y(p.v)]);
        const d = poly(pts);
        attr(l, "d", d); attr(a, "d", `${d}L${pts[pts.length - 1][0].toFixed(1)},${mid}L${pts[0][0].toFixed(1)},${mid}Z`);
      };
      draw(r, yU, S.ul, S.ua); draw(t_, yD, S.dl, S.da);
      sc.slide(now);
      const pb = bytes(peak === 1000 ? Math.max(...r.map((p) => p.v), ...t_.map((p) => p.v), 0) : peak);
      txt(R.na, pb[0]); txt(R.nau, pb[1]);
      const d = S_.disk || {};
      if (d.total) {
        df.set(d.free / 1e9);
        txt(R.dt, `of ${Math.round(d.total / 1e9)} GB`);
        db.set(1 - d.free / d.total);
        const rd = bytes(d.read_bps), wr = bytes(d.write_bps);
        txt(R.rd, rd[0]); txt(R.rdu, rd[1]); txt(R.wr, wr[0]); txt(R.wru, wr[1]);
      }
      const b = S_.batt || {};
      bp.set(b.pct);
      bf.set(b.pct || 0);
      attr(R.bf, "class", "batt-fill " + ((b.pct || 0) <= 20 && !b.ac ? "f-claude" : "f-ok"));
      html(R.bs, b.charging ? "On power<br>charging" : b.ac ? "On power<br>not charging"
        : `On battery<br>${b.mins_left ? dur(b.mins_left * 60, true) + " left" : "estimating"}`);
    };
  }

  /* ---- processes (machine preset) ---- */
  function mountProcs() {
    const root = $("procs");
    root.innerHTML = `<div class="hd"><h2>Processes</h2><span class="aside">now, by CPU and by memory</span></div>
      <div class="procs"><div><div class="k" style="margin-bottom:4px">CPU, % of one core</div><div data-r="cpu"></div></div><div><div class="k" style="margin-bottom:4px">Memory</div><div data-r="mem"></div></div></div>`;
    const R = refs(root);
    const rows = (box, list, f) => html(box, list.slice(0, 10).map(([n, v]) => `<div class="proc"><span>${esc(SHARE ? "process" : n)}</span><span class="num">${f(v)}</span></div>`).join(""));
    return (s) => {
      const S_ = s.sys;
      if (!S_) return;
      rows(R.cpu, S_.top_cpu || [], (v) => v.toFixed(1));
      rows(R.mem, S_.top_mem || [], (v) => (v / GIB).toFixed(2) + NB + "GB");
    };
  }

  /* ---- the last 14 days (week preset) ---- */
  function mountFortnight() {
    const root = $("fortnight");
    root.innerHTML = `<div class="hd"><h2>The last 14 days</h2><span class="aside" data-r="range"></span></div>
      <svg width="552" height="170" data-r="bars"></svg>
      <div class="today" style="grid-template-columns:repeat(5,1fr)" data-r="tot"></div>`;
    const R = refs(root);
    let key = "";
    return (s) => {
      const A = s.analytics || {}, days = A.days || [];
      if (!days.length) return;
      const k = JSON.stringify([days.map((d) => d.out), A.prompts, A.fails, A.ask_wait, A.concurrency]);
      if (k === key) return;
      key = k;
      const W = 552, H = 170, pl = 32, pb = 18, pt = 16, sc = scale(Math.max(...days.map((d) => d.out)), 2);
      const y = (v) => pt + (1 - v / sc.top) * (H - pt - pb), bw = (W - pl) / days.length;
      let g = sc.grid.map((v) => `<line x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="${v ? "g1" : "g0"}"/><text x="${pl - 6}" y="${y(v) + 3.5}" text-anchor="end" class="axis">${axisK(v)}</text>`).join("");
      days.forEach((d, i) => {
        const x = pl + i * bw + 3, last = i === days.length - 1;
        g += `<rect x="${x.toFixed(1)}" y="${y(d.out).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${Math.max(1.5, y(0) - y(d.out)).toFixed(1)}" rx="3" class="f-claude" ${last ? "" : 'opacity="0.5"'}/>`;
        g += `<text x="${(x + (bw - 6) / 2).toFixed(1)}" y="${(y(d.out) - 4).toFixed(1)}" text-anchor="middle" class="axis ${last ? "hi" : ""}">${compact(d.out)}</text>`;
        const dd = new Date(d.date + "T12:00:00");
        g += `<text x="${(x + (bw - 6) / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" class="axis">${dd.toLocaleDateString("en-US", { weekday: "narrow" })} ${dd.getDate()}</text>`;
      });
      R.bars.innerHTML = g;
      const d0 = new Date(days[0].date + "T12:00:00"), d1 = new Date(days[days.length - 1].date + "T12:00:00");
      txt(R.range, `output per day, ${d0.toLocaleDateString("en-US", { month: "short" })} ${d0.getDate()} to ${d1.toLocaleDateString("en-US", { month: "short" })} ${d1.getDate()}`);
      const sum = days.reduce((a, d) => a + d.out, 0), aw = A.ask_wait || {};
      const cell = (label, v, u) => `<div><span class="k">${label}</span><div class="n num">${v}<small>${u || ""}</small></div></div>`;
      const p = parts(sum, 1);
      html(R.tot, cell("Output", p[0], p[1]) + cell("Prompts", int((A.prompts || {}).d14 || 0)) + cell("Failed turns", int((A.fails || {}).d14 || 0))
        + cell("Median answer", aw.median_s ? dur(aw.median_s, false) : "–") + cell("Most at once", (A.concurrency || {}).max || "–", " sessions"));
    };
  }

  /* ---- GitHub, this year: the real contribution calendar, in sodium ---- */
  function mountGitHub() {
    const root = $("github");
    root.innerHTML = `<div class="hd"><h2>GitHub, this year</h2><span class="aside" data-r="aside"></span></div>
      <div class="ghstats" style="margin-top:0">
        <div><div class="hero num" data-r="tot"></div><span class="k">contributions</span></div>
        <div><span class="k">Today, boxed</span><div class="n num" style="color:var(--claude-hi)" data-r="today"></div></div>
        <div><span class="k">This week</span><div class="n num" data-r="week"></div></div>
        <div><span class="k">Streak</span><div class="n num"><span data-r="streak"></span><small data-r="su"></small></div></div>
        <div><span class="k">Best day, circled</span><div class="n num"><span data-r="best"></span><small data-r="bd"></small></div></div>
      </div>
      <div style="margin-top:8px"><svg width="553" height="102" data-r="cal"></svg></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px" class="k"><span>Month totals under each month. Per day:</span><span style="display:flex;gap:10px" data-r="legend"></span></div>
      <div class="latest"><span><span class="k">Latest </span><b data-r="lt"></b></span><span class="k" style="color:var(--ink-2)" data-r="la"></span></div>
      <div style="margin-top:9px"><div class="hd" style="margin:0"><span class="k">Commits by repo</span><span class="k" data-r="cpi"></span></div>
        <div class="sharebar" style="height:10px;border-radius:4px;margin-top:6px" data-r="rb"></div><div class="legend" style="margin-top:6px" data-r="rl"></div></div>`;
    const R = refs(root);
    const tot = live(R.tot, null, int), today = live(R.today, null, int), week = live(R.week, null, int);
    const LV = [[0, "var(--cal-0)"], [1, "var(--cal-1)"], [10, "var(--cal-2)"], [20, "var(--cal-3)"], [50, "var(--cal-4)"]];
    const level = (n) => LV.reduce((acc, [min], i) => (n >= min ? i : acc), 0);
    R.legend.innerHTML = [["0", 0], ["1–9", 1], ["10–19", 2], ["20–49", 3], ["50+", 4]]
      .map(([l, i]) => `<span style="display:inline-flex;align-items:center;gap:4px"><i style="width:9px;height:9px;border-radius:2px;background:${LV[i][1]};display:inline-block"></i>${l}</span>`).join("");
    let calKey = "", repoKey = "";
    return (s) => {
      const G = s.github;
      if (!G || !G.days) { txt(R.aside, "GitHub has not reported yet"); return; }
      const t = s.t, days = G.days;
      tot.set(G.total_year); today.set(G.today); week.set(G.week);
      txt(R.streak, G.streak); txt(R.su, G.streak === 1 ? "day" : "days");
      const best = G.best || [null, 0];
      txt(R.best, int(best[1]));
      if (best[0]) { const bd = new Date(best[0] + "T12:00:00"); txt(R.bd, dayname(bd.getTime() / 1000)); }
      const active = days.filter((d) => d[1] > 0).length;
      const f = (ds) => { const d = new Date(ds + "T12:00:00"); return `${d.toLocaleDateString("en-US", { month: "short" })} ${d.getDate()}`; };
      txt(R.aside, `${G.login}, ${f(days[0][0])}, ${days[0][0].slice(0, 4)} to ${f(days[days.length - 1][0])}, active ${active} of ${days.length} days`);
      // the calendar redraws only when the calendar changes
      const ck = days.length + days[0][0] + days[days.length - 1][0] + "|" + G.total_year + "|" + G.today + "|" + best[0];
      if (ck !== calKey) {
        calKey = ck;
        const pl = 26, pitch = 9.95, cell = 8, top = 14, gw = pl + Math.ceil(days.length / 7) * pitch;
        let g = "";
        ["Mon", "Wed", "Fri"].forEach((d, j) => (g += `<text x="${pl - 5}" y="${top + (1 + j * 2) * pitch + 7}" text-anchor="end" class="axis">${d}</text>`));
        const months = [], seen = {};
        days.forEach(([ds, n], i) => {
          const col = Math.floor(i / 7), row = i % 7, x = pl + col * pitch, y = top + row * pitch;
          const isToday = i === days.length - 1, isBest = ds === best[0];
          g += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell}" height="${cell}" rx="1.8" style="fill:${LV[level(n)][1]}"${isToday ? ` class="s-mark" stroke-width="1.2"` : ""}/>`;
          if (isBest) g += `<circle cx="${(x + cell / 2).toFixed(2)}" cy="${(y + cell / 2).toFixed(2)}" r="6.4" fill="none" class="s-mark" stroke-width="1.3"/>`;
          const key = ds.slice(0, 7);
          if (!(key in seen)) { seen[key] = months.length; months.push({ ds, col, total: 0 }); }
          months[seen[key]].total += n;
        });
        // month names above, month totals below: the calendar carries its own numbers
        months.forEach((m, i) => {
          const last = i === months.length - 1, x = last ? gw : pl + m.col * pitch, a = last ? "end" : "start";
          // a sliver of a month (under two columns) would collide with its neighbour's label
          if (!last && months[i + 1].col - m.col < 2) return;
          const label = new Date(m.ds + "T12:00:00").toLocaleDateString("en-US", { month: "short" });
          g += `<text x="${x.toFixed(1)}" y="9" text-anchor="${a}" class="axis">${label}</text>`;
          g += `<text x="${x.toFixed(1)}" y="${top + 7 * pitch + 13}" text-anchor="${a}" class="axis ${m.total >= 1500 ? "hi" : ""}">${int(m.total)}</text>`;
        });
        R.cal.innerHTML = g;
      }
      const L = G.latest;
      if (L) {
        txt(R.lt, SHARE ? (L.type || "").replace(/Event$/, "").toLowerCase() || "activity" : L.text);
        html(R.la, `${hm(L.at)}, ${durSlots(t - L.at)} ago`);
      } else { txt(R.lt, "No recent public activity"); html(R.la, ""); }
      txt(R.cpi, `${int(G.commits_year || 0)} commits, ${int(G.prs_year || 0)} PRs, ${int(G.issues_year || 0)} issues`);
      // where this year's commits went: the top three repos and the rest, on one bar
      const repos = (G.repos || []).slice().sort((a, b) => b[1] - a[1]);
      const rk = JSON.stringify([repos.slice(0, 3), G.commits_year, repos.length]);
      if (rk !== repoKey && repos.length) {
        repoKey = rk;
        const lead = repos.slice(0, 3), total = G.commits_year || repos.reduce((a, r) => a + r[1], 0);
        const rest = Math.max(0, total - lead.reduce((a, r) => a + r[1], 0));
        const shades = ["var(--cal-4)", "var(--cal-3)", "color-mix(in srgb, var(--claude) 55%, transparent)", "var(--track)"];
        const segs = lead.map((r, i) => [hide(r[0].split("/").pop(), "repo"), r[1], shades[i]]);
        if (repos.length > 3) segs.push([`${repos.length - 3} more repos`, rest, "color-mix(in srgb, var(--ink) 22%, transparent)"]);
        html(R.rb, segs.map(([, n, c]) => `<i style="width:calc(${((n / total) * 100).toFixed(2)}% - 2px);background:${c}"></i>`).join(""));
        html(R.rl, segs.map(([k, n, c]) => `<span><i style="width:8px;height:8px;border-radius:2px;background:${c};display:inline-block"></i>${esc(k)} <b class="v num">${int(n)}</b></span>`).join(""));
      }
    };
  }

  /* ---------------- what each slow pane reads (README 8a.6b) ----------------
     Sticky blocks (weather, github, analytics, claude.events/limits/tokens) keep their object
     identity while unchanged, so comparing them is free. Time enters at the resolution the pane
     prints it: a minute, or a second while a duration under an hour shows its seconds. Sessions,
     This Mac and I/O are the fast figures and run on every line. */
  const sec = (t, at) => (at != null && Math.abs(t - at) < 3600 ? Math.floor(t) : Math.floor(t / 60));
  const DEPS = new Map([
    [mountLimit, (s) => {
      const L = s.claude && s.claude.limits, sd = L && L.seven_day, r = sd ? sd.resets_at : null;
      const fine = r != null && (r - s.t < 3600 || s.t - (r - WEEK) < 3600);   // a count shows seconds
      return [L, fine ? Math.floor(s.t) : Math.floor(s.t / 60)];
    }],
    [mountNeeds, (s) => {
      const w = ((s.claude && s.claude.sessions) || []).filter((x) => x.state === "waiting")
        .map((x) => x.sid + "|" + x.since + "|" + (x.ask ? x.ask.text : "")).join();
      return [w, w ? Math.floor(s.t) : 0, s.claude && s.claude.events, s.analytics];
    }],
    [mountWindow, (s) => [s.weather, Math.floor(s.t / 60)]],
    [mountActivity, (s) => [s.claude && s.claude.events]],
    [mountTokens, (s) => [s.claude && s.claude.tokens, s.analytics, Math.floor(s.t / 60)]],
    [mountAgents, (s) => {
      const C_ = s.claude || {};
      return [(C_.agents_running || []).map((a) => a.id + "|" + (a.idle_s > 120)).join(), Math.floor(s.t), C_.events, s.analytics, leftSplit];
    }],
    [mountGitHub, (s) => [s.github, sec(s.t, s.github && s.github.latest && s.github.latest.at)]],
    [mountFortnight, (s) => [s.analytics, s.claude && s.claude.tokens]],
  ]);

  /* ---------------- boot: mount on the first line, then every line updates ---------------- */
  document.body.classList.add("p-" + PRESET);
  let mounted = false;
  const updaters = [];
  Kiln.on((s) => {
    if (mounted) return;
    mounted = true;
    const want = [mountLimit, mountNeeds, mountWindow, mountActivity];
    if (PRESET !== "focus") {
      want.push(mountSessions, mountAgents, mountTokens);
      if (PRESET === "week") want.push(mountFortnight); else want.push(mountCompute, mountIO);
      if (PRESET === "machine") want.push(mountProcs); else want.push(mountGitHub);
    }
    // one listener per pane, so a pane that throws cannot stop the others; a pane with an entry
    // in DEPS runs only when one of its inputs changed (README 8a.6b)
    for (const m of want) {
      const fn = m(), deps = DEPS.get(m);
      updaters.push(fn);
      if (!deps) { Kiln.on(fn); continue; }
      let seen = null;
      Kiln.on((s, p) => {
        const k = deps(s);
        if (seen && k.every((v, i) => v === seen[i])) return;
        seen = k;
        fn(s, p);
      });
    }
    // Each pane's contents move into one inner box (.pc in index.html): the glass under it then
    // paints once, and the hot panes' figures repaint in a transparent layer of their own. The
    // nodes move, so every ref the updaters hold stays good.
    for (const g of document.querySelectorAll(".glass")) {
      const pc = document.createElement("div");
      pc.className = "pc";
      pc.append(...g.childNodes);
      g.append(pc);
    }
    if (window.GlassSky) {
      GlassSky.layout();
      if (document.fonts) document.fonts.ready.then(() => GlassSky.layout());
    }
  });
})();
