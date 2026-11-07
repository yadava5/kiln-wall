// kiln-runtime.js: the one live runtime every KilnWall design loads.
//
// THE HOST (KilnWall.app) calls, on window.kiln:
//   update(line)    one JSON line from kiln-feed --stream, every period (100..1000 ms).
//                   `analytics`, `github` and `hist` arrive only on lines where they
//                   changed; this file keeps the last of each, so `Kiln.state` is always
//                   complete. A line with `replay: true` carries only those blocks.
//                   A line with `cached: true` is the host's last saved line, sent at
//                   load before the live feed: rendered in full, page marked stale.
//   config(c)       {design, period_ms, appearance, temp_unit, dock}: on load and whenever
//                   one changes. appearance: "auto" | "light" | "dark";
//                   temp_unit: "F" | "C"; dock: see Kiln.dock (null: no Dock on this display).
//   pause()/resume() the wallpaper is covered, the screen locked, or Low Power Mode.
//
// A DESIGN uses `Kiln` (also window.Kiln):
//   Kiln.on(fn)          fn(state, prev) after every update. Write values here; never
//                        poll. `state` is the merged line (see the field list in
//                        docs/designing.md); `prev` the previous merged state or null.
//   Kiln.state           the latest merged state (null before the first line).
//   Kiln.period          the current refresh period in ms. Tweens last this long, so
//                        motion is continuous at any period: a new value arrives exactly
//                        as the last tween ends.
//   Kiln.onPeriod(fn)    fn(ms) when the user changes the period.
//   Kiln.onBeat(fn)      fn(state) for the live dot's pulse: at most about once a second
//                        whatever the period. Never pulse the dot from Kiln.on.
//   Kiln.stale           true (and html.kiln-stale) once lines stop for max(3 periods,
//                        2.5 s); dim the live dot on it.
//   Kiln.num(el, opts)   a live number in element `el`; .set(v) tweens to v over one
//                        period. opts: {fmt: v => string, ease: 'out'|'linear',
//                        snap: true (no tween)}. Uses tabular figures; the text is
//                        written only when the formatted string changes.
//   Kiln.tween(from, to, fn, ms)  calls fn(value) every frame until done (ms defaults
//                        to the period). Returns a cancel function. A new tween on the
//                        same key via Kiln.tweenKey(key, ...) cancels the old one.
//   Kiln.loop(fn, {fps}) a continuous effect (rain, drifting clouds). fn(t, dt) runs at
//                        most `fps` times a second (default 30) while the wallpaper is
//                        visible; returns a stop function. Paused with the wallpaper.
//   Kiln.series(key)     the client-side history of one tracked value as
//                        [{t, v}], newest last (see Kiln.track).
//   Kiln.track(key, get, seconds)  records get(state) on every update, kept `seconds`.
//                        Seeded from the feed's `hist` block when the key matches one
//                        of its series (cpu, gpu, mem, rx, tx, rd, wr, out_15m), or
//                        "core:0".."core:9" (seeded from hist.cores).
//   Kiln.reduced         true under prefers-reduced-motion: tweens snap, loops do not run.
//   Kiln.appearance      "auto" | "light" | "dark", from the host's menu. "auto" means
//                        the design's own day/night rule (the sun); "light"/"dark" force
//                        its day or night look. Also on <html data-kiln-appearance>.
//   Kiln.tempUnit        "F" | "C". The feed is always Celsius (temp_c, feels_c, dew_c):
//                        print temperatures only through Kiln.fmt.temp / tempValue.
//                        Also on <html data-kiln-temp-unit>.
//                        Wind follows the same choice: print wind_kmh only through
//                        Kiln.fmt.wind (mph under F, km/h under C).
//   Kiln.onPrefs(fn)     fn({appearance, tempUnit}) when either changes; re-render then.
//   Kiln.dock            where the Dock is on this display, live (the request, 2026-11-05: "the dock
//                        can lengthen and shorten; if I open multiple apps, it might get longer
//                        … adjust the things on top and bottom when the dock lengthens"):
//                          { side: "left"|"bottom"|"right", y0, y1, x0, x1, thickness,
//                            autohide: bool, exact: bool }  or null (no Dock here / not told yet)
//                        Page points, top-left origin. x0..x1 × y0..y1 is the area the Dock
//                        covers when SHOWN, even while it auto-hides. Left Dock: x0 = 0,
//                        x1 = thickness, y0..y1 its tile span (it grows and shrinks about its
//                        centre, 40 pt per app at tile size 38). Right: x0 = width - thickness.
//                        Bottom: y0 = height - thickness, y1 = height, x0..x1 the tile span.
//                        thickness = the Dock's shown width plus the system's margin (58 pt at
//                        tile size 38). exact: true when the host read it from the Dock through
//                        Accessibility; false when estimated from the Dock's preferences and the
//                        running apps (measured 1 pt off). The host re-reads it on app launch and
//                        quit, screen changes and every 5 s, and sends it only when it changed.
//   Kiln.onDock(fn)      fn(dock) once at once (dock may still be null), then on every change:
//                        lay out the strips above and below the Dock there. Never per line.
//   Kiln.fmt            shared formatters (tokens, bytes, rate, pct, temp, tempValue,
//                        wind, clock, until, ago). fmt.wind(kmh, {unit, digits}): "10 mph"
//                        under F, "16 km/h" under C; unit false -> number only, "only" ->
//                        the unit word only.
//
// ONE animation frame loop for the whole page. It runs only while a tween or a loop
// is active; an idle page draws nothing between updates.
//
// DEVELOPING WITHOUT THE HOST: open index.html?fixture[&period=250][&home] in Chrome.
// The runtime loads ../_shared/fixture.js (a synthetic demo feed, demo/make-fixture.mjs) and replays it at the
// period, looping. ?home draws the real Dock and notch on top (../_shared/homescreen.js);
// once Kiln.dock is known the overlay's Dock is placed from it, with the area it covers
// outlined (dashed). ?dock=y0,y1[,thickness] sets Kiln.dock to a left Dock with that tile
// span (thickness default 58, autohide true, exact false) and wins over the host's value:
// try ?dock=236,780 (one app more than ?dock=256,760) to see a layout follow it.
(function () {
  "use strict";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const listeners = [], periodListeners = [];
  const tweens = new Map();          // id -> {from, to, fn, start, ms, ease}
  const loops = new Set();           // {fn, every, last}
  let tweenSeq = 0, raf = 0, paused = false;
  let period = 1000, design = null, configured = false;
  // User preferences from the host's menu (settings.json): appearance and temperature unit.
  const prefs = { appearance: "auto", tempUnit: "F" };
  const prefsListeners = [];
  let state = null;
  const keep = {};                   // analytics, github, hist: last seen
  const tracked = new Map();         // key -> {get, seconds, data: [{t, v}]}

  // ---------- frame loop ----------
  // Measured 2026-11-04 in KilnWall --measure: with tweens lasting a whole period
  // the page animated at 60 fps without a break, and every design cost 9-12% of a
  // core plus 9-15% GPU, against 0.6%/0.1% for an empty page on the same feed.
  // So frames are capped (maxFps) and a tween lasts part of the period, leaving the
  // page idle between updates. timer = a pending setTimeout to the next due frame.
  let maxFps = 20, lastFrame = -1e9, timer = 0;
  // Cheap self-measurement for development (no profiler in the loop): runtime frames
  // and updates since load. ?stats draws them, per second, in a corner.
  const stats = { frames: 0, updates: 0, t0: performance.now() };
  function frame() {
    raf = 0;
    // One clock for tween starts and frames: performance.now(), not rAF's
    // frame-start timestamp (which can precede a tween made in the same frame).
    const now = performance.now();
    lastFrame = now;
    stats.frames++;
    for (const [id, tw] of tweens) {
      // rAF's timestamp is the frame's start, which can precede a tween created
      // later in the same frame: clamp at 0 or values jump backwards (seen as a
      // CPU of "8019.6%" mid-tween in headless Chrome).
      const k = tw.ms <= 0 ? 1 : Math.max(0, Math.min(1, (now - tw.start) / tw.ms));
      const e = tw.ease === "linear" ? k : 1 - Math.pow(1 - k, 3);
      tw.fn(tw.from + (tw.to - tw.from) * e);
      if (k >= 1) tweens.delete(id);
    }
    if (!paused && !reduced) {
      for (const lp of loops) {
        if (now - lp.last >= lp.every) {
          const dt = lp.last ? (now - lp.last) / 1000 : 0;
          lp.last = now;
          lp.fn(now / 1000, dt);
        }
      }
    }
    schedule(now);
  }
  // The next frame: as soon as the cap allows while a tween runs; otherwise when the
  // soonest loop is due. Sleeps in a timer, not in back-to-back rAF callbacks.
  function schedule(now) {
    if (raf || timer) return;
    const looping = loops.size && !paused && !reduced;
    if (!tweens.size && !looping) return;
    let due = lastFrame + 1000 / maxFps;
    if (!tweens.size) {
      let soon = Infinity;
      for (const lp of loops) soon = Math.min(soon, lp.last + lp.every);
      due = Math.max(due, soon);
    }
    const wait = due - now;
    if (wait <= 4) raf = requestAnimationFrame(frame);
    else timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(frame); }, wait - 2);
  }
  function wake() {
    if (raf) return;
    if (timer) { clearTimeout(timer); timer = 0; }
    schedule(performance.now());
  }

  // A tween lasts 60% of the period, at most 400 ms, so motion lands well before the
  // next value arrives and the page idles in between. A longer ms is clamped to this
  // (a design passing Kiln.period would otherwise animate without a break); shorter
  // ones (fades) are kept.
  function tweenMs() { return Math.min(400, Math.round(period * 0.6)); }
  // Text glides only at 400 ms and slower. Faster, a value changes before a glide could
  // be seen, and every glide frame repaints text (measured: snapping Glass's figures
  // took it from 8.2% to 3.7% WebContent and 10.0% to 2.8% GPU at 300 ms).
  function glide() { return period >= 400 && !reduced; }

  function tween(from, to, fn, ms, ease, id) {
    id = id || "t" + ++tweenSeq;
    ms = ms == null ? tweenMs() : Math.min(ms, tweenMs());
    if (reduced || paused || from === to || !isFinite(from) || !isFinite(to)) {
      tweens.delete(id);
      fn(to);
      return () => {};
    }
    tweens.set(id, { from, to, fn, ms, ease: ease || "out", start: performance.now() });
    wake();
    return () => tweens.delete(id);
  }

  // ---------- live numbers ----------
  function num(el, opts) {
    opts = opts || {};
    const fmt = opts.fmt || ((v) => String(Math.round(v)));
    let cur = null, shown = null;
    const id = "n" + ++tweenSeq;
    if (el && el.style) el.style.fontVariantNumeric = "tabular-nums";
    function paint(v) {
      cur = v;
      const s = fmt(v);
      if (s !== shown) { shown = s; el.textContent = s; }
    }
    return {
      set(v) {
        if (v == null || !isFinite(v)) { tweens.delete(id); cur = null; shown = "–"; el.textContent = opts.empty || "–"; return; }
        if (cur == null || opts.snap || !glide()) { tweens.delete(id); paint(v); return; }
        tween(cur, v, paint, opts.ms, opts.ease, id);
      },
      get value() { return cur; },
    };
  }

  // ---------- history ----------
  const HIST_KEYS = ["cpu", "gpu", "mem", "rx", "tx", "rd", "wr", "out_15m"];
  function track(key, get, seconds) {
    const tr = { get, seconds: seconds || 120, data: [] };
    tracked.set(key, tr);
    if (keep.hist) seed(key, tr);
    if (state) record(state);
    return () => tracked.delete(key);
  }
  function seed(key, tr) {
    const h = keep.hist;
    if (!h || !h.t) return;
    let col;
    const core = /^core:(\d+)$/.exec(key);          // "core:0".."core:9" from hist.cores
    if (core && h.cores) col = h.cores.map((c) => (c ? c[+core[1]] : null));
    else if (HIST_KEYS.includes(key) && h[key]) col = h[key];
    else return;
    const old = h.t.map((t, i) => ({ t, v: col[i] })).filter((p) => p.v != null);
    const first = tr.data.length ? tr.data[0].t : Infinity;
    tr.data = old.filter((p) => p.t < first).concat(tr.data);
  }
  function record(s) {
    const t = s.t || Date.now() / 1000;
    for (const tr of tracked.values()) {
      let v;
      try { v = tr.get(s); } catch (e) { v = null; }
      if (v == null || !isFinite(v)) continue;
      tr.data.push({ t, v });
      const cut = t - tr.seconds;
      let i = 0;
      while (i < tr.data.length && tr.data[i].t < cut) i++;
      if (i) tr.data.splice(0, i);
    }
  }

  // ---------- formatters ----------
  const fmt = {
    tokens(v) {
      if (v == null) return "–";
      const a = Math.abs(v);
      if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
      if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
      if (a >= 1e4) return (v / 1e3).toFixed(0) + "k";
      if (a >= 1e3) return (v / 1e3).toFixed(1) + "k";
      return String(Math.round(v));
    },
    int(v) { return v == null ? "–" : Math.round(v).toLocaleString("en-US"); },
    bytes(v) {
      if (v == null) return "–";
      const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
      while (Math.abs(v) >= 1000 && i < u.length - 1) { v /= 1000; i++; }
      return (Math.abs(v) >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + " " + u[i];
    },
    rate(bps) { return bps == null ? "–" : fmt.bytes(bps) + "/s"; },
    pct(v, d) { return v == null ? "–" : v.toFixed(d == null ? 0 : d) + "%"; },
    // Celsius (the feed's unit) -> the user's unit, as a number. Kiln.fmt.temp for text.
    tempValue(c) { return c == null ? null : prefs.tempUnit === "C" ? c : c * 9 / 5 + 32; },
    // Celsius -> "53°" (bare) or with opts.unit true "53 °F". opts.digits: decimals (0).
    temp(c, opts) {
      const v = fmt.tempValue(c);
      if (v == null) return "–";
      const s = v.toFixed(opts && opts.digits || 0).replace(/^-0(\.0+)?$/, "0$1");
      return opts && opts.unit ? s + " °" + prefs.tempUnit : s + "°";
    },
    // Wind: km/h (the feed's wind_kmh) -> the unit that goes with Kiln.tempUnit:
    // mph under F, km/h under C. "10 mph" / "16 km/h". opts.unit: false -> the number
    // only ("10"); "only" -> the unit only ("mph"), for a figure and its unit in two
    // boxes. opts.digits: decimals (0).
    wind(kmh, opts) {
      const u = prefs.tempUnit === "C" ? "km/h" : "mph";
      if (opts && opts.unit === "only") return u;
      if (kmh == null || !isFinite(kmh)) return "–";
      const s = (u === "mph" ? kmh / 1.609344 : +kmh).toFixed(opts && opts.digits || 0);
      return opts && opts.unit === false ? s : s + " " + u;
    },
    clock(t, opts) {   // epoch seconds -> "9:25 pm"
      const d = new Date(t * 1000);
      let h = d.getHours(); const m = d.getMinutes();
      if (opts && opts.h24) return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
      const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
      return h + ":" + String(m).padStart(2, "0") + " " + ap;
    },
    // Seconds -> "6 d 22 h 34 m" (largest three units, as every v2 concept prints it).
    span(sec) {
      if (sec == null || !isFinite(sec)) return "–";
      sec = Math.max(0, Math.round(sec));
      const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
      if (d) return d + " d " + h + " h " + m + " m";
      if (h) return h + " h " + m + " m";
      if (m) return m + " m " + s + " s";
      return s + " s";
    },
    until(t, now) { return fmt.span(t - now); },
    ago(t, now) { return fmt.span(now - t) + " ago"; },
    // "Wed 11 Nov 8:00 pm"
    date(t) {
      const d = new Date(t * 1000);
      const wd = d.toLocaleDateString("en-US", { weekday: "short" });
      const mo = d.toLocaleDateString("en-US", { month: "short" });
      return wd + " " + d.getDate() + " " + mo + " " + fmt.clock(t);
    },
  };

  // ---------- the host-facing API ----------
  // kiln-feed sends these only on lines where they changed: keep the last of each.
  const STICKY = [["weather"], ["claude", "events"], ["claude", "limits"], ["claude", "tokens"]];
  const sticky = new Map();
  function fillSticky(line) {
    for (const path of STICKY) {
      const key = path.join(".");
      let parent = line;
      for (const p of path.slice(0, -1)) parent = parent && parent[p];
      if (!parent || typeof parent !== "object") continue;
      const leaf = path[path.length - 1];
      if (leaf in parent) sticky.set(key, parent[leaf]);
      else if (sticky.has(key) && !line.replay) parent[leaf] = sticky.get(key);
    }
  }

  function applySticky(obj) {
    for (const path of STICKY) {
      const key = path.join(".");
      if (!sticky.has(key)) continue;
      let parent = obj;
      for (const p of path.slice(0, -1)) {
        parent[p] = Object.assign({}, parent[p]);
        parent = parent[p];
      }
      parent[path[path.length - 1]] = sticky.get(key);
    }
    return obj;
  }

  function update(line) {
    // The host passes the raw line text (cheaper than bridging a 10 KB object).
    if (typeof line === "string") { try { line = JSON.parse(line); } catch (e) { return; } }
    if (!line || typeof line !== "object") return;
    fillSticky(line);     // records sticky blocks present; fills absent ones (not on replay)
    for (const k of ["analytics", "github", "hist"]) if (line[k] !== undefined) keep[k] = line[k];
    if (line.hist) for (const [k, tr] of tracked) seed(k, tr);
    if (line.replay) {
      // A page that (re)loaded mid-stream: the host replays every on-change block.
      if (state) { state = applySticky(Object.assign({}, state, keep)); for (const fn of listeners) safe(fn, state, state); }
      return;
    }
    // The host's config() is authoritative: a line already in flight when the user
    // changes the period still carries the old one. A line's own period counts only
    // until the first config() arrives (dev replay, or a host that never sends it).
    if (!configured && line.feed && line.feed.period_ms && line.feed.period_ms !== period) setPeriod(line.feed.period_ms);
    const prev = state;
    stats.updates++;
    state = Object.assign({}, line, keep);
    record(state);
    for (const fn of listeners) safe(fn, state, prev);
    if (line.cached) {
      // The host's last saved line, shown at load before the feed's first live line
      // (a cold start takes ~1.3 s): full content, marked stale, no beat.
      stale = true; document.documentElement.classList.add("kiln-stale");
    } else heartbeat();
    if (!painted) {
      // Tell the host the first full frame is on screen (two frames after the first
      // line), so it can lift the snapshot it holds over a reloading page. The page
      // never shows blank (2026-11-05).
      painted = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.kiln;
        if (h) h.postMessage({ painted: true, at: performance.now() });
      }));
    }
  }
  let painted = false;

  // The live dot's heartbeat. A dot that pulses on every line strobes at 100 ms
  // (review, 2026-11-05: "a dot flickering continuously, which is very annoying"),
  // so it beats at most about once a second: on every line at 1000 ms, on the
  // first line past ~0.9 s at 300 ms, once a second at 100 ms. If lines stop for
  // max(3 periods, 2.5 s) the page gets the class `kiln-stale` until one arrives.
  let lastBeat = -1e9, staleTimer = 0;
  function heartbeat() {
    const now = performance.now();
    if (now - lastBeat >= 1000 - period * 0.5) {
      lastBeat = now;
      for (const fn of beatListeners) safe(fn, state);
    }
    clearTimeout(staleTimer);
    if (stale) { stale = false; document.documentElement.classList.remove("kiln-stale"); }
    staleTimer = setTimeout(() => {
      if (paused) return;
      stale = true; document.documentElement.classList.add("kiln-stale");
    }, Math.max(3 * period, 2500));
  }
  const beatListeners = [];
  let stale = false;
  function safe(fn, a, b) {
    try { fn(a, b); } catch (e) {
      console.error(e);
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.kiln) {
        window.webkit.messageHandlers.kiln.postMessage({ error: String(e && e.stack || e).slice(0, 500) });
      }
    }
  }
  function setPeriod(ms) {
    ms = Math.max(100, Math.min(1000, Math.round(ms)));
    if (ms === period) return;
    period = ms;
    document.documentElement.style.setProperty("--kiln-period", ms + "ms");
    document.documentElement.style.setProperty("--kiln-tween", tweenMs() + "ms");
    for (const fn of periodListeners) safe(fn, ms);
  }

  function setPrefs(p) {
    let changed = false;
    if (p.appearance && /^(auto|light|dark)$/.test(p.appearance) && p.appearance !== prefs.appearance) {
      prefs.appearance = p.appearance; changed = true;
    }
    const u = p.temp_unit && String(p.temp_unit).toUpperCase();
    if (u && /^[CF]$/.test(u) && u !== prefs.tempUnit) { prefs.tempUnit = u; changed = true; }
    const root = document.documentElement;
    root.dataset.kilnAppearance = prefs.appearance;
    root.dataset.kilnTempUnit = prefs.tempUnit;
    if (changed) for (const fn of prefsListeners) safe(fn, Object.assign({}, prefs));
  }

  // ---------- the Dock (Kiln.dock) ----------
  // From the host's config; a dev ?dock= override wins. Listeners run only when a value
  // changes, and the page echoes the Dock it holds to the host (its log shows it).
  let dock = null, dockOverride = null;
  const dockListeners = [];
  function normDock(d) {
    if (!d || typeof d !== "object" || !/^(left|bottom|right)$/.test(d.side)) return null;
    const n = { side: d.side };
    for (const k of ["y0", "y1", "x0", "x1", "thickness"]) {
      if (!Number.isFinite(+d[k])) return null;
      n[k] = +d[k];
    }
    n.autohide = !!d.autohide;
    n.exact = !!d.exact;
    return Object.freeze(n);
  }
  function sameDock(a, b) {
    if (!a || !b) return a === b;
    return ["side", "y0", "y1", "x0", "x1", "thickness", "autohide", "exact"].every((k) => a[k] === b[k]);
  }
  function setDock(d, fromHost) {
    if (fromHost && dockOverride) return;
    const n = normDock(d);
    if (sameDock(n, dock)) return;
    dock = n;
    for (const fn of dockListeners) safe(fn, dock);
    homeDock();
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.kiln;
    if (h) h.postMessage({ dock });
  }
  // ?home: put homescreen.js's Dock where Kiln.dock says, and outline the area it covers.
  function homeDock() {
    const el = document.querySelector(".hs-dock");
    if (!el || !dock) return;
    const d = dock, s = el.style, side = d.side === "bottom";
    Object.assign(s, { transform: "none", padding: "0", gap: "0", boxSizing: "border-box",
      justifyContent: "space-evenly", overflow: "hidden", flexDirection: side ? "row" : "column" });
    if (side) {
      Object.assign(s, { left: d.x0 + "px", width: d.x1 - d.x0 + "px", top: d.y0 + 4 + "px", height: d.thickness - 8 + "px" });
    } else {
      Object.assign(s, { left: d.x0 + 4 + "px", width: d.thickness - 8 + "px", top: d.y0 + "px", height: d.y1 - d.y0 + "px" });
    }
    let area = document.querySelector(".hs-dock-area");
    if (!area) {
      area = document.createElement("div");
      area.className = "hs-dock-area";
      area.style.cssText = "position:fixed;z-index:99997;pointer-events:none;box-sizing:border-box;" +
        "border:1px dashed rgba(255,96,96,.75)";
      document.body.appendChild(area);
    }
    Object.assign(area.style, { left: d.x0 + "px", top: d.y0 + "px", width: d.x1 - d.x0 + "px", height: d.y1 - d.y0 + "px" });
  }

  window.kiln = {
    update,
    config(c) {
      if (c && c.period_ms) { configured = true; setPeriod(c.period_ms); }
      if (c && c.design) design = c.design;
      if (c) setPrefs(c);
      if (c && "dock" in c) setDock(c.dock, true);
    },
    pause() { paused = true; document.documentElement.classList.add("kiln-paused"); },
    resume() { paused = false; document.documentElement.classList.remove("kiln-paused"); for (const lp of loops) lp.last = 0; wake(); },
  };

  window.Kiln = {
    on(fn) { listeners.push(fn); if (state) safe(fn, state, null); },
    onPeriod(fn) { periodListeners.push(fn); },
    onBeat(fn) { beatListeners.push(fn); },   // the live dot: at most ~1 beat a second
    onPrefs(fn) { prefsListeners.push(fn); },  // fn({appearance, tempUnit}) on a change
    onDock(fn) { dockListeners.push(fn); safe(fn, dock); },  // once now, then on every change
    get dock() { return dock; },
    get appearance() { return prefs.appearance; },
    get tempUnit() { return prefs.tempUnit; },
    get stale() { return stale; },
    get state() { return state; },
    get period() { return period; },
    get design() { return design; },
    get paused() { return paused; },
    get maxFps() { return maxFps; },
    set maxFps(v) { maxFps = Math.max(5, Math.min(60, +v || 24)); },
    get tweenMs() { return tweenMs(); },
    get glide() { return glide(); },      // true: text may glide; false: set text directly
    reduced, num, fmt, track,
    series(key) { const tr = tracked.get(key); return tr ? tr.data : []; },
    tween(from, to, fn, ms, ease) { return tween(from, to, fn, ms, ease); },
    tweenKey(key, from, to, fn, ms, ease) { return tween(from, to, fn, ms, ease, "k:" + key); },
    loop(fn, opts) {
      const lp ={ fn, every: 1000 / ((opts && opts.fps) || 30), last: 0 };
      loops.add(lp); wake();
      return () => loops.delete(lp);
    },
  };
  document.documentElement.style.setProperty("--kiln-period", period + "ms");
  document.documentElement.style.setProperty("--kiln-tween", tweenMs() + "ms");
  window.Kiln.stats = stats;

  // ---------- dev mode: replay a captured feed in a plain browser ----------
  const q = new URLSearchParams(location.search);
  const base = (document.currentScript && document.currentScript.src || "").replace(/kiln-runtime\.js.*$/, "");
  // ?dock=y0,y1[,thickness]: a left Dock with that tile span, over the host's.
  const dq = (q.get("dock") || "").split(",").map(Number);
  if (dq.length >= 2 && dq.slice(0, 3).every(Number.isFinite)) {
    const t = dq[2] || 58;
    dockOverride = { side: "left", y0: dq[0], y1: dq[1], x0: 0, x1: t, thickness: t, autohide: true, exact: false };
    setDock(dockOverride, false);
  }
  if (q.has("home")) {
    const s = document.createElement("script");
    s.src = base + "homescreen.js";
    s.onload = homeDock;
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(s));
  }
  // ?appearance=auto|light|dark and ?unit=C|F stand in for the host's menu in dev.
  setPrefs({ appearance: q.get("appearance") || undefined, temp_unit: q.get("unit") || undefined });
  const hosted = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.kiln);
  if (!hosted && q.has("fixture")) {
    const s = document.createElement("script");
    s.src = base + "fixture.js";
    s.onload = () => {
      const F = window.KILN_FIXTURE;
      if (!F) return;
      setPeriod(+q.get("period") || 250);
      // The capture ran at 250 ms; replay one captured line per period, loop.
      // Line 0 carries analytics, github and hist; the rest are plain lines.
      // Time stays the capture's own (designs must read "now" from state.t, never
      // Date.now()), advancing by the capture's length on every loop.
      let i = 0;
      const span = F.lines[F.lines.length - 1].t - F.lines[0].t + 0.25;
      function next() {
        const L = Object.assign({}, F.lines[i % F.lines.length]);
        L.t = L.t + Math.floor(i / F.lines.length) * span;
        L.feed = Object.assign({}, L.feed, { period_ms: period });
        update(L);
        i++;
        if (q.has("still") && i >= +(q.get("still") || 8)) {   // stop for screenshots
          // Headless frames lag real time and stop arriving, so land every tween now.
          setTimeout(() => {
            for (const [id, tw] of tweens) { tw.fn(tw.to); tweens.delete(id); }
          }, period);
          return;
        }
        setTimeout(next, period);
      }
      next();
    };
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(s));
  }
})();
