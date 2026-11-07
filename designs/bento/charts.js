// Bento Keynote helpers: formats, SVG elements, smooth paths and scales.
// Everything here is pure; the tiles in bento.js call it on every feed line.
(function () {
  "use strict";
  const NBSP = " ";
  const NS = "http://www.w3.org/2000/svg";
  // Built once: toLocaleDateString/toLocaleString with options builds a new Intl formatter on
  // every call, and the tiles format some twenty dates and counts per feed line.
  const dtf = (o) => new Intl.DateTimeFormat("en-US", o);
  const DATE = { wd: dtf({ weekday: "short" }), mo: dtf({ month: "short" }), md: dtf({ month: "short", day: "numeric" }),
    long: dtf({ weekday: "long", month: "long", day: "numeric" }) };
  const INT = new Intl.NumberFormat("en-US");

  const fmt = {
    // 6.1k / 18.34M / 2.234B, split so the unit can be set smaller
    compact(n, d) {
      d = d == null ? 1 : d;
      const a = Math.abs(n);
      if (a >= 1e9) return (n / 1e9).toFixed(d + 1).replace(/\.?0+$/, "") + "B";
      if (a >= 1e6) return (n / 1e6).toFixed(d).replace(/\.0+$/, "") + "M";
      if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : d).replace(/\.0$/, "") + "k";
      return String(Math.round(n));
    },
    parts(n, d) {
      const s = fmt.compact(n, d);
      const m = s.match(/^(-?[\d.]+)([kMB]?)$/);
      return m ? [m[1], m[2]] : [s, ""];
    },
    // bytes per second: [figure, unit]
    rate(b) {
      if (b == null) return ["–", ""];
      // at most three figures ("9.9", "999"), so a rate fits one fixed slot
      if (b >= 1e9) return [(b / 1e9).toFixed(b >= 1e10 ? 0 : 1), "GB/s"];
      if (b >= 1e6) return [(b / 1e6).toFixed(b >= 1e7 ? 0 : 1), "MB/s"];
      if (b >= 1e4) return [String(Math.round(b / 1e3)), "KB/s"];
      if (b >= 1e3) return [(b / 1e3).toFixed(1), "KB/s"];
      return [String(Math.round(b)), "B/s"];
    },
    rateStr(b) { return fmt.rate(b).join(" "); },
    // 6 d 22 h / 1 h 25 m / 6 m 46 s; one unit when `two` is false. No-break spaces: never wraps.
    dur(s, two) {
      s = Math.max(0, Math.round(s));
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
      const out = d ? [[d, "d"], [h, "h"]] : h ? [[h, "h"], [m, "m"]] : m ? [[m, "m"], [x, "s"]] : [[x, "s"]];
      return (two === false ? out.slice(0, 1) : out).map(([v, u]) => v + NBSP + u).join(NBSP);
    },
    // three units, as the weekly countdowns print it: 6 d 22 h 34 m
    span(s) { return Kiln.fmt.span(s).replace(/ /g, NBSP); },
    // the same with small units, for the large fact figures
    spanHTML(s, three) {
      const str = three ? Kiln.fmt.span(s) : fmt.dur(s).replace(/ /g, " ");
      return str.replace(/(\d+) ([dhms])/g, "$1<small class=\"u\">$2</small>");
    },
    // m:ss, or h:mm:ss past an hour
    stopwatch(s) {
      s = Math.max(0, Math.round(s));
      const m = Math.floor(s / 60), x = s % 60;
      return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
    },
    int: (n) => (n == null ? "–" : INT.format(Math.round(n))),
    hm(t) { return Kiln.fmt.clock(t).replace(" ", NBSP); },
    // Wed 11 Nov
    day(t) {
      const d = new Date(t * 1000);
      return DATE.wd.format(d) + " " + d.getDate() + " " + DATE.mo.format(d);
    },
    gib: (b) => b / 2 ** 30,
  };

  // text and markup written only when they change: no relayout on an unchanged tick
  function txt(el, s) { if (el && el._s !== s) { el._s = s; el.textContent = s; } }
  function htm(el, s) { if (el && el._h !== s) { el._h = s; el.innerHTML = s; } }
  function attr(el, k, v) { v = String(v); if (el && el.getAttribute(k) !== v) el.setAttribute(k, v); }
  // one inline style property, and a class list, written only when they change
  function css(el, k, v) { if (el && el["_" + k] !== v) { el["_" + k] = v; el.style[k] = v; } }
  function cls(el, v) { if (el && el._cls !== v) { el._cls = v; el.className = v; } }

  // Geometry that cannot move on the compositor (an SVG path's end, a chart bar's height) glides
  // only when Kiln.glide says so (periods of 400 ms and up); faster, it is set once per line,
  // because every glide frame repaints its SVG. Bars, rows and scrolls use CSS transitions
  // instead (index.html). Each value is held to the segment it travels, so it never overshoots.
  const clampTo = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  function tween(key, from, to, fn, ms, ease) {
    if (!Kiln.glide) return Kiln.tweenKey(key, to, to, fn);   // cancels a running glide, lands
    const lo = Math.min(from, to), hi = Math.max(from, to);
    return Kiln.tweenKey(key, from, to, (v) => fn(clampTo(v, lo, hi)), ms, ease);
  }
  function num(el, opts) {
    opts = opts || {};
    const f = opts.fmt || ((v) => String(Math.round(v)));
    let lo = -Infinity, hi = Infinity, shown = null;
    const n = Kiln.num(el, Object.assign({}, opts, { fmt: (v) => f((shown = clampTo(v, lo, hi))) }));
    return {
      set(v) {
        if (shown == null || v == null || !isFinite(v)) { lo = -Infinity; hi = Infinity; }
        else { lo = Math.min(shown, v); hi = Math.max(shown, v); }
        if (v == null || !isFinite(v)) shown = null;
        n.set(v);
      },
      get value() { return shown; },
    };
  }

  // a live number with a unit that is set smaller: the figure tweens, the unit follows
  function unum(el, unitEl, split, opts) {
    let unit = null;
    return num(el, Object.assign({}, opts, {
      fmt(v) {
        const [a, u] = split(v);
        if (u !== unit) { unit = u; unitEl.textContent = u; }
        return a;
      },
    }));
  }

  function svg(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }
  function el(tag, cls, parent, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }

  // Monotone cubic (Fritsch-Carlson): smooth, never overshoots the data.
  function smoothPath(pts) {
    const n = pts.length;
    if (n < 2) return n ? `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}` : "";
    const dx = [], dy = [], m = [];
    for (let i = 0; i < n - 1; i++) {
      dx.push(pts[i + 1][0] - pts[i][0] || 1e-6);
      dy.push(pts[i + 1][1] - pts[i][1]);
      m.push(dy[i] / dx[i]);
    }
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

  // the smallest step from 1, 2, 2.5, 5 x 10^k that is at least v
  function niceStep(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
    return 10 * p;
  }

  // a cheap content signature, so a chart redraws only when its data changed
  function sig(arr) {
    let h = arr.length;
    for (let i = 0; i < arr.length; i++) h = (h * 31 + Math.round((arr[i] || 0) * 10)) | 0;
    return h;
  }

  // Seeded PRNG, so textures and scenery are the same on every load.
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  window.BK = { fmt, txt, htm, attr, css, cls, tween, num, unum, svg, el, smoothPath, niceStep, sig, rng, NBSP, DATE };
})();
