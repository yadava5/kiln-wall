// Bento Keynote, live. Every figure is recomputed from Kiln.state on each feed line and
// "now" is always state.t. Tiles never move. Figures are set directly below 400 ms periods and
// glide above (Kiln.num); bars, rows and the network trace get one new transform per line and a
// CSS transition carries it; charts redraw only when their data (or their time axis, by half a
// pixel) moved. Between lines the runtime draws nothing for this page but the weather.
(function () {
  "use strict";
  const { fmt, txt, htm, attr, css, cls, tween, num, unum, svg, el, smoothPath, niceStep, sig, DATE } = BK;
  const $ = (id) => document.getElementById(id);
  const Q = new URLSearchParams(location.search);
  const HOSTED = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.kiln);
  const root = document.documentElement;

  // ---------- preset (config.js; ?preset= and ?theme= override it for development) ----------
  const CFG = (() => {
    const C = window.BENTO_CONFIG || {};
    const name = Q.get("preset") || C.preset || "keynote";
    const p = Object.assign({ theme: "auto", layout: "keynote", private: false }, (C.presets || {})[name]);
    if (Q.get("theme")) p.theme = Q.get("theme");
    return p;
  })();
  root.dataset.layout = CFG.layout;
  if (CFG.private) root.classList.add("private");
  // Which theme wins: a dev ?theme=, then the host's appearance menu (Kiln.appearance "light" or
  // "dark"), then the preset's own; "auto" follows the sun and "system" the system appearance.
  const pinOf = () => (Q.get("theme") ? CFG.theme : Kiln.appearance !== "auto" ? Kiln.appearance : CFG.theme);
  // The theme is the interface only. The weather window always shows the real sky: the sun from
  // today's sunrise and sunset against state.t, the real weather.kind (README, Preferences:
  // "Weather and sky are never fabricated"). Dark at noon is a bright day behind dark tiles.
  if (pinOf() === "dark" || pinOf() === "light") root.dataset.theme = pinOf();

  const WEEK = 7 * 86400;
  const MODEL = (m) => {
    const k = m && String(m).match(/claude-([a-z]+)/);
    return k ? k[1][0].toUpperCase() + k[1].slice(1) : "";
  };
  const STATE = {
    waiting: { label: "Waiting", rank: 0 },
    failed: { label: "Failed", rank: 1 },
    working: { label: "Working", rank: 2 },
    // its own turn is over and its agents still work; "background" read as the BG tag beside it
    background: { label: "On agents", rank: 3 },
    idle: { label: "Idle", rank: 4 },
  };
  // How to count sessions (README): headline counts are interactive sessions (open in a
  // terminal); kind "bg" (hosted by the daemon, no window) is counted apart with its real
  // state. A missing kind is interactive. An idle session is never "running".
  const isBg = (x) => x.kind === "bg";
  const stOf = (x) => (STATE[x.state] ? x.state : "idle");
  // state "background" is a session whose own turn is over while its agents still work
  const BG_WORD = { waiting: "waiting", failed: "failed", working: "working", background: "waiting on agents", idle: "idle" };
  const RUNNING = { working: 1, waiting: 1, background: 1 };
  // "2 working, 1 waiting on agents": every state present, in STATE order
  function stateWords(list, word) {
    const c = {};
    list.forEach((x) => (c[stOf(x)] = (c[stOf(x)] || 0) + 1));
    return Object.keys(STATE).filter((k) => c[k]).map((k) => `${c[k]} ${(word || BG_WORD)[k]}`);
  }
  function bgNote(bg) {
    if (!bg.length) return "";
    const w = stateWords(bg);
    return w.length === 1 ? `${bg.length} in the background, ${w[0].replace(/^\d+ /, "")}`
      : `${bg.length} in the background: ${w.join(", ")}`;
  }
  const shortClock = (t) => Kiln.fmt.clock(t).replace(":00", "");
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
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
  // The label of a chart's average line, kept off the data. slots: [start x, below the line]
  // in order of preference. It keeps its slot while that stays clear, else takes the first
  // clear one; it jumps between fixed slots, never slides (rule 13). With no clear slot it
  // takes the least crossed one and a plate in the tile's tone goes behind it, so the trace
  // passes under a plate rather than through the glyphs. Returns [slot index, plate?].
  function placeAvg(cur, slots, cost) {
    const c = slots.map(cost);
    if (c[cur] === 0) return [cur, false];
    const k = c.indexOf(0);
    if (k >= 0) return [k, false];
    let m = 0;
    c.forEach((v, i) => { if (v < c[m]) m = i; });
    return [m, true];
  }

  // Screen-share preset: session names, tasks, questions and repo names never reach the DOM.
  const alias = new Map();
  const nameOf = (s) => {
    if (!CFG.private) return s.name || (s.sid || "").slice(0, 8);
    if (!alias.has(s.sid)) alias.set(s.sid, "Session " + (alias.size + 1));
    return alias.get(s.sid);
  };
  const priv = (s, hidden) => (CFG.private ? hidden : s);

  // ---------- development: weather override and simulated states (never under the host) ----------
  const KIND_TEXT = { clear: "Clear", partly: "Partly cloudy", cloudy: "Overcast", fog: "Fog", drizzle: "Light drizzle", rain: "Rain", snow: "Snow", storm: "Thunderstorm" };
  let simT0 = null;
  function view(s) {
    let w = s.weather;
    if (Q.has("weather") || Q.has("day") || Q.has("night")) {
      w = Object.assign({ place: "", temp_c: null, feels_c: null, kind: "cloudy", text: "", cloud: 80, humidity: null, precip_mm: null,
        rain_mm: 0, snow_cm: 0, wind_kmh: 10, wind_dir: 250, is_day: false, sunrise: null, sunset: null }, w || {});
      const k = Q.get("weather");
      if (k && KIND_TEXT[k]) { w.kind = k; w.text = KIND_TEXT[k]; if (k === "clear") w.cloud = 4; if (k === "partly") w.cloud = 45; }
      if (Q.has("day")) w._day = Q.get("day") !== "0";   // ?day=0 is a night, as in Glass
      if (Q.has("night")) w._day = false;
    }
    const sim = !HOSTED && Q.get("sim");
    if (!sim) return Object.assign({}, s, { weather: w });
    if (simT0 == null) simT0 = s.t;
    const c = Object.assign({}, s.claude);
    if (sim.includes("wait") && c.sessions && c.sessions.length > 1) {
      c.sessions = c.sessions.map((x, i) => (i === 2 ? Object.assign({}, x, {
        state: "waiting", since: simT0 - 95,
        ask: { kind: "permission", tool: "Bash", text: "git push origin feat/live-bento --force-with-lease", n: 1 } }) : x));
    }
    if (sim.includes("agents")) {
      c.agents_running = [
        { id: "a1", type: "general-purpose", sid: "x", session: "data-pipeline", desc: "Benchmark the ingest batch sizes", started: simT0 - 2635, idle_s: 4 },
        { id: "a2", type: "researcher", sid: "x", session: "design-system", desc: "Compare cache eviction policies", started: simT0 - 2256, idle_s: 1320 },
        { id: "a3", type: "designer", sid: "x", session: "mobile-release", desc: "Bento live build", started: simT0 - 300, idle_s: 2 },
      ];
    }
    return Object.assign({}, s, { weather: w, claude: c });
  }

  // ---------- the period readout: a dot that beats about once a second, lit when the period changes ----------
  // README rule 6: the dot beats on Kiln.onBeat, never per line (per line strobed at 100 ms). One
  // soft opacity rise and fall, 0.5 to 1 to 0.5 over 600 ms, by the Web Animations API, so it runs
  // on the compositor and needs no restart trick. Under html.kiln-stale it greys (index.html).
  // The highlight fades out by a CSS transition when .lit goes.
  const pd = { box: $("period"), ms: $("period-ms"), dot: document.querySelector("#period .pd"), until: 0, lit: false };
  const BEAT = [{ opacity: 0.5 }, { opacity: 1, offset: 0.4 }, { opacity: 0.5 }];
  Kiln.onBeat(() => {
    if (!Kiln.reduced && !Kiln.stale && pd.dot.animate) pd.dot.animate(BEAT, { duration: 600, easing: "ease-in-out" });
  });
  function period(s, first) {
    txt(pd.ms, Kiln.period + " ms");
    if (pd.lit && s.t >= pd.until) {
      pd.lit = false;
      pd.box.classList.remove("lit");
    }
    if (first) pd.lit = false;
  }
  Kiln.onPeriod((ms) => {
    txt(pd.ms, ms + " ms");
    pd.lit = true;
    pd.until = (Kiln.state ? Kiln.state.t : 0) + 1.5;
    pd.box.classList.add("lit");
  });

  // ---------- theme: Keynote light between sunrise and sunset when the preset says "auto" ----------
  function isDay(w, t) {
    if (!w) return null;
    if (w._day != null) return w._day;
    if (w.sunrise && w.sunset && t - w.sunrise < 86400) return t >= w.sunrise && t < w.sunset;
    return !!w.is_day;
  }
  function theme(s) {
    const pin = pinOf();
    // written only on a change: a theme attribute on the root restyles the whole page. No
    // attribute ("system", or no reading yet): the CSS follows the system appearance.
    let th = pin === "dark" || pin === "light" ? pin : null;
    if (pin === "auto") { const d = s ? isDay(s.weather, s.t) : null; th = d == null ? null : d ? "light" : "dark"; }
    if ((root.dataset.theme || null) === th) return;
    if (th == null) delete root.dataset.theme;
    else root.dataset.theme = th;
  }

  // =====================================================================================
  // A: weekly limit
  // =====================================================================================
  const wk = (() => {
    // pl 34: the "100%" label ends at pl - 6, so it starts on the tile's text edge instead of 5 px left of it
    const g = $("wk-svg"), W = 434, H = 104, pl = 34, pt = 18, pb = 18;
    const x = (s) => pl + Math.max(0, Math.min(1, s / WEEK)) * (W - pl);
    const y = (p) => pt + (1 - Math.max(0, Math.min(100, p)) / 100) * (H - pt - pb);
    const days = [];
    for (let i = 0; i < 7; i++) {
      svg("rect", { x: x(i * 86400) + 1, y: y(100), width: x(86400) - pl - 2, height: y(0) - y(100), rx: 5, class: i % 2 ? "band-b" : "band-a" }, g);
      days.push(svg("text", { x: x(i * 86400 + 43200), y: H - 3, "text-anchor": "middle", class: "axis" + (i === 6 ? " hi" : "") }, g));
    }
    for (const v of [0, 50, 100]) svg("text", { x: pl - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, g).textContent = v + "%";
    const close = svg("line", { class: "ln-ref", "stroke-dasharray": "2 3" }, g);
    const closeT = svg("text", { class: "axis" }, g);
    const fcL = svg("line", { style: "stroke:var(--burn-1)", "stroke-opacity": 0.75, "stroke-dasharray": "2 3" }, g);
    const fcT = svg("text", { class: "axis burn" }, g);
    svg("line", { x1: W - 1, x2: W - 1, y1: y(100) - 14, y2: y(0), style: "stroke:var(--head)", "stroke-width": 2 }, g);
    const resetT = svg("text", { x: W - 7, y: y(100) - 6, "text-anchor": "end", class: "axis hi" }, g);
    const pace = svg("path", { fill: "none", style: "stroke:var(--burn-2)", "stroke-width": 2, "stroke-dasharray": "3 4", opacity: 0 }, g);
    const paceT = svg("text", { "text-anchor": "end", class: "axis burn", opacity: 0 }, g);
    const used = svg("path", { fill: "none", stroke: "url(#g-burn)", "stroke-width": 4, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
    svg("line", { x1: pl, x2: W, y1: y(0), y2: y(0), class: "ln-grid0" }, g);
    const halo = svg("circle", { r: 8, style: "fill:var(--burn-2)", opacity: 0.25 }, g);
    const head = svg("circle", { r: 4, style: "fill:var(--head)" }, g);
    return {
      x, y, days, close, closeT, fcL, fcT, resetT, pace, paceT, used, halo, head,
      pct: num($("wk-pct")),
      burn: num($("wk-burn"), { fmt: (v) => v.toFixed(1) }),
      headPct: null, pathKey: "",
    };
  })();

  function weekly(s) {
    const L = s.claude.limits || {}, sd = L.seven_day || {}, t = s.t;
    if (!sd.resets_at) return;
    const reset = sd.resets_at, start = reset - WEEK, el_s = t - start;
    wk.pct.set(sd.pct);
    txt($("wk-reset"), fmt.day(reset) + ", " + fmt.hm(reset));
    txt($("wk-left"), fmt.span(reset - t));
    wk.burn.set(sd.burn_per_h);
    // day labels, reset to reset
    wk.days.forEach((d, i) => { const m = new Date((start + i * 86400 + 43200) * 1000); txt(d, DATE.wd.format(m) + " " + m.getDate()); });
    const rd = new Date(reset * 1000);
    txt(wk.resetT, `reset ${DATE.wd.format(rd)} ${rd.getDate()}, ${shortClock(reset)}`);
    // last week's close: the newest history point before this week began
    const hist = (L.history || []).filter((h) => h[2] != null);
    const before = hist.filter((h) => h[0] < start);
    const lc = before.length ? before[before.length - 1][2] : null;
    if (lc != null) {
      const ly = wk.y(lc);
      attr(wk.close, "x1", wk.x(0)); attr(wk.close, "x2", wk.x(86400) - 4); attr(wk.close, "y1", ly); attr(wk.close, "y2", ly);
      attr(wk.closeT, "x", wk.x(86400) + 2); attr(wk.closeT, "y", ly + 4);
      txt(wk.closeT, `last week closed at ${lc}%`);
    }
    for (const e of [wk.close, wk.closeT]) css(e, "display", lc == null ? "none" : "");
    // forecasts begin 12 h in; until then nothing is drawn ahead of now
    const fcAt = start + 43200, forecasting = sd.pace != null && sd.projected != null && t >= fcAt;
    const fx = wk.x(43200);
    attr(wk.fcL, "x1", fx); attr(wk.fcL, "x2", fx); attr(wk.fcL, "y1", wk.y(100) - 14); attr(wk.fcL, "y2", wk.y(0));
    attr(wk.fcT, "x", fx + 5); attr(wk.fcT, "y", wk.y(100) - 6);
    const fd = new Date(fcAt * 1000);
    txt(wk.fcT, `forecast from ${DATE.wd.format(fd)} ${shortClock(fcAt)}`);
    for (const e of [wk.fcL, wk.fcT]) css(e, "display", forecasting ? "none" : "");
    const fc = $("wk-fc"), fck = $("wk-fc-k");
    if (forecasting) {
      const pj = sd.projected;
      htm(fc, `${Math.round(pj)}<small>% at reset</small>`);
      txt(fck, sd.runout_at && sd.runout_at < reset ? "runs out " + fmt.day(sd.runout_at) + ", " + fmt.hm(sd.runout_at) : "on the recent pace");
      css(fc, "color", "");
    } else {
      htm(fc, fmt.spanHTML(Math.max(0, fcAt - t)));
      txt(fck, t < fcAt ? "until it starts" : "waiting on the feed");
      css(fc, "color", "var(--ink-2)");
    }
    // the five-hour window only while Claude Code reports a live one (the plan has none since
    // 2026-10-30): otherwise its fact is not shown at all, no "not reported" and never 0%.
    // Hidden by visibility, so the other two facts keep their columns.
    const five = L.five_hour || {}, fv = $("wk-five"), fk = $("wk-five-k");
    const live5 = five.pct != null && !five.stale;
    css($("wk-five-f"), "visibility", live5 ? "" : "hidden");
    if (live5) {
      htm(fv, `${Math.round(five.pct)}<small>%</small>`);
      txt(fk, five.resets_at ? "resets in " + fmt.dur(five.resets_at - t) : "");
    } else { htm(fv, ""); txt(fk, ""); }
    // used so far: the real 15-minute history this week, stepped, ending at the live head
    const pts = hist.filter((h) => h[0] > start && h[0] <= t);
    const key = pts.length + ":" + (pts.length ? pts[pts.length - 1][0] : 0) + ":" + Math.round(wk.x(el_s) * 2);
    const draw = (hp) => {
      let d = `M${wk.x(0).toFixed(1)},${wk.y(0).toFixed(1)}`;
      for (const h of pts) d += `H${wk.x(h[0] - start).toFixed(1)}V${wk.y(h[2]).toFixed(1)}`;
      const nx = wk.x(el_s), ny = wk.y(hp);
      d += `H${nx.toFixed(1)}V${ny.toFixed(1)}`;
      attr(wk.used, "d", d);
      for (const c of [wk.halo, wk.head]) { attr(c, "cx", nx.toFixed(1)); attr(c, "cy", ny.toFixed(1)); }
      if (forecasting) {
        const pj = Math.min(100, sd.projected), ex = sd.projected > 100 && sd.runout_at ? wk.x(sd.runout_at - start) : wk.x(WEEK);
        attr(wk.pace, "d", `M${nx.toFixed(1)},${ny.toFixed(1)}L${ex.toFixed(1)},${wk.y(pj).toFixed(1)}`);
        attr(wk.paceT, "x", ex - 6); attr(wk.paceT, "y", wk.y(pj) - 8);
      }
    };
    txt(wk.paceT, forecasting ? `on pace for ${Math.round(sd.projected)}%` : "");
    attr(wk.pace, "opacity", forecasting ? 1 : 0); attr(wk.paceT, "opacity", forecasting ? 1 : 0);
    if (wk.headPct == null || key !== wk.pathKey || wk.headPct !== sd.pct) {
      const from = wk.headPct == null ? sd.pct : wk.headPct;
      wk.pathKey = key;
      wk.headPct = sd.pct;
      tween("wk-head", from, sd.pct, draw);
      if (from === sd.pct) draw(sd.pct);
    }
  }

  // =====================================================================================
  // B: needs you
  // =====================================================================================
  const nd = (() => {
    const g = $("nd-svg"), W = 434, H = 46, pl = 4, pr = 4, LO = Math.log10(60), HI = Math.log10(36000);
    const lx = (s) => pl + ((Math.log10(Math.max(60, Math.min(36000, s))) - LO) / (HI - LO)) * (W - pl - pr);
    svg("line", { x1: pl, x2: W - pr, y1: 20, y2: 20, style: "stroke:var(--track)", "stroke-width": 6, "stroke-linecap": "round" }, g);
    const band = svg("line", { y1: 20, y2: 20, style: "stroke:var(--calm)", "stroke-opacity": 0.45, "stroke-width": 6, "stroke-linecap": "round" }, g);
    for (const [s, l] of [[60, "1 m"], [600, "10 m"], [3600, "1 h"], [36000, ""]]) {
      svg("line", { x1: lx(s), x2: lx(s), y1: 26, y2: 30, style: "stroke:var(--ref)" }, g);
      if (l) svg("text", { x: lx(s), y: H - 2, "text-anchor": s === 60 ? "start" : "middle", class: "axis" }, g).textContent = l;
    }
    // this wait, live: an amber run from 1 m to now, under the marks
    const wait = svg("line", { x1: lx(60), x2: lx(60), y1: 20, y2: 20, style: "stroke:var(--amber)", "stroke-width": 6, "stroke-linecap": "round", class: "wait-run" }, g);
    const med = svg("circle", { cy: 20, r: 4.5, style: "fill:var(--calm)" }, g);
    const medT = svg("text", { y: 9, class: "axis hi" }, g);
    const p90 = svg("circle", { cy: 20, r: 4.5, style: "fill:var(--idle)" }, g);
    const p90T = svg("text", { y: 9, class: "axis hi" }, g);
    const max = svg("circle", { cy: 20, r: 3.5, fill: "none", style: "stroke:var(--idle)", "stroke-width": 1.5 }, g);
    const maxT = svg("text", { x: W - pr, y: H - 2, "text-anchor": "end", class: "axis" }, g);
    const last = svg("line", { y1: 13, y2: 27, style: "stroke:var(--head)", "stroke-width": 2 }, g);
    const waitHead = svg("circle", { cy: 20, r: 5.5, style: "fill:var(--amber);stroke:var(--tile)", "stroke-width": 2, class: "wait-run" }, g);
    return { W, lx, band, wait, med, medT, p90, p90T, max, maxT, last, waitHead, mode: null, wx: null, box: $("B"),
      n: num($("nd-n"), { snap: true }) };
  })();

  // the newest ask in the event log, and the answer that followed it in the same session
  function lastAsk(ev) {
    for (let i = ev.length - 1; i >= 0; i--) {
      if (ev[i].kind !== "ask") continue;
      const a = ev[i], ans = ev.slice(i + 1).find((e) => e.kind === "answered" && e.sid === a.sid);
      const m = ans && String(ans.detail || "").match(/([\d.]+)\s*s/);
      return { ask: a, after: m ? +m[1] : null };
    }
    return null;
  }
  // "perm Bash" -> "Bash"
  const askTool = (d) => { const p = String(d || "").trim().split(/\s+/); return p.length > 1 ? p.slice(1).join(" ") : p[0] || "a question"; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function needs(s) {
    const t = s.t, sess = s.claude.sessions || [], A = s.analytics || {}, aw = A.ask_wait || {};
    const waiting = sess.filter((x) => x.state === "waiting");
    const on = waiting.length > 0;
    // interactive sessions head the line; background ones follow, quieter, with their real state
    const open = sess.filter((x) => !isBg(x)), bg = sess.filter(isBg);
    const rest = on ? open.filter((x) => x.state !== "waiting") : open;
    // running means working, waiting or waiting on agents (README); idle is only "open"
    const busy = rest.filter((x) => RUNNING[x.state]).length;
    const head = on ? (rest.length ? `${rest.length} other${rest.length === 1 ? "" : "s"} open` : "No others open")
      : open.length ? `${open.length} open` : "No sessions open";
    const back = bgNote(bg.filter((x) => !on || x.state !== "waiting"));
    htm($("nd-others"), esc(head + (busy ? `, ${busy} running` : "")) +
      (back ? ` <span class="k">${open.length || on ? "+" : ""}${esc(back)}</span>` : ""));
    // the answer-time strip
    const lx = nd.lx, have = aw.count > 0 && aw.median_s != null;
    for (const e of [nd.band, nd.med, nd.medT, nd.p90, nd.p90T, nd.max, nd.maxT]) css(e, "display", have ? "" : "none");
    if (have) {
      attr(nd.band, "x1", lx(aw.median_s)); attr(nd.band, "x2", lx(aw.p90_s));
      attr(nd.med, "cx", lx(aw.median_s)); attr(nd.p90, "cx", lx(aw.p90_s)); attr(nd.max, "cx", lx(aw.max_s));
      const mt = `median ${fmt.dur(aw.median_s)}`, pt = `9 in 10 within ${fmt.dur(aw.p90_s)}`;
      txt(nd.medT, mt); txt(nd.p90T, pt); txt(nd.maxT, `slowest ${fmt.dur(aw.max_s)}`);
      // keep the two labels apart: centred when there is room, pushed outward when not
      const mw = mt.length * 6.1, pw = pt.length * 6.1, mx = lx(aw.median_s), px = lx(aw.p90_s);
      let mA = "middle", mX = mx, pA = "middle", pX = px;
      if (mx + mw / 2 + 10 > px - pw / 2) { mA = "end"; mX = mx + 6; pA = "start"; pX = Math.max(px - 6, mX + 10); }
      if (mA === "middle" && mX - mw / 2 < 0) { mA = "start"; mX = 0; }
      if (pA !== "end" && pX + (pA === "middle" ? pw / 2 : pw) > nd.W) { pA = "end"; pX = nd.W; }
      attr(nd.medT, "x", mX); attr(nd.medT, "text-anchor", mA); attr(nd.p90T, "x", pX); attr(nd.p90T, "text-anchor", pA);
    }
    txt($("nd-today"), A.days && A.days.length ? `${A.days[A.days.length - 1].ask_waits || 0} today` : "");
    const la = lastAsk(s.claude.events || []);
    attr(nd.last, "opacity", la && la.after != null && !on ? 1 : 0);
    if (la && la.after != null) { attr(nd.last, "x1", lx(la.after)); attr(nd.last, "x2", lx(la.after)); }
    txt($("nd-strip-k"), on
      ? `Amber is this wait, against ${aw.count || 0} answers in 14 days`
      : `How long you take to answer, ${aw.count || 0} asks in 14 days; white tick is the last`);
    // the calm face
    if (la) {
      const what = askTool(la.ask.detail), nm = priv(la.ask.name || "a session", "a session");
      // the age ticks every second for the first hour, so it closes the sentence: nothing after
      // it can reflow when it gains a digit
      htm($("nd-last"), `Last ask: <b>${esc(nm)}</b>, ${esc(what)}` +
        (la.after != null ? `, answered in <b>${fmt.dur(la.after)}</b>` : "") +
        `. Asked at ${fmt.hm(la.ask.t)}, ${fmt.dur(t - la.ask.t)} ago.`);
    } else htm($("nd-last"), "No asks in the recent event log.");
    // the waiting face: the counter ticks from state.t
    if (on) {
      const w0 = waiting.reduce((a, b) => (a.since <= b.since ? a : b));
      const secs = Math.max(0, t - (w0.since || t));
      nd.n.set(waiting.length);
      txt($("nd-for"), fmt.dur(secs));
      // ask.text arrives for a subagent's dialog too (2026-11-05), with the agent that asked
      const ask = w0.ask || {}, nm = esc(nameOf(w0)) + (ask.agent_type ? ` <span style="color:var(--ink-3)">(${esc(ask.agent_type)})</span>` : "");
      const body = CFG.private ? "" : ask.text ? ": " + esc(ask.text) : "";
      const verb = ask.kind === "question" ? `asks${ask.n > 1 ? ` ${ask.n} questions` : ""}` : `wants to run <b>${esc(ask.tool || "a tool")}</b>`;
      const more = waiting.length > 1 ? ` <span style="color:var(--ink-3)">+${waiting.length - 1} more waiting</span>` : "";
      htm($("nd-ask"), `<b>${nm}</b> ${verb}${body}${more}`);
      const wx = lx(secs);
      tween("nd-wait", nd.wx == null ? wx : nd.wx, wx, (v) => { nd.wx = v; attr(nd.wait, "x2", v.toFixed(1)); attr(nd.waitHead, "cx", v.toFixed(1)); });
    }
    // the one attention moment: a 400 ms cross-fade to amber, and back (a CSS transition on .waiting)
    if (nd.mode !== on) { nd.mode = on; nd.box.classList.toggle("waiting", on); }
  }

  // =====================================================================================
  // C: weather (the scene lives in weather.js; the readings are here)
  // =====================================================================================
  const DIRS = "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split(" ");
  const wxN = { f: num($("wx-f")), w: undefined, sec: null };
  function weather(s) {
    const t = s.t, d = new Date(t * 1000), w = s.weather;
    // the scene runs every line (at fast periods each line is what moves the clouds); the
    // readings only when the weather block or the second changed (README 8a.6b). The scene is
    // the real sun and weather whatever the appearance (README, Preferences): never the theme.
    if (window.BentoWeather) BentoWeather.update(w, t, isDay(w, t));
    if (w === wxN.w && Math.floor(t) === wxN.sec) return;
    wxN.w = w; wxN.sec = Math.floor(t);
    const c = Kiln.fmt.clock(t);
    txt($("wx-clock"), c.split(" ")[0]);
    txt($("wx-ampm"), c.split(" ")[1]);
    txt($("wx-date"), DATE.long.format(d));
    if (!w) {
      wxN.f.set(null);
      txt($("wx-text"), "No weather reading");
      for (const id of ["wx-place", "wx-wind", "wx-hum", "wx-precip", "wx-set", "wx-rise"]) txt($(id), id === "wx-place" ? "" : "–");
      return;
    }
    // the feed is Celsius; the user's unit (the host's menu) comes from the runtime
    wxN.f.set(Kiln.fmt.tempValue(w.temp_c));
    txt($("wx-text"), cap(w.text || w.kind));
    // (the reading to a tenth in °C used to follow the place; in the user's own unit it only
    // repeated the figure above, so it went with the unit menu)
    txt($("wx-place"), w.place || "");
    // mph under °F, km/h under °C (Kiln.fmt.wind): it printed mph beside °C
    txt($("wx-wind"), w.wind_kmh == null ? "–" : `${Kiln.fmt.wind(w.wind_kmh)} ${DIRS[Math.round((w.wind_dir || 0) / 22.5) % 16]}`);
    txt($("wx-hum"), w.humidity == null ? "–" : w.humidity + "%");
    const snow = w.kind === "snow" && w.snow_cm > 0;
    const plab = $("wx-plab").firstChild, pl = snow ? "Snow" : "Precip.";
    if (plab.nodeValue !== pl) plab.nodeValue = pl;
    txt($("wx-precip"), snow ? `${w.snow_cm} cm` : w.precip_mm == null ? "–" : `${w.precip_mm} mm`);
    txt($("wx-set"), w.sunset ? fmt.hm(w.sunset) : "–");
    txt($("wx-rise"), w.sunrise ? fmt.hm(w.sunrise) : "–");
  }

  // =====================================================================================
  // D: sessions, keyed by sid
  // =====================================================================================
  const SS_COLS = "1fr 74px 118px 18px", SS_ROW = 49, SS_SLOTS = 4, SS_EV = 24;
  const SS_WORD = Object.assign({}, BG_WORD, { waiting: "waiting on you" });
  document.querySelector("#D .ss-cols").style.gridTemplateColumns = SS_COLS;
  const ss = { rows: new Map(), n: num($("ss-n")), max: 0 };
  const td = {
    out: unum($("td-out"), $("td-out-u"), (v) => fmt.parts(v, 2)),
    cache: unum($("td-cache"), $("td-cache-u"), (v) => fmt.parts(v, 2)),
    calls: num($("td-calls"), { fmt: fmt.int }),
  };
  function ssMake(sid) {
    const row = el("div", "li", $("ss-rows"));
    row.style.cssText = `grid-template-columns:${SS_COLS};padding:7px 0`;
    row.innerHTML = `<div style="min-width:0"><div class="nm" style="font-size:13.5px"><span class="dot st-dot" style="margin-right:7px"></span><span class="r-name"></span></div>
      <div class="k" style="margin:3px 0 0 15px;white-space:nowrap"><span class="bgk r-bg">bg</span><span class="r-model"></span><span class="st-ink r-state"></span> for <span class="r-for"></span></div></div>
      <div><div class="mn"><span class="r-ctx"></span><small class="uk r-ctxu"></small><small class="up r-ctxp"></small></div><div class="bar"><i class="fill-burn r-bar"></i></div></div>
      <div style="display:grid;grid-template-columns:46px 1fr;gap:8px;align-items:end"><div class="mn"><span class="r-out"></span><small class="uk r-outu"></small></div>
        <svg width="64" height="22" viewBox="0 0 64 22"><path class="r-area"/><path class="r-line" fill="none" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div class="mn r-ag"></div>`;
    const q = (c) => row.querySelector("." + c);
    const r = { row, sid, y: null, gone: false, goneAt: 0, sig: null,
      name: q("r-name"), bg: q("r-bg"), state: q("r-state"), for: q("r-for"), model: q("r-model"), bar: q("r-bar"), area: q("r-area"), line: q("r-line"),
      ctx: unum(q("r-ctx"), q("r-ctxu"), (v) => fmt.parts(v, 0)),
      ctxp: num(q("r-ctxp"), { fmt: (v) => Math.round(v) + "%" }),
      out: unum(q("r-out"), q("r-outu"), (v) => (v >= 1 ? fmt.parts(v) : ["0", ""])),
      ag: num(q("r-ag")), barV: 0 };
    r.bar.style.transform = "scaleX(0)";
    return r;
  }
  // A row whose key left the feed fades out by a CSS transition, and is removed on a later line
  // once the fade is over (timed by state.t, not a timer).
  function leave(rows, seen, t) {
    for (const [id, r] of rows) {
      if (seen.has(id)) continue;
      if (!r.gone) { r.gone = true; r.goneAt = t; r.row.style.opacity = 0; }
      else if (t - r.goneAt >= 0.35) { r.row.remove(); rows.delete(id); }
    }
  }
  // The slots no session fills show the newest session events from the log (turns finished,
  // asks, answers, failures), one line each, under the live rows: real history in place of a
  // blank. Keyed by event; the block follows the row count by one transform.
  const ssEv = { box: el("div", "ss-ev", $("ss-rows")), rows: new Map(), top: null };
  const EV_TEXT = {
    done: (e) => (e.n > 1 ? `finished ${e.n} turns` : "finished a turn"),
    fail: (e) => "failed" + (e.detail && !CFG.private ? ": " + e.detail : ""),
    ask: (e) => `asked for ${askTool(e.detail)}`,
    answered: (e) => { const m = String(e.detail || "").match(/([\d.]+)\s*s/); return m ? `answered in ${fmt.dur(+m[1])}` : "answered"; },
    remind: () => "reminded you",
  };
  const EV_ST = { done: "working", fail: "failed", ask: "waiting", answered: "idle", remind: "waiting" };
  function ssEvents(s, n) {
    const t = s.t, free = SS_SLOTS - n, cap = free > 0 ? Math.floor((free * SS_ROW - 6) / SS_EV) : 0;
    const ev = s.claude.events || [], list = [];
    for (let i = ev.length - 1; i >= 0 && list.length < cap; i--) if (EV_TEXT[ev[i].kind]) list.push(ev[i]);
    const top = n * SS_ROW;
    if (ssEv.top !== top) { ssEv.top = top; ssEv.box.style.transform = `translateY(${top}px)`; }
    css(ssEv.box, "opacity", list.length ? "1" : "0");
    const seen = new Set();
    list.forEach((e, slot) => {
      const id = e.t + e.kind + e.sid;
      seen.add(id);
      let r = ssEv.rows.get(id);
      if (!r || r.gone) {
        if (r) r.row.remove();
        const row = el("div", "ev st-" + EV_ST[e.kind], ssEv.box);
        row.innerHTML = `<i class="ring"></i><span class="ell"><b></b>, <span></span></span><span class="ago"></span>`;
        r = { row, y: null, gone: false, nm: row.querySelector("b"), what: row.querySelector(".ell > span"), ago: row.querySelector(".ago") };
        ssEv.rows.set(id, r);
      }
      const ty = 5 + slot * SS_EV;
      if (r.y !== ty) { r.y = ty; r.row.style.transform = `translateY(${ty}px)`; }
      txt(r.nm, nameOf({ sid: e.sid, name: e.name }));
      txt(r.what, EV_TEXT[e.kind](e));
      txt(r.ago, fmt.dur(t - e.t, false) + " ago");
    });
    leave(ssEv.rows, seen, t);
  }
  function sessions(s) {
    const t = s.t, list = (s.claude.sessions || []).map((x, i) => ({ x, i }));
    // interactive first, then background; within each, the ones that need you lead
    list.sort((a, b) => (isBg(a.x) - isBg(b.x)) || ((STATE[a.x.state] || STATE.idle).rank - (STATE[b.x.state] || STATE.idle).rank) || a.i - b.i);
    const shown = list.slice(0, SS_SLOTS).map((o) => o.x);
    const open = list.filter((o) => !isBg(o.x)).map((o) => o.x), bg = list.filter((o) => isBg(o.x)).map((o) => o.x);
    // The count is interactive sessions running: working, waiting on you, or waiting on their
    // agents. "0 sessions working" beside a session whose agents were busy read as a contradiction.
    const running = open.filter((x) => RUNNING[x.state]).length;
    ss.n.set(running);
    txt($("ss-lab"), running === 1 ? "session running" : "sessions running");
    txt($("ss-how"), open.length ? stateWords(open, SS_WORD).join(", ") + (list.length > SS_SLOTS ? `; ${SS_SLOTS} of ${list.length} shown` : "")
      : "none open in a terminal");
    // background sessions, counted apart: how many, then their states
    const bw = stateWords(bg);
    htm($("ss-bg"), bg.length ? `${bg.length} in the background<br><span style="color:var(--ink-2)">${esc(bw.length === 1 ? bw[0].replace(/^\d+ /, "") : bw.join(", "))}</span>` : "");
    // one sparkline scale for every row, printed in the column head
    const peak = Math.max(1, ...shown.flatMap((x) => x.out_per_min || [0]));
    txt($("ss-scale"), fmt.compact(peak));
    const seen = new Set();
    shown.forEach((x, slot) => {
      seen.add(x.sid);
      let r = ss.rows.get(x.sid);
      const ty = slot * SS_ROW;
      // a new row fades in by li-in; a reorder is a transform transition (index.html)
      if (!r || r.gone) {
        if (r) r.row.remove();
        r = ssMake(x.sid);
        ss.rows.set(x.sid, r);
      }
      if (r.y !== ty) { r.y = ty; r.row.style.transform = `translateY(${ty}px)`; }
      const st = STATE[x.state] ? x.state : "idle";
      cls(r.row, "li st-" + st);
      txt(r.name, nameOf(x));
      css(r.bg, "display", isBg(x) ? "" : "none");
      // "Opus, working for 9 m": the ticking age ends the line, so the model never shifts
      const mdl = MODEL(x.model);
      txt(r.model, mdl ? mdl + ", " : "");
      txt(r.state, mdl ? STATE[st].label.toLowerCase() : STATE[st].label);
      txt(r.for, fmt.dur(t - (x.since || t), false));
      r.ctx.set(x.ctx_tokens);
      r.ctxp.set(x.ctx_pct);
      const bv = Math.max(0, Math.min(100, x.ctx_pct || 0)) / 100;
      if (bv !== r.barV) { r.barV = bv; r.bar.style.transform = `scaleX(${bv.toFixed(4)})`; }
      r.out.set(x.out_15m || 0);
      r.ag.set(x.agents_running || 0);
      const ser = x.out_per_min || [], k = sig(ser) + ":" + peak;
      if (k !== r.sig && ser.length > 1) {
        r.sig = k;
        const pts = ser.map((v, i) => [(i / (ser.length - 1)) * 64, 21 - ((v || 0) / peak) * 20]);
        const d = smoothPath(pts);
        attr(r.line, "d", d);
        attr(r.area, "d", d + "L64,22L0,22Z");
        const live = (x.out_15m || 0) > 0;
        attr(r.line, "style", live ? "stroke:var(--cyan)" : "stroke:var(--spark-idle)");
        attr(r.area, "fill", live ? "url(#g-cyan-fill)" : "none");
      }
    });
    leave(ss.rows, seen, t);
    ssEvents(s, shown.length);
    // today, since midnight
    const tk = s.claude.tokens || {}, today = tk.today || {}, hit = (s.analytics || {}).cache_hit_pct || {};
    td.out.set(today.out); td.cache.set(today.cache_read); td.calls.set(today.calls);
    txt($("td-hit"), hit.today == null ? "–" : hit.today + "%");
    txt($("td-hit14"), hit.d14 == null ? "–" : hit.d14 + "%");
  }

  // =====================================================================================
  // E: output tokens per minute, on a time axis that ends at now
  // =====================================================================================
  const tk = (() => {
    const g = $("tk-svg"), W = 472, H = 140, PB = 22, SPAN = 3540;
    const gridL = [0, 1, 2].map(() => svg("line", { x1: 0, x2: W, class: "ln-grid" }, g));
    const area = svg("path", { fill: "url(#g-flow-fill)" }, g);
    const line = svg("path", { fill: "none", stroke: "url(#g-flow)", "stroke-width": 2.4, "stroke-linejoin": "round" }, g);
    // labels are drawn after the trace and carry a halo (index.html .halo): the trace runs under them
    const grid = gridL.map((l) => ({ l, t: svg("text", { x: W - 14, "text-anchor": "end", class: "axis halo" }, g) }));
    svg("line", { x1: 0, x2: W, y1: H - PB, y2: H - PB, class: "ln-grid0" }, g);
    const avg = svg("line", { x1: 0, x2: W, class: "ln-ref" }, g);
    // a plate in the tile's tone behind the average's label, shown only when no slot is clear
    const avgC = svg("rect", { width: 92, height: 15, rx: 4, opacity: 0, style: "fill:var(--tile)" }, g);
    const avgT = svg("text", { x: 18, class: "axis hi halo" }, g);
    const pk = svg("circle", { r: 3.5, style: "fill:var(--head)" }, g);
    const pkT = svg("text", { class: "axis hi halo" }, g);
    const fill = svg("path", { style: "stroke:var(--flow-1)", "stroke-dasharray": "2 3", "stroke-width": 1.4, fill: "none" }, g);
    const fillC = svg("circle", { r: 3, fill: "none", style: "stroke:var(--flow-1)", "stroke-width": 1.4 }, g);
    const head = svg("circle", { r: 4, style: "fill:var(--head)" }, g);
    const xl = [svg("text", { x: 18, y: H - 7, class: "axis" }, g), svg("text", { x: W / 2, y: H - 7, "text-anchor": "middle", class: "axis" }, g),
      svg("text", { x: W - 14, y: H - 7, "text-anchor": "end", class: "axis" }, g)];
    return { W, H, PB, SPAN, grid, area, line, avg, avgC, avgT, pk, pkT, fill, fillC, head, xl, key: null, drawnT: 0,
      // two figures ("6.4", "71") so the hero fills its slot and sits on the title's edge;
      // the peak label keeps the third figure
      last: unum($("tk-last"), $("tk-last-u"), (v) => (v < 50 ? ["0", ""] : v < 9950 ? [(v / 1000).toFixed(1), "k"]
        : v < 999500 ? [String(Math.round(v / 1000)), "k"] : fmt.parts(v))) };
  })();
  function tokens(s) {
    const ser = (s.claude.tokens || {}).out_per_min || [], t = s.t, n = ser.length;
    if (n < 3) return;
    const full = ser.slice(0, -1).map((v) => v || 0), filling = ser[n - 1] || 0;
    const mNow = Math.floor(t / 60) * 60;
    tk.last.set(full[full.length - 1]);
    txt($("tk-at"), fmt.hm(mNow - 60));
    // the filling minute's count ends a line of its own, so its width moves nothing
    txt($("tk-so"), fmt.compact(filling));
    txt(tk.xl[2], fmt.hm(t));
    // redraw when the data changed or the axis slid half a pixel; otherwise nothing paints
    const k = sig(ser);
    if (k === tk.key && Math.abs(t - tk.drawnT) * (tk.W / tk.SPAN) < 0.5) return;
    tk.key = k; tk.drawnT = t;
    const { W, H, PB, SPAN } = tk;
    let pi = 0;
    full.forEach((v, i) => { if (v > full[pi]) pi = i; });
    const peak = full[pi], mean = sum(full) / full.length;
    const step = niceStep(Math.max(peak, filling, 1) / 3), max = step * 3.5;
    const x = (time) => W * (1 - (t - time) / SPAN), y = (v) => H - PB - (Math.min(v, max) / max) * (H - PB - 6);
    // a full minute is plotted where it ended; the minute still filling sits at now
    const pts = full.map((v, i) => [x(mNow - (full.length - 1 - i) * 60), y(v)]);
    const d = smoothPath(pts), [lx, ly] = pts[pts.length - 1];
    attr(tk.line, "d", d);
    attr(tk.area, "d", `${d}L${lx.toFixed(1)},${H - PB}L${pts[0][0].toFixed(1)},${H - PB}Z`);
    tk.grid.forEach((gl, i) => {
      const v = step * (i + 1), gy = y(v);
      attr(gl.l, "y1", gy); attr(gl.l, "y2", gy); attr(gl.t, "y", gy - 5);
      txt(gl.t, fmt.compact(v));
    });
    const ay = y(mean);
    attr(tk.avg, "y1", ay); attr(tk.avg, "y2", ay);
    txt(tk.avgT, `average ${fmt.compact(mean)}`);
    const [px, py] = pts[pi], right = px < W * 0.62;
    attr(tk.pk, "cx", px); attr(tk.pk, "cy", py);
    const pl = `peak ${fmt.compact(peak)} at ${fmt.hm(mNow - (full.length - 1 - pi) * 60 - 60)}`;
    txt(tk.pkT, pl);
    // a peak at the chart's left edge keeps its label on the tile's text inset (18), not at the edge
    const pkX = right ? Math.max(px + 8, 18) : px - 8;
    attr(tk.pkT, "x", pkX); attr(tk.pkT, "y", py + 4); attr(tk.pkT, "text-anchor", right ? "start" : "end");
    // Keep labels off the data. The average's label (placeAvg) tries fixed slots from the
    // tile's text inset (18) rightwards in quarter-label steps, short of the grid labels' column,
    // above its line before below it: pinned at x 18 it sat on the trace (2026-11-05).
    // Start-anchored and sized for "average 88.8k" (AVW), so its digits never drag the word.
    const pw = pl.length * 6, pkL = right ? pkX : pkX - pw, pkR = pkL + pw;
    const AVW = 84, AVS = [];
    for (let ax = 18; ax + AVW < W - 50; ax += AVW / 4) AVS.push([ax, 0], [ax, 1]);
    // the collision box is this label's own width (5.8 px a character on the 11 px axis face)
    const avw = `average ${fmt.compact(mean)}`.length * 5.8;
    const cost = ([ax, below]) => {
      const y0 = below ? ay + 4 : ay - 15, y1 = y0 + 13;
      if (y0 < 0 || y1 > H - PB - 1) return Infinity;
      if (ax < pkR + 4 && ax + avw > pkL - 4 && y0 < py + 7 && y1 > py - 7) return Infinity;
      return traceNear(pts, ax - 3, ax + avw + 3, y0 - 2, y1 + 2);
    };
    const [ak, plate] = placeAvg(tk.avSlot || 0, AVS, cost), [avx, avb] = AVS[ak], avy = avb ? ay + 14 : ay - 5;
    tk.avSlot = ak;
    attr(tk.avgT, "x", avx); attr(tk.avgT, "y", avy);
    attr(tk.avgC, "x", avx - 4); attr(tk.avgC, "y", avy - 11); attr(tk.avgC, "width", Math.round(avw + 8));
    attr(tk.avgC, "opacity", plate ? 1 : 0);
    // a grid label yields to the peak's label and dot, and to the trace passing through it
    tk.grid.forEach((gl, i) => {
      const gy = y(step * (i + 1)) - 5;
      const hit = (Math.abs(gy - (py + 4)) < 12 && pkR > W - 44) || (px > W - 50 && Math.abs(gy - 4 - py) < 16)
        || traceNear(pts, W - 46, W - 12, gy - 11, gy + 3);
      css(gl.t, "opacity", hit ? "0" : "1");
    });
    const fx = x(t), fy = y(filling);
    attr(tk.fill, "d", `M${lx.toFixed(1)},${ly.toFixed(1)}L${fx.toFixed(1)},${fy.toFixed(1)}`);
    attr(tk.fillC, "cx", fx.toFixed(1)); attr(tk.fillC, "cy", fy.toFixed(1));
    attr(tk.head, "cx", lx.toFixed(1)); attr(tk.head, "cy", ly.toFixed(1));
    txt(tk.xl[0], fmt.hm(t - SPAN * (1 - 18 / W)));
    txt(tk.xl[1], fmt.hm(t - SPAN / 2));
  }

  // =====================================================================================
  // F: agents, keyed by id, with the general-purpose flag
  // =====================================================================================
  // three slots: with eight agents out, two showed a quarter of the work
  const AG_ROW = 47, AG_SLOTS = 3;
  const ag = { rows: new Map(), n: num($("ag-n")), gp: num($("gp-pct")), total: num($("sp-total"), { fmt: fmt.int }), bars: [], barKey: "" };
  const agEmpty = el("div", "empty k", $("ag-rows"), "None running right now.");
  function agMake(id) {
    const row = el("div", "li", $("ag-rows"));
    // two lines, each a name that takes the room left by one fixed right-hand slot: the stopwatch
    // (sized for 8:88:88) and the idle/done note. A shared column let "done 1 h ago" squeeze the
    // agent type to "general-purp…" and move it whenever the note changed width.
    row.style.cssText = "grid-template-columns:minmax(0,1fr) 50px;grid-template-rows:auto auto;gap:2px 8px;padding:6px 0";
    row.innerHTML = `<div class="nm" style="font-size:13.5px"><span class="dot r-dot" style="margin-right:7px"></span><span class="r-type"></span></div>
      <div class="mn r-age" style="font-size:17px"></div>
      <div style="grid-column:1/3;display:grid;grid-template-columns:minmax(0,1fr) 84px;gap:8px"><div class="k ell r-desc"></div><div class="k r-idle" style="text-align:right"></div></div>`;
    const q = (c) => row.querySelector("." + c);
    return { row, y: null, gone: false, dot: q("r-dot"), type: q("r-type"), age: q("r-age"), desc: q("r-desc"), idle: q("r-idle") };
  }
  function agents(s) {
    const t = s.t, A = s.analytics || {}, list = (s.claude.agents_running || []).map((a) => {
      const st = a.started || a.start;
      return Object.assign({}, a, { age: st ? t - st : a.age_s || 0, idleS: a.idle_s != null ? a.idle_s : a.last ? t - a.last : 0 });
    });
    list.sort((a, b) => b.age - a.age);
    ag.n.set(list.length);
    txt($("ag-lab"), list.length > AG_SLOTS ? `running, ${AG_SLOTS} longest shown` : "running");
    // free slots show the newest finished agents from the event log, dimmed, with how long each ran
    const ev = s.claude.events || [], done = [];
    for (let i = ev.length - 1; i >= 0 && done.length < AG_SLOTS - Math.min(AG_SLOTS, list.length); i--) {
      const e = ev[i];
      if (e.kind !== "agent_done") continue;
      const parts = String(e.detail || "").split(": "), st = ev.slice(0, i).reverse().find((x) => x.kind === "agent_start" && x.sid === e.sid && x.detail === e.detail);
      done.push({ id: "done:" + e.t + e.detail, type: parts[0], desc: parts.slice(1).join(": "), at: e.t, ran: st ? e.t - st.t : null, finished: true });
    }
    const rows = list.slice(0, AG_SLOTS).concat(done);
    css(agEmpty, "opacity", rows.length ? "0" : "1");
    const seen = new Set();
    rows.forEach((a, slot) => {
      const id = a.id || a.type + a.age;
      seen.add(id);
      let r = ag.rows.get(id);
      const ty = slot * AG_ROW, op = a.finished ? 0.62 : 1;
      if (!r || r.gone) {
        if (r) r.row.remove();
        r = agMake(id);
        ag.rows.set(id, r);
        r.row.style.opacity = op;
      }
      if (r.y !== ty) { r.y = ty; r.row.style.transform = `translateY(${ty}px)`; }
      const c = a.type === "general-purpose" ? "var(--amber)" : "var(--violet)";
      css(r.dot, "background", a.finished ? "transparent" : c);
      css(r.dot, "boxShadow", a.finished ? `inset 0 0 0 1.5px ${c}` : "");
      txt(r.type, a.type || "agent");
      txt(r.age, a.finished ? (a.ran != null ? fmt.stopwatch(a.ran) : "") : fmt.stopwatch(a.age));
      txt(r.desc, priv(a.desc || "", "Task hidden"));
      txt(r.idle, a.finished ? "done " + fmt.dur(t - a.at, false) + " ago" : a.idleS > 120 ? "idle " + fmt.dur(a.idleS, false) : "active");
    });
    leave(ag.rows, seen, t);
    // general-purpose share today against its usual share; amber only when it is well above usual
    const sp = A.spawns || {}, gp = A.general_purpose || {};
    const totalToday = sum(Object.values(sp.today || {})), gpToday = gp.today || 0;
    const pct = totalToday ? (gpToday / totalToday) * 100 : null;
    const hot = pct != null && gpToday >= 10 && gp.share_d14 != null && pct > gp.share_d14 * 1.5;
    ag.gp.set(pct);
    css($("gp-pct-box"), "color", hot ? "var(--amber)" : "var(--ink)");
    // short lines beside the figure, each sized for the narrow tile: what it is, the counts
    // against the usual share, and, only when it runs hot, the session most of them came from
    const by = gp.by_session_today || [];
    txt($("gp-line"), totalToday ? "general-purpose today" : "no agents spawned today");
    txt($("gp-from"), (totalToday ? `${gpToday} of ${totalToday}` : "") +
      (gp.share_d14 != null ? `${totalToday ? ", u" : "U"}sual ${Math.round(gp.share_d14)}%` : ""));
    txt($("gp-who"), hot && by.length && !CFG.private ? (by.length === 1 ? "all from " : "most from ") + by[0][0] : "");
    // spawns over 14 days: the top four
    const top = Object.entries(sp.d14 || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    ag.total.set(sum(Object.values(sp.d14 || {})));
    const names = top.map((e) => e[0]).join("|");
    if (names !== ag.barKey) {
      ag.barKey = names;
      $("sp-bars").innerHTML = "";
      ag.bars = top.map(([k]) => {
        const b = el("div", null, $("sp-bars"));
        b.style.cssText = "display:grid;grid-template-columns:98px 1fr 28px;gap:6px;align-items:center;margin-top:4px";
        b.innerHTML = `<span class="k ell"></span><span style="height:6px;border-radius:3px;background:var(--track);overflow:hidden"><i class="tw" style="display:block;height:100%;border-radius:3px;transform-origin:0 50%;transform:scaleX(0)"></i></span><span class="mn" style="font-size:14px"></span>`;
        return { name: b.children[0], bar: b.children[1].firstChild, n: num(b.children[2]), v: 0 };
      });
    }
    const mx = top.length ? top[0][1] : 1;
    top.forEach(([k, n], i) => {
      const b = ag.bars[i], isGp = k === "general-purpose";
      txt(b.name, k);
      css(b.name, "color", isGp && hot ? "var(--amber)" : "");
      css(b.bar, "background", isGp && hot ? "var(--amber)" : "var(--bar-dim)");
      b.n.set(n);
      const v = n / mx;
      if (v !== b.v) { b.v = v; b.bar.style.transform = `scaleX(${v.toFixed(4)})`; }
    });
  }

  // =====================================================================================
  // the machine: CPU, memory, network, disk, battery (and GPU + top processes in that preset)
  // =====================================================================================
  const mc = {
    // two figures, "8.8" or "17", to fill a two-figure slot (index.html .hx)
    cpu: num($("cpu-pct"), { fmt: (v) => (v < 9.95 ? v.toFixed(1) : String(Math.round(v))) }), cores: [],
    used: num($("mem-used"), { fmt: (v) => v.toFixed(1) }),
    rx: unum($("net-rx"), $("net-rx-u"), fmt.rate),
    free: num($("dk-free"), { fmt: (v) => String(Math.round(v)) }),
    batt: num($("bt-pct")), mem: [0, 0, 0],
    gpu: num($("gpu-pct")),
  };
  Kiln.track("rx", (s) => s.sys.net.rx_bps, 60);
  Kiln.track("gpu", (s) => s.sys.gpu, 60);
  const net = (() => {
    const g = $("net-svg"), grp = svg("g", {}, g);
    return { W: 84, H: 34, box: g, grp, area: svg("path", { fill: "url(#g-cyan-fill)" }, grp), line: svg("path", { fill: "none", style: "stroke:var(--cyan)", "stroke-width": 1.5, "stroke-linecap": "round" }, grp), T0: null };
  })();
  function scrollSpark(o, data, t, span, max) {
    // The path lives in time coordinates (x = (time - T0) * k) and the SVG's viewBox shows its
    // last `span`, so the trace scrolls by moving the viewBox, in whole device pixels (0.5 px):
    // at 1.4 px a second that is a repaint of this small box about three times a second. Pass 2
    // slid a wide SVG by a transform on every line, and in WebKit each transform written re-runs
    // the compositing pass over every layer of the page: a quarter of its main-thread time at
    // 100 ms (pass 3, sampled in the host). Every 2 min the path is re-based near 0; path and
    // viewBox move together on that line.
    const k = o.W / span, rebase = o.T0 == null || t - o.T0 > span * 3;
    if (rebase) o.T0 = t - span;
    // Kiln.track keeps every line: 600 points a minute at 100 ms, for a trace 84 px wide. Each
    // half second (buckets anchored to T0, so they hold still between lines) keeps its peak.
    const B = span / 120, pts = [];
    let bi = null;
    for (const p of data) {
      if (p.t < t - span - 4) continue;
      const b = Math.floor((p.t - o.T0) / B), yv = o.H - 1 - (Math.min(p.v, max) / max) * (o.H - 2);
      if (b !== bi) { bi = b; pts.push([(p.t - o.T0) * k, yv]); }
      else if (yv < pts[pts.length - 1][1]) pts[pts.length - 1][1] = yv;
    }
    if (pts.length < 2) return;
    const d = smoothPath(pts);
    attr(o.line, "d", d);
    attr(o.area, "d", `${d}L${pts[pts.length - 1][0].toFixed(1)},${o.H}L${pts[0][0].toFixed(1)},${o.H}Z`);
    attr(o.box, "viewBox", `${(Math.round(((t - o.T0) * k - o.W) * 2) / 2).toFixed(1)} 0 ${o.W} ${o.H}`);
  }
  function machine(s) {
    const S = s.sys || {}, t = s.t;
    if (!S.mem) return;
    // CPU
    mc.cpu.set(S.cpu);
    txt($("cpu-load"), S.load && S.load[0] != null ? S.load[0].toFixed(2) : "–");
    txt($("cpu-gpu"), S.gpu == null ? "–" : Math.round(S.gpu) + "%");
    const cores = S.cores || [];
    if (mc.cores.length !== cores.length) {
      $("cpu-cores").innerHTML = "";
      mc.cores = cores.map(() => {
        const b = el("div", null, $("cpu-cores"));
        b.style.cssText = "width:7px;height:46px;border-radius:3px;background:var(--track);position:relative;overflow:hidden";
        const i = el("i", "tw", b);
        i.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:100%;border-radius:3px;background:var(--cyan);transform-origin:50% 100%;transform:scaleY(0)";
        return { i, lv: null };
      });
    }
    // height is load^0.7 of the 46 px bar, from 0: 5% fills 6 px, 15% 12, 30% 20, 60% 32.
    // Monotonic; "busiest" below gives the true figure. A 6% floor made every core under 6%
    // the same rounded stub, and linear left 5% a 2 px sliver (2026-11-05).
    cores.forEach((v, i) => {
      const c = mc.cores[i], lv = Math.max(0, Math.min(100, v));
      // a bar is 46 px: a move under 2.2% of a core (1 px on a linear bar) is not worth a
      // composited move per line. On load, not height: near 0 the lifted scale is steep.
      if (c.lv != null && Math.abs(lv - c.lv) < 2.2) return;
      c.lv = lv;
      c.i.style.transform = `scaleY(${Math.pow(lv / 100, 0.7).toFixed(3)})`;
    });
    txt($("cpu-ncores"), String(cores.length));
    txt($("cpu-busy"), cores.length ? Math.round(Math.max(...cores)) + "%" : "–");
    // memory, in GiB as macOS reports it; the pill is the kernel's pressure level
    const m = S.mem;
    mc.used.set(fmt.gib(m.used));
    txt($("mem-total"), String(Math.round(fmt.gib(m.total))));
    txt($("mem-swap"), fmt.gib(S.swap || 0).toFixed(1));
    const pill = $("mem-pill");
    txt(pill, "Pressure " + (m.pressure || "–"));
    cls(pill, "pill " + (m.pressure || ""));
    // segments end to end, each placed by one transform (a CSS transition carries it), with a
    // 1.5 px seam between them; no width changes, so nothing in the bar lays out. The bar is
    // 194 px: a move under 0.25% is under a device pixel and not worth a compositing pass.
    const seg = [m.wired, m.active, m.compressed].map((v) => (v / m.total) * 100);
    const segEls = $("mem-bar").children;
    if (seg.some((v, i) => Math.abs(v - mc.mem[i]) > 0.25)) {
      let at = 0;
      seg.forEach((v, i) => {
        mc.mem[i] = v;
        segEls[i].style.transform = `translateX(calc(${at.toFixed(2)}% + ${i * 1.5}px)) scaleX(${(v / 100).toFixed(4)})`;
        at += v;
      });
    }
    txt($("mem-w"), fmt.gib(m.wired).toFixed(1)); txt($("mem-a"), fmt.gib(m.active).toFixed(1)); txt($("mem-c"), fmt.gib(m.compressed).toFixed(1));
    // network: the down rate, and its last 60 s scrolling in from the right
    const nt = S.net || {};
    mc.rx.set(nt.rx_bps);
    txt($("net-up"), fmt.rateStr(nt.tx_bps));
    const rx = Kiln.series("rx"), win = rx.filter((p) => p.t >= t - 60);
    const peak = win.length ? Math.max(...win.map((p) => p.v)) : 0;
    txt($("net-secs"), String(win.length ? Math.round(t - win[0].t) : 0));
    txt($("net-peak"), fmt.rateStr(peak));
    scrollSpark(net, rx, t, 60, Math.max(peak, 2048) * 1.1);
    // disk, in decimal GB as Finder reports it
    const dk = S.disk || {};
    if (dk.total) {
      mc.free.set(dk.free / 1e9);
      txt($("dk-total"), String(Math.round(dk.total / 1e9)));
      const u = 1 - dk.free / dk.total;
      css($("dk-bar"), "transform", `scaleX(${u.toFixed(4)})`);
      txt($("dk-rd"), fmt.rateStr(dk.read_bps)); txt($("dk-wr"), fmt.rateStr(dk.write_bps));
    }
    // battery
    const b = S.batt || {};
    mc.batt.set(b.pct);
    const tone = b.pct == null ? "var(--ink)" : b.pct <= 10 ? "var(--red)" : b.pct <= 20 ? "var(--amber)" : "var(--calm)";
    css($("bt-pct-box"), "color", tone);
    css($("bt-fill"), "fill", tone);
    // the source in the corner, the ticking estimate on a line of its own (as Disk's rates sit)
    txt($("bt-state"), b.ac ? "on power" : "on battery");
    txt($("bt-left"), b.ac ? (b.charging ? "charging" : "not charging") : b.mins_left ? `time left ${fmt.dur(b.mins_left * 60)}` : "estimating time left");
    const bv = Math.max(0, Math.min(100, b.pct || 0)) / 100;
    css($("bt-fill"), "transform", `scaleX(${bv.toFixed(4)})`);
    if (CFG.layout === "machine") machineExtra(s);
  }
  const gpuSpark = (() => {
    const g = $("gpu-svg"), grp = svg("g", {}, g);
    return { W: 194, H: 52, box: g, grp, area: svg("path", { fill: "url(#g-cyan-fill)" }, grp), line: svg("path", { fill: "none", style: "stroke:var(--cyan)", "stroke-width": 1.5 }, grp), T0: null };
  })();
  function machineExtra(s) {
    const S = s.sys, t = s.t, gd = S.gpu_detail || {};
    mc.gpu.set(S.gpu);
    txt($("gpu-ren"), gd.renderer == null ? "–" : gd.renderer + "%");
    txt($("gpu-til"), gd.tiler == null ? "–" : gd.tiler + "%");
    const gs = Kiln.series("gpu"), win = gs.filter((p) => p.t >= t - 60);
    txt($("gpu-peak"), win.length ? Math.round(Math.max(...win.map((p) => p.v))) + "%" : "–");
    scrollSpark(gpuSpark, gs, t, 60, 100);
    txt($("gpu-vram"), Kiln.fmt.bytes(gd.vram_used));
    txt($("gpu-valloc"), Kiln.fmt.bytes(gd.vram_alloc));
    const vv = gd.vram_alloc ? gd.vram_used / gd.vram_alloc : 0;
    css($("gpu-vbar"), "transform", `scaleX(${vv.toFixed(4)})`);
    const list = (id, rows, val, max) => {
      const box = $(id);
      while (box.children.length < rows.length) {
        const r = el("div", null, box);
        r.style.cssText = "display:grid;grid-template-columns:1fr 50px;gap:2px 8px;align-items:baseline;margin-top:6px";
        r.innerHTML = `<span class="k ell" style="color:var(--ink)"></span><span class="mn" style="font-size:15px"></span><span class="bar" style="grid-column:1/3;margin-top:0;height:4px"><i class="fill-cyan" style="transform:scaleX(0)"></i></span>`;
      }
      while (box.children.length > rows.length) box.lastChild.remove();
      rows.forEach((p, i) => {
        const r = box.children[i];
        txt(r.children[0], p[0]);
        txt(r.children[1], val(p[1]));
        css(r.children[2].firstChild, "transform", `scaleX(${Math.min(1, p[1] / max).toFixed(3)})`);
      });
    };
    const tc = (S.top_cpu || []).slice(0, 5), tm = (S.top_mem || []).slice(0, 5);
    list("top-cpu", tc, (v) => Math.round(v) + "%", Math.max(100, ...tc.map((p) => p[1])));
    list("top-mem", tm, (v) => fmt.gib(v).toFixed(1) + " GB", m0(tm));
  }
  const m0 = (tm) => Math.max(1, ...tm.map((p) => p[1]));

  // =====================================================================================
  // H + I: GitHub, the real contribution calendar
  // =====================================================================================
  const GH_MIN = [0, 1, 10, 20, 50];
  const ghLevel = (n) => GH_MIN.reduce((acc, min, i) => (n >= min ? i : acc), 0);
  $("gh-legend").innerHTML = [["0", 0], ["1–9", 1], ["10–19", 2], ["20–49", 3], ["50+", 4]]
    .map(([l, i]) => `<span style="display:inline-flex;align-items:center;gap:5px"><i class="swatch" style="background:var(--gh${i})"></i>${l}</span>`).join("");
  const gh = { key: null, total: num($("gh-total"), { fmt: fmt.int }), active: num($("gh-active"), { fmt: fmt.int }),
    today: num($("gt-today")), week: num($("gt-week")), streak: num($("gt-streak")), rows: new Map() };
  const dOf = (ds) => new Date(ds + "T12:00:00");
  function github(s) {
    const G = s.github, t = s.t;
    if (!G || !G.days || !G.days.length) return;
    // the runtime keeps one github object until a line carries a new one: the calendar side is
    // rebuilt only then, while the newest event's age below ticks on every line
    if (G !== gh.G) { gh.G = G; calendar(G); }
    // I: today, the week, the streak, and the newest event with a live age
    gh.today.set(G.today); gh.week.set(G.week); gh.streak.set(G.streak);
    txt($("gt-streak-u"), G.streak === 1 ? "day" : "days");
    // the newest events, newest first, keyed by time: a new push slides the others down
    const ev = (G.recent && G.recent.length ? G.recent : G.latest ? [G.latest] : []).filter((e) => e && e.at).slice(0, GT_SLOTS);
    const seen = new Set();
    ev.forEach((e, slot) => {
      const id = e.at + (e.type || "");
      seen.add(id);
      let r = gh.rows.get(id);
      if (!r || r.gone) {
        if (r) r.row.remove();
        const row = el("div", "ge", $("gt-list"));
        row.innerHTML = `<div class="sub ell" style="color:var(--ink)"></div><div class="k" style="margin-top:1px"></div>`;
        r = { row, y: null, gone: false, text: row.firstChild, when: row.lastChild };
        gh.rows.set(id, r);
      }
      const ty = 7 + slot * GT_ROW;
      if (r.y !== ty) { r.y = ty; r.row.style.transform = `translateY(${ty}px)`; }
      let text = e.text || "";
      if (CFG.private) text = text.split(/ (?:to|in|on) /)[0].split(" ").filter((w) => !w.includes("/")).join(" ");
      txt(r.text, text);
      // the age closes the line, so its ticking moves nothing after it
      txt(r.when, `${fmt.hm(e.at)}, ${fmt.dur(t - e.at)} ago`);
    });
    leave(gh.rows, seen, t);
  }
  const GT_ROW = 38, GT_SLOTS = 2;
  function calendar(G) {
    const days = G.days, best = G.best || [];
    gh.total.set(G.total_year);
    gh.active.set(days.filter((d) => d[1] > 0).length);
    txt($("gh-ndays"), String(days.length));
    txt($("gh-login"), G.login || "");
    const d0 = dOf(days[0][0]), d1 = dOf(days[days.length - 1][0]);
    txt($("gh-range"), `${DATE.md.format(d0)}, ${d0.getFullYear()} to ${DATE.md.format(d1)}`);
    txt($("gh-best"), best[1] != null ? fmt.int(best[1]) : "–");
    txt($("gh-best-d"), best[0] ? fmt.day(dOf(best[0]).getTime() / 1000) : "–");
    // the calendar redraws only when GitHub's numbers do
    const key = days.length + "|" + days[0][0] + "|" + sig(days.map((d) => d[1])) + "|" + best[0];
    if (key !== gh.key) {
      gh.key = key;
      const pl = 30, pitch = 12.15, cell = 10, top = 15, off = d0.getDay(), gw = 674;
      const cols = Math.ceil((days.length + off) / 7);
      const months = [], seen = {};
      let s2 = "";
      ["Mon", "Wed", "Fri"].forEach((d, j) => (s2 += `<text x="${pl - 6}" y="${top + (1 + j * 2) * pitch + 8.5}" text-anchor="end" class="axis">${d}</text>`));
      days.forEach(([ds, n], i) => {
        const c = i + off, col = Math.floor(c / 7), row = c % 7, x = pl + col * pitch, y = top + row * pitch;
        const isToday = i === days.length - 1, isBest = ds === best[0];
        s2 += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cell}" height="${cell}" rx="2.4" style="fill:var(--gh${ghLevel(n)})${isToday ? ";stroke:var(--head);stroke-width:1.4" : ""}"/>`;
        if (isBest) s2 += `<circle cx="${(x + cell / 2).toFixed(2)}" cy="${(y + cell / 2).toFixed(2)}" r="7.6" fill="none" style="stroke:var(--head)" stroke-width="1.5"/>`;
        const mk = ds.slice(0, 7);
        if (!(mk in seen)) { seen[mk] = months.length; months.push({ label: DATE.mo.format(dOf(ds)), col, total: 0 }); }
        months[seen[mk]].total += n;
      });
      const totals = months.map((m) => m.total).sort((a, b) => a - b), medT = totals[Math.floor(totals.length / 2)] || 0;
      months.forEach((m, i) => {
        const last = i === months.length - 1, next = months[i + 1];
        // a month that starts within three columns of the next has no room for its label
        if (!last && next && (i === months.length - 2 ? (gw - 24) - (pl + m.col * pitch) < 30 : next.col - m.col < 3)) return;
        const x = last ? gw : pl + m.col * pitch, a = last ? "end" : "start";
        s2 += `<text x="${x.toFixed(1)}" y="10" text-anchor="${a}" class="axis">${m.label}</text>`;
        s2 += `<text x="${x.toFixed(1)}" y="${(top + 7 * pitch + 13).toFixed(1)}" text-anchor="${a}" class="axis${m.total >= medT * 2 && m.total > 0 ? " hi" : ""}">${fmt.int(m.total)}</text>`;
      });
      $("gh-svg").setAttribute("viewBox", `0 0 674 117`);
      $("gh-svg").innerHTML = s2;
      void cols;
    }
  }

  // =====================================================================================
  // P: 14 days of output; today's bar grows live from the token counter
  // =====================================================================================
  const fn = (() => {
    const g = $("fn-svg"), W = 194, H = 118, pl = 26;
    const grid = [0, 1, 2].map((i) => ({ l: svg("line", { x1: pl, x2: W, class: i ? "ln-grid" : "ln-grid0" }, g), t: svg("text", { x: pl - 5, "text-anchor": "end", class: "axis" }, g) }));
    // value labels carry a halo: today's often sits over yesterday's taller bar
    return { g, W, H, pl, grid, bars: [], labels: [], max: null, peakT: svg("text", { "text-anchor": "middle", class: "axis halo" }, g),
      todayT: svg("text", { x: W, "text-anchor": "end", class: "axis hi halo" }, g), todayL: svg("text", { x: W, y: H + 14, "text-anchor": "end", class: "axis hi" }, g),
      total: unum($("fn-total"), $("fn-total-u"), (v) => fmt.parts(v)) };
  })();
  function fortnight(s) {
    const A = s.analytics;
    if (!A || !A.days || !A.days.length) return;
    const today = (s.claude.tokens || {}).today || {};
    const days = A.days.map((d, i, a) => ({ date: d.date, out: i === a.length - 1 && today.out != null ? Math.max(d.out, today.out) : d.out }));
    const n = days.length, prev = days.slice(0, -1), last = days[n - 1];
    fn.total.set(sum(days.map((d) => d.out)));
    const md = (ds) => DATE.md.format(dOf(ds));
    txt($("fn-range"), `${md(days[0].date)} to ${md(last.date)}`);
    txt($("fn-avg"), prev.length ? `${prev.length}-day avg ${fmt.compact(sum(prev.map((d) => d.out)) / prev.length)}` : "");
    const { W, H, pl } = fn, bw = (W - pl) / n;
    // finer steps than niceStep: a 21M peak gets a 30M axis (70% of the height), not 40M
    const half = Math.max(1, ...days.map((d) => d.out)) / 2, p10 = Math.pow(10, Math.floor(Math.log10(half)));
    const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((k) => k * p10).find((v) => v >= half), max = step * 2;
    const y = (v) => 10 + (1 - v / max) * (H - 10);
    if (fn.max !== max) {
      fn.grid.forEach((gl, i) => { const v = step * i, gy = y(v); attr(gl.l, "y1", gy); attr(gl.l, "y2", gy); attr(gl.t, "y", gy + 4); txt(gl.t, v ? fmt.compact(v) : "0"); });
    }
    if (fn.bars.length !== n) {
      for (const b of fn.bars) b.r.remove();
      for (const l of fn.labels) l.remove();
      fn.labels = [];
      fn.bars = days.map((d, i) => {
        const x = pl + i * bw + 1.5;
        const r = svg("rect", { x: x.toFixed(2), width: (bw - 3).toFixed(2), rx: 2.5, style: i === n - 1 ? "fill:url(#g-flow-v)" : "fill:var(--bar-today)" }, fn.g);
        if (i % 4 === 1 && i < n - 2) fn.labels.push(svg("text", { x: (x + (bw - 3) / 2).toFixed(2), y: H + 14, "text-anchor": "middle", class: "axis" }, fn.g));
        return { r, v: null, x };
      });
      fn.g.appendChild(fn.peakT); fn.g.appendChild(fn.todayT);
    }
    let li = 0;
    days.forEach((d, i) => { if (i % 4 === 1 && i < n - 2) txt(fn.labels[li++], String(dOf(d.date).getDate())); });
    const rescale = fn.max !== max;
    fn.max = max;
    days.forEach((d, i) => {
      const b = fn.bars[i];
      if (b.v === d.out && !rescale) return;
      const from = b.v == null ? d.out : b.v;
      b.v = d.out;
      tween("fn" + i, from, d.out, (v) => {
        const top = y(v);
        attr(b.r, "y", top.toFixed(2)); attr(b.r, "height", Math.max(2, y(0) - top).toFixed(2));
        if (i === n - 1) attr(fn.todayT, "y", (top - 5).toFixed(1));
      });
    });
    txt(fn.todayT, fmt.compact(last.out));
    txt(fn.todayL, "today");
    if (prev.length) {
      let pi = 0;
      prev.forEach((d, i) => { if (d.out > prev[pi].out) pi = i; });
      attr(fn.peakT, "x", (pl + pi * bw + bw / 2).toFixed(1));
      attr(fn.peakT, "y", (y(prev[pi].out) - 5).toFixed(1));
      txt(fn.peakT, fmt.compact(prev[pi].out));
      // the previous peak's label yields when it would sit on today's
      css(fn.peakT, "opacity", pi >= n - 3 && Math.abs(y(prev[pi].out) - y(last.out)) < 14 ? "0" : "1");
    }
  }

  // =====================================================================================
  // README 8a.6b: a tile runs only when its inputs changed. Sticky blocks (limits, tokens,
  // github, analytics, events, weather) keep their identity between lines, so comparing them
  // is free; ages and stopwatches on those tiles tick by the second, so the second is part of
  // the key. Sessions, needs-you and the machine read blocks that are new on every line.
  const sec = (s) => Math.floor(s.t);
  const tiles = [
    [weekly, (s) => [s.claude.limits, sec(s)]],
    // needs-you reads only who is waiting (and on what), the log and the second
    [needs, (s) => [s.claude.events, s.analytics, sec(s),
      (s.claude.sessions || []).map((x) => x.sid + x.kind + x.state + (x.since || 0) + (x.ask ? x.ask.text || x.ask.tool : "")).join("|")]],
    [weather, (s) => [s.weather, sec(s)]],
    [sessions, null],
    [tokens, (s) => [s.claude.tokens, sec(s)]],
    // agents_running is a new array on every line, so it keys by what the rows print
    [agents, (s) => [(s.claude.agents_running || []).map((a) => a.id + ":" + (a.started || a.start || a.age_s)).join("|"),
      s.claude.events, s.analytics, sec(s)]],
    [machine, null],
    [github, (s) => [s.github, sec(s)]],
    [fortnight, (s) => [s.analytics, s.claude.tokens]],
  ];
  const ran = new Map();
  let first = true;
  Kiln.on((raw) => {
    const s = view(raw);
    period(s, first);
    first = false;
    theme(s);
    for (const [f, key] of tiles) {
      if (key) {
        const k = key(s), p = ran.get(f);
        if (p && k.every((v, i) => v === p[i])) continue;
        ran.set(f, k);
      }
      try { f(s); } catch (e) { console.error(f.name, e); }
    }
  });
  // The host's menu, live: the theme follows a new appearance now (the window's scene does not:
  // it is the real sky), and a new unit re-prints the temperature at once (a null first cancels
  // any glide from 53 to 12).
  // Nothing else on the page prints a temperature or paints a theme colour into a bitmap.
  Kiln.onPrefs(() => {
    const s = Kiln.state ? view(Kiln.state) : null;
    theme(s);
    if (!s) return;
    wxN.w = undefined;
    wxN.f.set(null);
    ran.delete(weather);
    try { weather(s); } catch (e) { console.error("weather", e); }
  });
})();
