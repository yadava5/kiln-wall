// Mission Map, "Perimeter tree", v4. The Mac is the hub under the notch; every reading is a
// leaf on one of the screen's edges, on one six-column grid. The hub is a live junction:
// each open session pours a ribbon (width = its tokens a minute over the hour, ink = its
// slot) to a fixed leaf; each running subagent is a strand from its session's root up to
// the crown; the Today spoke carries every session's tokens a minute over the hour, and the
// machine's spoke its CPU over two minutes. Every thread's width is its flow, with now at its
// source end and the past carried downstream; tokens landing run a bead into the hub and out
// to Today. Tiles never move or resize with the data: only threads, strands and beads come
// and go. Every figure comes from Kiln.state.
(function () {
  "use strict";
  const F = Kiln.fmt, q = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const MODEL = { "claude-opus-5-5": "Opus 5.5", "claude-fable-5-1": "Fable 5.1", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5" };
  const model = (id) => MODEL[id] || (id || "").replace(/^claude-/, "");
  const MODEL_ORDER = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"];
  const GB = (b) => (b / 1073741824).toFixed(1);
  // per-line arrays (sessions[].out_per_min, ...) are new objects on every line: compare them
  // by content. Only the sticky blocks keep their identity (README 6b).
  const sameNums = (a, b) => { if (a === b) return true; if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  // "3 h 11 m 5 s" -> "3 h 11 m"; seconds only matter under a minute.
  const age = (sec) => sec >= 60 ? F.span(sec).replace(/ \d+ s$/, "") : F.span(sec);
  const ago = (t, now) => age(now - t) + " ago";
  // "1 d", "3 h", "12 m": the largest unit only, for ages that only need a size
  const coarse = (sec) => sec >= 86400 ? Math.floor(sec / 86400) + " d" : sec >= 3600 ? Math.floor(sec / 3600) + " h" : sec >= 60 ? Math.floor(sec / 60) + " m" : Math.max(0, Math.round(sec)) + " s";
  const FMT = {
    wd: new Intl.DateTimeFormat("en-US", { weekday: "short" }),
    long: new Intl.DateTimeFormat("en-US", { weekday: "long", day: "numeric", month: "long" }),
    short: new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", month: "short" }),
  };
  const dayName = (t) => FMT.wd.format(new Date(t * 1000));
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  // reduced motion: no fades, beads, flow or drift. dev: ?nofx does the same (the A/B that
  // prices the motion on its own)
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches || q.has("nofx");
  const paused = () => document.documentElement.classList.contains("kiln-paused");

  // ---------- palette: the CSS custom properties, read once for SVG and canvas ----------
  const css = getComputedStyle(document.documentElement);
  const C = {};
  for (const k of ["bg", "tr", "ink", "sec", "idle", "now", "al", "k0", "k1", "k2", "k3", "m1", "m2", "m3", "m4", "t0", "t1", "t2", "t3", "t4", "g0", "g1", "g2", "g3", "g4", "z1", "z2", "z3", "z4"]) C[k] = css.getPropertyValue("--" + k).trim();
  const KINK = [C.k1, C.k2, C.k3];

  // ---------- the grid (pt). Columns R 12-66 | C1 78-342 | C2 354-618 | M 630-882 |
  // C4 894-1224 | C5 1236-1500; bands 12-168 | 180-768 | 780-970; one 12-pt gutter. ----------
  const HUB = { x: 756, y: 468, r: 96 };
  // the dial's ring: ten core arcs of radius 89, 4 wide, centred on the hub. Every connection
  // that meets the dial ends on the ring's outer edge (RIM_OUT), not on the card's edge (96)
  const RIM = { r: 89, w: 4 }, RIM_OUT = RIM.r + RIM.w / 2;
  const CROWN_Y = 168;                       // the crown's bottom edge, where strands land
  const SLOT = { x: 1236, w: 264, h: 188, y: [180, 380, 580] };
  const CARDS = [
    ["CK", 12, 12, 330, 156], ["GH", 354, 12, 264, 156], ["CR", 630, 44, 252, 124], ["WK", 894, 12, 330, 156], ["NY", 1236, 12, 264, 156],
    ["AU", 78, 180, 264, 192], ["TD", 354, 180, 264, 192],
    ["D14", 78, 384, 264, 192], ["BH", 354, 384, 264, 192],
    ["HM", 78, 588, 264, 180], ["LG", 354, 588, 264, 180],
    ["NT", 78, 780, 264, 190], ["ME", 354, 780, 264, 190], ["CP", 630, 780, 252, 190], ["BZ", 894, 780, 330, 190], ["WX", 1236, 780, 264, 190],
    ["hub", HUB.x - HUB.r, HUB.y - HUB.r, 192, 192],
    // the rail (x 12-66): battery and disk, aligned to the bottom band; placed by onDock
    ["BT", 12, 780, 54, 89], ["DK", 12, 881, 54, 89],
  ];

  // ---------- DOM ----------
  const cards = $("cards");
  const row = (cls, k, v, vw, ids) => `<div class="r ${cls}"><span class="k${ids && ids[0] ? '" id="' + ids[0] : ""}">${k}</span>` +
    (v != null ? `<span class="v${ids && ids[1] ? '" id="' + ids[1] : ""}"${vw ? ` style="width:${vw}"` : ""}>${v}</span>` : "") + `</div>`;
  const T = {};
  T.CK = `<div class="time disp f72" id="CKt"></div><div class="r h20 date"><span class="k" id="CKd"></span></div>
    <div class="r h20"><span class="k sec" id="CKp" style="width:180px"></span><i id="LDd"></i><span class="v" style="width:48px"><b id="LDn" style="font-weight:600"></b> <span class="sec">ms</span></span></div>`;
  T.WK = `<div class="t"><span>The week</span><span class="v" id="WKr" style="width:9em"></span></div>
    <div style="position:absolute;left:11px;top:31px;width:152px">
      ${row("h36", '<span class="sec">used</span>', "", "3.4em", [null, "WKp"]).replace('class="v"', 'class="v disp f28"')}
      ${row("", '<span class="sec">resets in</span>', "", "7.4em", [null, "WKi"])}
      ${row("", '<span class="sec">burn, 6 h</span>', "", "5em", [null, "WKb"])}
      ${row("", '<span class="sec">forecast</span>', "", "7.6em", [null, "WKf"])}
      ${row("", '<span class="sec">5-hour</span>', "", "6em", [null, "WK5"]).replace('class="r "', 'class="r" id="WK5r" style="display:none"')}
    </div>
    <svg id="WKc" width="146" height="116" viewBox="0 0 146 116" style="position:absolute;left:173px;top:31px"></svg>`;
  T.CR = `<div class="t"><span>Agents out</span><span class="v" id="CRd" style="width:9em"></span></div>
    ${[0, 1, 2, 3].map((i) => `<div class="r h20 ag" id="CRr${i}"><i class="dot"></i><span class="k" id="CRk${i}" style="width:180px"></span><span class="v sec" id="CRv${i}" style="width:3em"></span></div>`).join("")}`;
  T.GH = `<div class="t"><span id="GHt">GitHub</span><span class="v" id="GHn" style="width:10em"></span></div>
    <canvas id="GHg" width="468" height="63" style="width:234px;height:31.5px;margin-top:4px"></canvas>
    <div style="position:absolute;left:11px;top:72px;width:112px">${row("", "today", "", "3em", [null, "GH1"])}${row("", "this week", "", "3em", [null, "GH2"])}${row("", "streak", "", "4em", [null, "GH3"])}</div>
    <div style="position:absolute;left:141px;top:72px;width:100px">${row("", "commits", "", "3.6em", [null, "GH4"])}${row("", "PRs", "", "3.6em", [null, "GH5"])}${row("", "issues", "", "3.6em", [null, "GH6"])}</div>
    <div style="position:absolute;left:11px;top:124px;width:242px">${row("sec", "", null, null, ["GHk"]).replace('class="k"', 'class="k" style="width:242px"')}</div>`;
  T.NY = `<div class="t"><span>Needs you</span><span class="v" id="NYr" style="width:11em"></span></div>
    <div class="r h24 head"><i class="dot" id="NYd" style="top:8px"></i><span class="k" id="NYh"></span></div>
    ${row("h20", "", "", "8em", ["NYk1", "NYv1"])}
    ${row("h20", "", "", "8em", ["NYk2", "NYv2"])}
    ${row("h20", "", "", "8em", ["NYk3", "NYv3"])}
    ${row("", "", null, null, ["NYs"]).replace('class="r "', 'class="r sec"')}`;
  T.AU = `<div class="t"><span>By author today</span><span class="v" id="AUn" style="width:11.5em"></span></div>
    ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<div class="r h20"><span class="k" id="AUk${i}" style="width:110px"></span><i class="hbar" id="AUb${i}"><b></b></i><span class="v" id="AUv${i}" style="width:3.6em"></span></div>`).join("")}`;
  T.D14 = `<div class="t"><span>14 days</span><span class="v" id="D14n" style="width:9em"></span></div>
    <div class="stack" id="D14s">${Array.from({ length: 14 }, (_, i) => `<i style="left:${i * 17}px">${MODEL_ORDER.map((m, j) => `<b style="background:var(--m${j + 1})"></b>`).join("")}</i>`).join("")}</div>
    <div class="rule"></div>
    <div class="axis"><span id="D14a" style="left:0"></span><span style="right:0">today</span></div>
    <div class="leg" id="D14l"></div>`;
  T.HM = `<div class="t"><span>Hours, 14 days</span><span class="v" id="HMn" style="width:10em"></span></div>
    <div style="position:relative;height:112px;margin-top:4px">
      <div style="position:absolute;left:0;top:0;width:12px;font-size:11px;color:var(--sec)">${["M", "T", "W", "T", "F", "S", "S"].map((d) => `<div style="height:16px;line-height:16px">${d}</div>`).join("")}</div>
      <canvas id="HMc" width="456" height="224" style="position:absolute;left:12px;top:0;width:228px;height:112px"></canvas>
    </div>
    <div class="axis" style="margin-top:4px"><span style="left:12px">12 am</span><span style="left:69px">6 am</span><span style="left:126px">noon</span><span style="left:183px">6 pm</span></div>`;
  T.TD = `<div class="t"><span>Today</span><span class="v" id="TDd" style="width:7em"></span></div>
    ${row("h32", "tokens out", "", "5.2em", [null, "TDo"]).replace('class="v"', 'class="v disp f26"')}
    ${row("", "calls", "", "5em", [null, "TDc"])}
    ${row("", "cache reads", "", "9em", [null, "TDr"])}
    ${row("", "cache writes · input", "", "7em", [null, "TDw"])}
    ${row("", "prompts · failed turns", "", "5em", [null, "TDp"])}
    <div style="margin-top:10px">${[0, 1].map((i) => `<div class="r h20"><span class="k" id="TDmk${i}"></span><span class="v" id="TDmv${i}" style="width:5em"></span></div>`).join("")}</div>`;
  T.BH = `<div class="t"><span>Today by hour</span><span class="v" id="BHn" style="width:11em"></span></div>
    <div class="cols" id="BHc">${Array.from({ length: 24 }, (_, i) => `<i style="left:${i * 10}px;width:8px;height:128px"><b></b></i>`).join("")}</div>
    <div class="rule"></div>
    <div class="axis"><span style="left:0">12 am</span><span style="left:60px">6 am</span><span style="left:120px">noon</span><span style="left:180px">6 pm</span></div>`;
  T.LG = `<div class="t"><span>Log</span><span class="v" id="LGn" style="width:8em"></span></div>
    ${Array.from({ length: 7 }, (_, i) => `<div class="r h20 lg" id="LGr${i}"><span class="k sec" id="LGt${i}" style="width:40px"></span><span class="k" id="LGx${i}" style="left:44px;width:187px"></span></div>`).join("")}`;
  T.WX = `<div class="win" id="WXwin"><canvas id="WXsky"></canvas><div id="WXcl" style="width:524px;height:96px"></div><canvas id="WXfr"></canvas><canvas id="WXfx"></canvas><div id="WXpr" style="width:262px;height:192px"></div></div>
    <div class="off" id="WXo" style="display:none"></div><div class="body">
    ${row("h32", "", "", "4.2em", ["WXt", "WXd"]).replace('class="v"', 'class="v disp f28"')}
    ${row("", "feels · humidity", "", "7em", [null, "WXf"])}
    ${row("", "wind", "", "9em", [null, "WXw"])}
    ${row("", "sun", "", "9em", [null, "WXu"])}</div>`;
  T.NT = `<div class="t"><span class="k" id="NTt" style="width:7em">Network</span><span class="v" id="NTn" style="width:13em"></span></div>
    <canvas id="NTc" width="480" height="112" style="width:240px;height:56px"></canvas>
    <div class="t" style="margin-top:8px"><span>Disk I/O</span><span class="v" id="NTd" style="width:13em"></span></div>
    <canvas id="NTk" width="480" height="88" style="width:240px;height:44px"></canvas>`;
  T.ME = `<div class="t"><span id="MEt">Memory</span><span class="v" id="MEp" style="width:9em"></span></div>
    <div class="memstack"><b id="ME1" style="background:var(--mz1)"></b><b id="ME2" style="background:var(--mz2)"></b><b id="ME3" style="background:var(--mz3)"></b><b id="ME4" style="background:var(--mz4)"></b></div>
    <div style="position:absolute;left:11px;top:59px;width:112px">${["wired", "active", "compressed", "cached"].map((l, i) => row("h24", `<em class="sw" style="background:var(--mz${i + 1})"></em>${l}`, "", "4em", [null, "ME" + "abcd"[i]])).join("")}</div>
    <div style="position:absolute;left:139px;top:59px;width:112px">${row("h24", "free", "", "4em", [null, "MEe"])}${row("h24", "swap", "", "4em", [null, "MEf"])}${row("h24", "used", "", "4em", [null, "MEg"])}${row("h24", "total", "", "4em", [null, "MEh"])}</div>`;
  T.CP = `<div class="t"><span>CPU, 10 cores</span><span class="v" id="CPn" style="width:5em"></span></div>
    <div class="cores" id="CPc">${Array.from({ length: 10 }, (_, i) => `<i style="left:${i * 23}px"><b></b></i>`).join("")}</div>
    <div class="rule"></div>
    ${row("h20", "load 1 · 5 · 15 min", "", "9em", [null, "CPl"])}
    ${row("h20", "GPU", "", "9em", [null, "CPg"])}
    ${row("h20", "user · system", "", "7em", [null, "CPu"])}`;
  T.BZ = `<div class="t"><span>Busiest processes</span><span class="v" style="width:6em">by CPU</span></div>
    ${[0, 1, 2, 3].map((i) => `<div class="r h20"><span class="k mono" id="BZn${i}" style="width:140px"></span><i class="pbar" id="BZb${i}"><b></b></i><span class="v" id="BZv${i}" style="width:3.2em"></span></div>`).join("")}
    <div class="t" style="margin-top:6px"><span>by memory</span></div>
    ${[0, 1].map((i) => `<div class="r h20"><span class="k mono" id="BZm${i}" style="width:200px"></span><span class="v" id="BZw${i}" style="width:5em"></span></div>`).join("")}`;
  T.BT = `<div class="gauge"><i id="BTg"></i></div><div class="n" id="BTn"></div><div class="u" id="BTs"></div>`;
  T.DK = `<div class="gauge"><i id="DKg"></i></div><div class="n" id="DKn"></div><div class="u">GB free</div>`;
  T.hub = `<svg width="192" height="192" viewBox="0 0 192 192" id="rim"></svg>
    <div class="in"><div class="hn"><span class="disp f26" id="HBn"></span><span class="hl">open</span></div>
    <div class="hs" id="HBs"></div><div class="hs" id="HBbg"></div></div>`;
  for (const [id, x, y, w, h] of CARDS) {
    const d = document.createElement("section");
    d.className = "card" + (id === "BT" || id === "DK" ? " rail" : "");
    d.id = id; d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    d.innerHTML = T[id]; cards.appendChild(d);
  }
  // Three session slots, built once and always shown: a session, or the slot's idle state.
  const leaves = SLOT.y.map((y, i) => {
    const d = document.createElement("section"), L = "L" + i;
    d.className = `card leaf free s${i + 1}`; d.id = L; d.style.cssText = `left:${SLOT.x}px;top:${y}px;width:${SLOT.w}px;height:${SLOT.h}px`;
    d.innerHTML = `<div class="r h20"><span class="k nm" id="${L}n" style="width:170px"></span><span class="v sec on" id="${L}m" style="width:5.4em"></span></div>
      <div class="on">
        <div class="r h20"><i class="dot"></i><span class="k st" id="${L}s" style="width:150px"></span><span class="v sec" id="${L}u" style="width:6.6em"></span></div>
        <div class="r sec"><span class="k" id="${L}c"></span><span class="v" id="${L}p" style="width:3em"></span></div>
        <div class="bar"><i id="${L}b"></i></div>
        <div class="r h20 r5"><span class="k" id="${L}o" style="width:242px"></span></div>
        <div class="r h20 sec"><span class="k" id="${L}h" style="width:242px"></span></div>
        <div class="r h20"><span class="k" id="${L}a" style="width:120px"></span><span class="v sec" id="${L}x" style="width:9em"></span></div>
        <div class="r h20 sec"><span class="k" id="${L}f" style="width:242px"></span></div>
      </div>
      <div class="off">
        <div class="r h20 sec"><span class="k" style="width:242px">the next session opens here</span></div>
        <div class="t" style="margin-top:12px"><span>Last here</span></div>
        ${[0, 1, 2].map((j) => `<div class="r h20"><span class="k" id="${L}l${j}" style="width:170px"></span><span class="v sec" id="${L}t${j}" style="width:4em"></span></div>`).join("")}
      </div>`;
    cards.appendChild(d); return d;
  });

  const set = (id, s) => { const e = $(id); if (e && e.textContent !== s) e.textContent = s; };
  const tf = (id, v) => { const e = $(id); if (e && e.style.transform !== v) e.style.transform = v; };
  const show = (id, on) => { const e = $(id), v = on ? "" : "none"; if (e.style.display !== v) e.style.display = v; };
  const cls = (el, c) => { if (el.className !== c) el.className = c; };
  const kvar = (el, v) => { if (el._kk !== v) { el._kk = v; el.style.setProperty("--kk", v); } };
  // Fixed digit slots for the two left/centre-anchored Fraunces figures (no tnum in the face)
  function slots(el, str, first1) {
    const key = str.length + "|" + str.replace(/[\d ]/g, "#");
    if (el._key !== key) {
      el._key = key;
      el.innerHTML = [...str].map((ch, i) => /[\d ]/.test(ch) ? `<i${first1 && i === 0 ? ' class="one"' : ""}></i>` : `<span>${ch}</span>`).join("");
    }
    const its = el.querySelectorAll("i"); let k = 0;
    for (const ch of str) if (/[\d ]/.test(ch)) { const e = its[k++]; if (e && e.textContent !== ch.trim()) e.textContent = ch.trim(); }
  }

  // ---------- the Dock: the rail and the clock, laid out from Kiln.dock, only in onDock ----------
  // The rail holds two tiles, ranked battery then disk, in fixed slots aligned to the bottom
  // band (780-869, 881-970). A slot the Dock reaches (with a 12-pt gutter) stays empty; the
  // lower-ranked tile gives way first, and both come back when the Dock shrinks. The clock
  // card spans the rail above the Dock; a Dock reaching above y 180 moves it into C1.
  function layoutDock(dock) {
    const d = dock && dock.side === "left" ? dock : { y0: Infinity, y1: -Infinity };
    const free = [[780, 869], [881, 970]].filter(([a, b]) => b + 12 <= d.y0 || a - 12 >= d.y1);
    ["BT", "DK"].forEach((id, i) => { const e = $(id), s = free[i]; e.style.display = s ? "block" : "none"; if (s) e.style.top = s[0] + "px"; });
    const ck = $("CK"), wide = d.y0 >= 180;
    ck.style.left = (wide ? 12 : 78) + "px"; ck.style.width = (wide ? 330 : 264) + "px";
  }
  Kiln.onDock(layoutDock);

  // ---------- stems: the hub's three fixed spokes, built once ----------
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  // the Today spoke leaves the hub's left and lands mid-right on Today, in the 42 pt between
  const TODAY_C = [[HUB.x - RIM_OUT, 468], [630, 468], [662, 276], [618, 276]];
  (function stems() {
    const g = $("stems"), label = (x, y, txt, anchor) => { const t = mk("text", { x, y, "text-anchor": anchor || "start", "dominant-baseline": "central" }, g); t.textContent = txt; };
    // the vertical spokes stop on the ring (0.5 pt off the axis: under 0.002 pt short of it)
    mk("path", { d: `M755.5,168 V${HUB.y - RIM_OUT}` }, g); label(749, 352, "agents", "end");
    mk("path", { d: `M755.5,${HUB.y + RIM_OUT} V780` }, g); label(772, 676, "the machine");
    mk("path", { d: `M${TODAY_C.map((p) => p.join(",")).join(" ").replace(" ", " C")}` }, g); label(624, 262, "today");
    mk("path", { d: "M342,276 H354" }, g); mk("path", { d: "M210,576 V588" }, g);
  })();

  // ---------- hub rim: ten core arcs ----------
  const rimArcs = [];
  (function rim() {
    const g = $("rim"), R = RIM.r, cx = 96, cy = 96;
    const arc = (a0, a1) => { const p = (a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)]; const [x0, y0] = p(a0), [x1, y1] = p(a1); return `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`; };
    for (let i = 0; i < 10; i++) {
      const a0 = -Math.PI / 2 + i * Math.PI / 5 + 0.03, a1 = a0 + Math.PI / 5 - 0.06, len = R * (a1 - a0);
      mk("path", { d: arc(a0, a1), stroke: C.tr, "stroke-width": RIM.w, fill: "none" }, g);
      // set once per update, never transitioned: a dasharray transition repaints the hub
      const e = mk("path", { d: arc(a0, a1), stroke: C.z1, "stroke-width": RIM.w, fill: "none", "stroke-dasharray": `0 ${len.toFixed(2)}` }, g);
      rimArcs.push({ e, len });
    }
  })();

  // ---------- load inks: the machine's cores and memory, calm -> strained -> over ----------
  // A core's bar (and its rim arc) takes the ramp by its own % busy; at 90 % and over it is
  // pegged and turns red, past a hairline drawn at 90 on every track, so "over" is a place
  // and not only a hue. Memory takes Activity Monitor's own states: normal pressure sits on
  // the ramp by used/total, warn at its top, critical red; its four segments are lightness
  // steps of that one ink. Colours are written only when the quantised ink changes, never
  // transitioned. Blue, after green-red, sage and zinc-red were drawn on the real tiles
  // (a ramp comparison sheet): green-red's strained amber sits on brass (Fable) under
  // deutan (dE 2.0), sage beside verdigris; blue keeps 12-15 between steps under deutan and 46
  // to the red, and is the only cool ink on a warm page. Its top stays 12.8 off steel (k2).
  const hx = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const RAMP = ["#2f5069", "#3f7299", "#5d99c6"].map(hx), OVER = "#e5483c", PEG = 90;
  const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const rampAt = (f) => { f = Math.round(Math.max(0, Math.min(1, f)) * 24) / 24 * (RAMP.length - 1); const i = Math.min(RAMP.length - 2, Math.floor(f)), t = f - i; return toHex(RAMP[i].map((v, j) => v + (RAMP[i + 1][j] - v) * t)); };
  const coreInk = (pct) => pct >= PEG ? OVER : rampAt(pct / PEG);
  const memInk = (m) => m.pressure === "critical" ? OVER : m.pressure === "warn" ? rampAt(1) : rampAt(0.15 + 0.7 * m.used / m.total);
  // wired, active, compressed, cached: the ink lifted toward chalk, then sunk toward the panel
  const memSteps = (ink) => { const c = hx(ink), ch = hx("#e6e0d4"), bg = hx("#1d1b18"); return [c.map((v, i) => v + (ch[i] - v) * 0.45), c.map((v, i) => v + (ch[i] - v) * 0.2), c, c.map((v, i) => v + (bg[i] - v) * 0.4)].map(toHex); };

  // ---------- the ground: Oxford's contours, lit by the real sun (ground.js from ground-gen.py) ----------
  // Tanaka's illuminated contours: a line brightens where its slope faces the light (the real
  // sun over the place at state.t through nautical twilight, then the moon by its phase).
  // The panels are translucent now, so every line is kept, and the ground is a BITMAP: the
  // contours are drawn as SVG, rasterised once at the screen's scale into a PNG, and shown
  // as an <img>, so a repaint under a changing figure is a copy. Measured 2026-11-06 at
  // 300 ms: inline SVG under translucent panels 10.2 % WebContent (every per-line repaint
  // walked the paths under it); an SVG <img> 6.8 % (WebKit re-renders SVG images per
  // repaint). Rebuilt only when a group's ink moves: at most once a minute, at the sun's
  // pace, and not at all through a moonless night.
  // The new picture never goes into the shown <img>: setting src there leaves WebKit frames
  // with no picture while it decodes a 3024 x 1964 bitmap off the main thread, and the whole
  // screen blinks to the page colour. It is decoded in a fresh <img> off the page, which then
  // takes the old one's place in one task, so a picture is painted on every frame; the old
  // blob URL is released only after that.
  const G = window.MM_GROUND;
  let ground = $("ground");
  const groundCol = { hair: [], index: [] };
  let groundUrl = null, groundBusy = false, groundAgain = false;
  function paintGround() {
    if (groundBusy) { groundAgain = true; return; }
    groundBusy = true;
    let body = "";
    for (const kind of ["hair", "index"]) for (let b = 0; b < G.bins; b++) body += `<path stroke="${groundCol[kind][b]}" stroke-width="${kind === "hair" ? 0.5 : 1}" d="${G[kind][b]}"/>`;
    const svgUrl = URL.createObjectURL(new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="1512" height="982" viewBox="0 0 1512 982"><g fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`], { type: "image/svg+xml" }));
    const img = new Image(), k = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const done = () => { groundBusy = false; if (groundAgain) { groundAgain = false; paintGround(); } };
    const show = (url) => {
      const n = new Image(); n.id = "ground"; n.width = 1512; n.height = 982; n.alt = ""; n.src = url;
      const put = () => {
        if (n.naturalWidth) { const old = groundUrl; groundUrl = url; ground.replaceWith(n); ground = n; if (old && old !== url) URL.revokeObjectURL(old); }
        else URL.revokeObjectURL(url);            // it never loaded: the old picture stays
        if (url !== svgUrl) URL.revokeObjectURL(svgUrl);
        done();
      };
      n.decode().then(put, put);
    };
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = 1512 * k; c.height = 982 * k;
      try {
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((png) => { c.width = c.height = 0; show(png ? URL.createObjectURL(png) : svgUrl); }, "image/png");
      } catch (e) {   // a canvas the engine will not export: show the SVG itself (slower, never blank)
        c.width = c.height = 0; show(svgUrl);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(svgUrl); done(); };
    img.src = svgUrl;
  }
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const INK = {                 // shade, base, sun-lit, moon-lit
    hair: ["#332f2a", "#453f38", "#8a5438", "#6f6d69"].map(hex),
    index: ["#3a3530", "#524b43", "#a35e3b", "#8a8782"].map(hex),
  };
  const RAD = Math.PI / 180;
  // Sun and moon over G.lat/G.lon from t alone (suncalc's low-precision series, about 1 deg):
  // compass azimuth (0 = N, clockwise) and altitude, radians; moonLit 0..1; waxing.
  function sky(t) {
    const d = t / 86400 - 0.5 + 2440588 - 2451545, e = 23.4397 * RAD, phi = G.lat * RAD;
    const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
    const dec = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
    const st = (280.16 + 360.9856235 * d) * RAD + G.lon * RAD;
    const pos = (r, dc) => { const H = st - r; return { az: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dc) * Math.cos(phi)) + Math.PI, alt: Math.asin(Math.sin(phi) * Math.sin(dc) + Math.cos(phi) * Math.cos(dc) * Math.cos(H)) }; };
    const M = (357.5291 + 0.98560028 * d) * RAD, Cc = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * RAD;
    const Ls = M + Cc + 102.9372 * RAD + Math.PI, sra = ra(Ls, 0), sdec = dec(Ls, 0);
    const Lm = (218.316 + 13.176396 * d) * RAD, Mm = (134.963 + 13.064993 * d) * RAD, Fm = (93.272 + 13.22935 * d) * RAD;
    const lm = Lm + 6.289 * RAD * Math.sin(Mm), bm = 5.128 * RAD * Math.sin(Fm), dm = 385001 - 20905 * Math.cos(Mm);
    const mra = ra(lm, bm), mdec = dec(lm, bm);
    const ph = Math.acos(Math.sin(sdec) * Math.sin(mdec) + Math.cos(sdec) * Math.cos(mdec) * Math.cos(sra - mra));
    const inc = Math.atan2(149598000 * Math.sin(ph), dm - 149598000 * Math.cos(ph));
    const el = ((lm - Ls) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    return { sun: pos(sra, sdec), moon: pos(mra, mdec), moonLit: (1 + Math.cos(inc)) / 2, waxing: el < Math.PI };
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const light = (k) => { const sunUp = clamp01((k.sun.alt / RAD + 10) / 14); return { sunUp, moonUp: clamp01((k.moon.alt / RAD + 2) / 10) * k.moonLit * (1 - sunUp) * 0.7 }; };
  let groundMin = null;
  function drawGround(t) {
    const k = sky(t), { sunUp, moonUp } = light(k);
    let moved = false;
    for (const kind of ["hair", "index"]) {
      const [shade, base, sun, moon] = INK[kind];
      for (let b = 0; b < G.bins; b++) {
        const th = b * 2 * Math.PI / G.bins, cs = Math.cos(th - k.sun.az), cm = Math.cos(th - k.moon.az);
        const ls = Math.max(0, cs) * sunUp, sh = Math.max(0, -cs) * sunUp, lm = Math.max(0, cm) * moonUp;
        const c = base.map((v, i) => Math.round(v + (shade[i] - v) * sh + (sun[i] - v) * ls + (moon[i] - v) * lm));
        const col = `rgb(${c[0]},${c[1]},${c[2]})`;
        if (groundCol[kind][b] !== col) { groundCol[kind][b] = col; moved = true; }
      }
    }
    if (moved) paintGround();
  }
  function lightTime(now, w) {
    if (OV.sun) { const [h, m] = OV.sun.split(":").map(Number), d = new Date(now * 1000); d.setHours(h, m || 0, 0, 0); return d.getTime() / 1000; }
    return w && w._now || now;
  }

  // ---------- motion: every running animation pauses with the wallpaper ----------
  const running = new Set();
  const keep = (a) => { running.add(a); a.addEventListener("finish", () => running.delete(a)); a.addEventListener("cancel", () => running.delete(a)); if (paused()) a.pause(); return a; };
  new MutationObserver(() => { const p = paused(); for (const a of running) { if (p && a.playState === "running") a.pause(); else if (!p && a.playState === "paused") a.play(); } })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  // ---------- threads: ribbons, strands, beads ----------
  // Each thread is its own small <svg> (the field's box), so a fade is one composited
  // opacity animation and a rebuild repaints only that thread.
  // Each box is cut to its thread's own extent (points plus pad): a fade lifts the svg into a
  // compositing layer for 400 ms, and a bead running under it lifts it too, so a box the size
  // of the whole field (600 x 620 for a ribbon or strand, 660 x 820 for a link) meant a layer
  // that large made and dropped with every cord, strand and bead. (svg overflow is visible,
  // so the cut changes no pixel.)
  const threads = $("threads");
  function threadSvg(z, pts, pad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad); const w = Math.ceil(x1 + pad) - x0, h = Math.ceil(y1 + pad) - y0;
    const s = mk("svg", { width: w, height: h, viewBox: `${x0} ${y0} ${w} ${h}` });
    s.style.cssText = `left:${x0}px;top:${y0}px;z-index:${z}`; threads.appendChild(s); return s;
  }
  const fadeIn = (el) => { if (!RM && !paused()) keep(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: "ease-out" })); };
  const fadeOut = (el) => { if (RM || paused()) { el.remove(); return; } const a = keep(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, easing: "ease-in", fill: "forwards" })); a.onfinish = () => el.remove(); };

  // Fritsch-Carlson monotone cubic through the sixty minute widths: smooth, no overshoot.
  function monotone(ys) {
    const n = ys.length, d = [], m = new Array(n).fill(0);
    for (let i = 0; i < n - 1; i++) d.push(ys[i + 1] - ys[i]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return (x) => { const i = Math.max(0, Math.min(n - 2, Math.floor(x))), t = x - i, t2 = t * t, t3 = t2 * t; return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * m[i + 1]; };
  }
  // A cubic resampled by arc length into n points.
  function bez(p0, p1, p2, p3, n) {
    const B = (t) => { const u = 1 - t; return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]; };
    const dense = [], cum = [0]; let prev = B(0); dense.push(prev);
    for (let k = 1; k <= 400; k++) { const p = B(k / 400); cum.push(cum[k - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1])); dense.push(p); prev = p; }
    const total = cum[400], pts = []; let j = 0;
    for (let k = 0; k < n; k++) {
      const s = total * k / (n - 1);
      while (j < 399 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
      pts.push([dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f, dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f]);
    }
    return pts;
  }
  // Slot i's root on the hub rim and its ribbon's centreline, hub -> the leaf's mid-left.
  const ROOT = [-0.7, 0.04, 0.76];
  const SUB = 6, NP = 60 * SUB;
  const LINES = SLOT.y.map((y, i) => {
    const a = ROOT[i], r0 = RIM_OUT, ey = y + SLOT.h / 2;
    const p0 = [HUB.x + r0 * Math.cos(a), HUB.y + r0 * Math.sin(a)];
    return bez(p0, [p0[0] + 110 * Math.cos(a), p0[1] + 110 * Math.sin(a)], [SLOT.x - 150, ey], [SLOT.x + 1, ey], NP);
  });
  const ribbons = new Map();     // sid -> {svg, slot, key}
  const tick = (e, p) => {
    const alert = e.kind === "ask" || e.kind === "fail" || e.kind === "remind", col = alert ? C.al : C.ink, [x, y] = p.map((v) => v.toFixed(1));
    if (e.kind === "done" || e.kind === "answered") return `<circle cx="${x}" cy="${y}" r="2.5" fill="${col}"/>`;
    if (e.kind === "ask" || e.kind === "remind") return `<circle cx="${x}" cy="${y}" r="3" fill="${C.bg}" stroke="${col}" stroke-width="1.5"/>`;
    if (e.kind === "fail") return `<path d="M${+x - 3},${+y - 3}L${+x + 3},${+y + 3}M${+x + 3},${+y - 3}L${+x - 3},${+y + 3}" stroke="${col}" stroke-width="1.5"/>`;
    if (e.kind === "agent_start") return `<path d="M${x},${+y - 3.5}L${+x + 3.2},${+y + 2.2}L${+x - 3.2},${+y + 2.2}Z" fill="${col}"/>`;
    if (e.kind === "agent_done") return `<path d="M${x},${+y + 3.5}L${+x + 3.2},${+y - 2.2}L${+x - 3.2},${+y - 2.2}Z" fill="${col}"/>`;
    return "";
  };
  // [1 2 1]/4 over the minutes keeps each minute's share of the hour but stops a single
  // minute's spike reading as a sawtooth edge
  const smooth = (o) => o.map((v, k) => (o[k - 1] == null ? v : o[k - 1]) * 0.25 + v * 0.5 + (o[k + 1] == null ? v : o[k + 1]) * 0.25);
  // A band along a centreline: pts[k] with full width wAt(k). Its first end starts on the
  // dial: the two corners are pulled onto the ring along their radius, so a wide band meets the
  // ring along its curve (no sliver at the corners, no overshoot into it).
  const onRim = (x, y) => { const dx = x - HUB.x, dy = y - HUB.y, m = Math.hypot(dx, dy) || 1; return [HUB.x + dx * RIM_OUT / m, HUB.y + dy * RIM_OUT / m]; };
  function bandPath(pts, wAt) {
    const n = pts.length, L = [], R = [];
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
      let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const m = Math.hypot(nx, ny) || 1; nx /= m; ny /= m;
      const w = wAt(k) / 2, p = pts[k];
      let l = [p[0] + nx * w, p[1] + ny * w], r = [p[0] - nx * w, p[1] - ny * w];
      if (k === 0) { l = onRim(...l); r = onRim(...r); }
      L.push(l[0].toFixed(1) + "," + l[1].toFixed(1)); R.push(r[0].toFixed(1) + "," + r[1].toFixed(1));
    }
    return `M${L.join("L")}L${R.reverse().join("L")}Z`;
  }
  function ribbonMarkup(s, i, peak, events, now) {
    const pts = LINES[i], ink = KINK[i], wf = monotone(smooth(s.out_per_min).map((v) => 1.5 + 22.5 * v / peak));
    let out = `<path d="${bandPath(pts, (k) => wf(k / SUB))}" fill="${ink}"/>`;
    for (const e of events) if (e.sid === s.sid && now - e.t < 3600) out += tick(e, pts[Math.max(0, Math.min(NP - 1, Math.round((1 - (now - e.t) / 3600) * (NP - 1))))]);
    // where it plugs into its leaf: working = a filled node, idle = a ring, waiting = an
    // alert ring, failed = an alert cross
    const [ex, ey] = pts[NP - 1].map((v) => v.toFixed(1)), st = s.state;
    out += st === "failed" ? `<path d="M${+ex - 4},${+ey - 4}L${+ex + 4},${+ey + 4}M${+ex + 4},${+ey - 4}L${+ex - 4},${+ey + 4}" stroke="${C.al}" stroke-width="2"/>`
      : `<circle cx="${ex}" cy="${ey}" r="4" fill="${st === "working" || st === "background" ? ink : C.bg}" stroke="${st === "waiting" ? C.al : ink}" stroke-width="2"/>`;
    return out;
  }
  // events in the last hour, by time, kind and session: what the ticks are drawn from
  const evKey = (events, now) => { let k = ""; for (const e of events) if (now - e.t < 3600) k += e.t + e.kind + e.sid; return k; };
  function drawRibbons(bySlot, events, now) {
    const peak = Math.max(1, ...bySlot.filter(Boolean).map((s) => Math.max(...s.out_per_min)));
    const ek = evKey(events, now), live = new Set();
    bySlot.forEach((s, i) => {
      if (!s) return;
      live.add(s.sid);
      let r = ribbons.get(s.sid);
      if (r && r.slot !== i) { fadeOut(r.svg); ribbons.delete(s.sid); r = null; }
      const fresh = !r;
      // (pad: the band's half-width, 12, and the leaf's node or cross, 5)
      if (fresh) { r = { svg: threadSvg(1, LINES[i], 14), slot: i }; ribbons.set(s.sid, r); }
      if (!(r.peak === peak && r.state === s.state && r.ek === ek && sameNums(r.opm, s.out_per_min))) {
        r.peak = peak; r.state = s.state; r.ek = ek; r.opm = s.out_per_min;
        r.svg.innerHTML = ribbonMarkup(s, i, peak, events, now);
      }
      if (fresh && booted) fadeIn(r.svg);
    });
    for (const [sid, r] of ribbons) if (!live.has(sid)) { fadeOut(r.svg); ribbons.delete(sid); }
  }

  // Agent strands: every running subagent, from its session's root on the rim up to the
  // crown, in its session's ink. A strand keeps its landing place while it is out.
  const LAND = Array.from({ length: 10 }, (_, k) => 766 + 11 * k);
  const strands = new Map();     // agent id -> {svg, pts, land, slot, port}
  // Ports: each strand plugs into the ring at its own port, a jack dot on the ring's outer edge.
  // A slot's ports fan from just past its ribbon's widest root (12 pt) toward the crown, 7.5 pt
  // apart (a jack is 5.6 across), and stop short of the next ribbon's root (or of the agents
  // spoke, for the top slot); past the last one, strands share it.
  const PORT_GAP = 16 / RIM_OUT, PORT_STEP = 7.5 / RIM_OUT;
  const PORT_END = [-Math.PI / 2 + 7 / RIM_OUT, ROOT[0] + 16.3 / RIM_OUT, ROOT[1] + 16.3 / RIM_OUT];
  const PORT_LAST = ROOT.map((r, s) => Math.floor((r - PORT_GAP - PORT_END[s]) / PORT_STEP));   // 7, 4, 4
  // how far each slot's strands run straight out before turning up: the lowest slot leaves
  // the ring heading down and right, and needs the long reach to clear the dial on its way up.
  // Each port further round reaches less, so neighbours stay 7 pt or more apart through the
  // turn and every one clears the card (measured: least radius 100, least gap 7.4).
  const REACH = [70, 80, 165], REACH_STEP = [8, 12, 25];
  function strandPts(slot, port, land) {
    // leave the ring along its radius, so the strand meets the jack square on
    const j = Math.min(port, PORT_LAST[slot]), a = ROOT[slot] - PORT_GAP - PORT_STEP * j, u = [Math.cos(a), Math.sin(a)];
    const p0 = [HUB.x + RIM_OUT * u[0], HUB.y + RIM_OUT * u[1]], reach = REACH[slot] - REACH_STEP[slot] * j;
    return bez(p0, [p0[0] + u[0] * reach, p0[1] + u[1] * reach], [land, CROWN_Y + 110], [land, CROWN_Y + 2], 32);
  }
  function bead(pts, d, ms, colour, offsets) {
    if (RM || paused() || !booted) return;
    const el = document.createElement("i"); el.className = "bead"; el.style.width = el.style.height = d + "px";
    if (colour) el.style.background = colour;
    const kf = pts.map((p, k) => ({ transform: `translate(${(p[0] - d / 2).toFixed(1)}px,${(p[1] - d / 2).toFixed(1)}px)`, opacity: p[2] == null ? 1 : p[2], offset: offsets ? offsets[k] : k / (pts.length - 1) }));
    threads.appendChild(el);
    const a = keep(el.animate(kf, { duration: ms, easing: "linear" })); a.onfinish = a.oncancel = () => el.remove();
  }
  function drawStrands(agents, slotOf, bySlot) {
    const live = new Set(), used = new Set([...strands.values()].map((s) => s.land));
    const ports = new Set([...strands.values()].map((s) => s.slot + "|" + s.port));
    for (const a of agents) {
      const slot = slotOf.get(a.sid); if (slot == null) continue;
      let s = strands.get(a.id);
      if (!s) {
        if (used.size >= LAND.length) continue;
        // the slot's first free port (a strand keeps its port while it is out)
        let port = 0; while (port < PORT_LAST[slot] && ports.has(slot + "|" + port)) port++;
        ports.add(slot + "|" + port);
        // its landing place: strands nest round the dial's right side, the lowest slot and a
        // slot's first port outermost, so the outermost lands furthest right. Of the free
        // places, the one that crosses fewest strands already out, then the nearest its share
        // of the crown (slot 0 left, slot 2 right).
        const rank = slot * 20 + 19 - port, ideal = Math.min(9, Math.max(0, Math.round(slot * 3.5 + 3 - port)));
        let k = -1, best = Infinity;
        LAND.forEach((x, i) => {
          if (used.has(x)) return;
          let cross = 0; for (const o of strands.values()) if ((x - o.land) * (rank - o.rank) < 0) cross++;
          const score = cross * 100 + Math.abs(i - ideal); if (score < best) { best = score; k = i; }
        });
        used.add(LAND[k]);
        const pts = strandPts(slot, port, LAND[k]), svg = threadSvg(2, pts, 4);
        const d = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L"), [jx, jy] = pts[0].map((v) => v.toFixed(1));
        // the paper under-stroke and the strand end square on the ring; the jack (r 2.2 and its
        // 0.6 paper edge, wider than the 2.25 half-width under-stroke) covers both ends
        svg.innerHTML = `<path d="${d}" fill="none" stroke="${C.bg}" stroke-width="4.5"/><path d="${d}" fill="none" stroke="${KINK[slot]}" stroke-width="1.5"/>` +
          `<circle cx="${jx}" cy="${jy}" r="2.2" fill="${KINK[slot]}" stroke="${C.bg}" stroke-width="1.2"/><circle cx="${LAND[k]}" cy="${CROWN_Y + 3}" r="2.5" fill="${KINK[slot]}"/>`;
        s = { svg, pts, land: LAND[k], slot, port, rank, sid: a.sid }; strands.set(a.id, s);
        if (booted) { fadeIn(svg); bead(pts, 8, 700, KINK[slot]); }
      }
      live.add(a.id);
    }
    for (const [id, s] of strands) if (!live.has(id) || !bySlot.some((x) => x && x.sid === s.sid)) {
      bead(s.pts.slice().reverse(), 8, 600, KINK[s.slot]); fadeOut(s.svg); strands.delete(id);
    }
    return [...strands.entries()].sort((a, b) => a[1].land - b[1].land).map(([id]) => id);
  }
  // Tokens landing: when a session's minute in progress grows (Claude Code writes usage
  // once per response), a bead the size of the response runs its ribbon into the hub and
  // out along the today spoke.
  const TODAY_LINE = bez(...TODAY_C, 96), TODAY_PTS = TODAY_LINE.filter((_, k) => k % 8 === 0 || k === 95);
  const landed = new Map();      // sid -> [minute, tokens in it]
  function tokensLanding(bySlot, now) {
    const minute = Math.floor(now / 60);
    bySlot.forEach((s, i) => {
      if (!s) return;
      const v = s.out_per_min[59] || 0, p = landed.get(s.sid), dv = !p ? 0 : p[0] === minute ? v - p[1] : v;
      landed.set(s.sid, [minute, v]);
      if (dv <= 0 || !p) return;
      const d = Math.max(6, Math.min(12, Math.round(6 + 1.5 * Math.log2(dv / 200 + 1))));
      const rib = LINES[i].filter((_, k) => k % 15 === 0).reverse(), n1 = rib.length, n2 = TODAY_PTS.length;
      const pts = [...rib, [HUB.x - HUB.r, HUB.y, 0], ...TODAY_PTS.map((p, k) => k === n2 - 1 ? [p[0], p[1], 0] : p)];
      const offs = pts.map((_, k) => k < n1 ? 0.55 * k / (n1 - 1) : k === n1 ? 0.6 : 0.6 + 0.4 * (k - n1 - 1) / (n2 - 1));
      offs[n1 - 1] = 0.55; pts[n1 - 1] = [...pts[n1 - 1], 0];
      bead(pts, d, 1500, null, offs);
    });
    for (const sid of landed.keys()) if (!bySlot.some((s) => s && s.sid === sid)) landed.delete(sid);
  }
  // The Today spoke: every session's tokens a minute (the slots, the overflow and the
  // background ones) over the hour, the minute under way at the hub and the hour carried
  // down to Today. Its own scale (the hub's 42-pt gap holds 10 pt of width, not the
  // ribbons' 24); copper, the tokens ink. Rebuilt only when a minute's count changes.
  const todaySvg = mk("svg", { width: 62, height: 222, viewBox: "612 262 62 222" });
  todaySvg.style.cssText = "left:612px;top:262px;z-index:1"; threads.appendChild(todaySvg);
  let todayKey = null;
  function drawToday(all) {
    const tot = new Array(60).fill(0);
    for (const x of all) if (x.out_per_min) x.out_per_min.forEach((v, k) => { tot[k] += v || 0; });
    const key = tot.join();
    if (key === todayKey) return; todayKey = key;
    const peak = Math.max(...tot);
    if (!peak) { todaySvg.innerHTML = ""; return; }
    const wf = monotone(smooth(tot).map((v) => 1.5 + 8.5 * v / peak)), n = TODAY_LINE.length;
    todaySvg.innerHTML = `<path d="${bandPath(TODAY_LINE, (k) => wf(59 * (1 - k / (n - 1))))}" fill="${C.t3}"/>`;
  }
  // ---------- links: tile to tile through the dial ----------
  // A link is a patch cord: from a session's leaf into a jack on the rim, along the rim in its
  // kind's own lane (never across the face), out of a second jack to the related tile; one ink
  // per kind, end to end. need: the session waits or failed (Needs you, alert yellow); busy:
  // its process is one of the machine's busiest by CPU (Busiest, violet, its one meaning);
  // logged: one of its events just landed (the Log, now orange, transient). Agents out are
  // already linked by the strands; Today and The week are not (the week is account-wide, and
  // a tick of it cannot be put down to this Mac's spend).
  const LINK = {
    // Needs you is walled in by The week and the first leaf: its cord comes along the gutter
    // under it (y 168-180) and plugs into its bottom edge. Busiest's cord drops onto its top
    // edge through open ground (its left edge faces the CPU card across a 12-pt gutter).
    need: { ink: C.al, lane: 104, dy: 30, off: -14, a1: -62, to: () => [1264, 168], dir: [-1, 0.04] },
    busy: { ink: "#c77dff", lane: 110, dy: 146, off: 14, a1: 66, to: (slot) => [912 + 16 * slot, 780], dir: [0, -1] },
    log: { ink: C.now, lane: 116, dy: 166, off: 24, a1: 125, to: () => [618, 628], dir: [1, 0] },
  };
  const rimPt = (r, a) => [HUB.x + r * Math.cos(a), HUB.y + r * Math.sin(a)];
  // leaf -> jack (arriving along the radius) -> arc in the lane -> jack -> the tile; ends sit
  // 2 pt off the card edges so the plugs show
  function cordPts(slot, kind) {
    const K = LINK[kind];
    const DEG = Math.PI / 180, a0 = (ROOT[slot] / DEG + K.off) * DEG, a1 = K.a1 * DEG, r = K.lane;
    // (Needs you's plug sits 3 pt under its edge, in the gutter, not on the leaf below)
    const from = [SLOT.x - 2, SLOT.y[slot] + K.dy], t = K.to(slot), to = kind === "need" ? [t[0], t[1] + 3] : [t[0] + K.dir[0] * 2, t[1] + K.dir[1] * 2];
    const j0 = rimPt(r, a0), j1 = rimPt(r, a1), o0 = [Math.cos(a0), Math.sin(a0)], o1 = [Math.cos(a1), Math.sin(a1)];
    const d0 = Math.hypot(j0[0] - from[0], j0[1] - from[1]) * 0.42, d1 = Math.hypot(to[0] - j1[0], to[1] - j1[1]) * 0.42;
    const leg0 = bez(from, [from[0] - d0, from[1]], [j0[0] + o0[0] * d0 * 0.7, j0[1] + o0[1] * d0 * 0.7], j0, 28);
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / 3)), arc = [j0];
    for (let k = 1; k < n; k++) arc.push(rimPt(r, a0 + (a1 - a0) * k / n));
    arc.push(j1);
    const leg1 = bez(j1, [j1[0] + o1[0] * d1 * 0.7, j1[1] + o1[1] * d1 * 0.7], [to[0] + K.dir[0] * d1, to[1] + K.dir[1] * d1], to, 28);
    return { pts: [...leg0, ...arc.slice(1, -1), ...leg1], arc, j0, j1, from, to };
  }
  const links = new Map();       // kind|sid|slot -> {svg, pts, ink}
  const polyD = (pts) => "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L");
  function linkOn(key, kind, slot) {
    const K = LINK[kind], c = cordPts(slot, kind), d = polyD(c.pts), ink = K.ink;
    // (pad: the lit arc's 2.5 half-width and the jacks' 3.2 with their paper edge)
    const svg = threadSvg(3, c.pts.concat(c.arc), 6);
    const dot = (p, r) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r}" fill="${ink}" stroke="${C.bg}" stroke-width="1.2"/>`;
    // paper under-stroke where it crosses ribbons; the lit arc: a wash of the same ink between
    // the jacks; the cord; the two jacks and the two plugs
    svg.innerHTML = `<path d="${d}" fill="none" stroke="${C.bg}" stroke-width="4.5" stroke-linejoin="round"/>` +
      `<path d="${polyD(c.arc)}" fill="none" stroke="${ink}" stroke-width="5" stroke-opacity="0.28" stroke-linecap="round"/>` +
      `<path d="${d}" fill="none" stroke="${ink}" stroke-width="1.5" stroke-linejoin="round"/>` +
      dot(c.j0, 2.6) + dot(c.j1, 2.6) + dot(c.from, 2.2) + dot(c.to, 2.2);
    const pts = c.pts.filter((_, k) => k % 3 === 0).concat([c.pts[c.pts.length - 1]]);
    links.set(key, { svg, pts, ink });
    if (booted) { fadeIn(svg); bead(pts, 7, 1100, ink); }
  }
  function linkOff(key) {
    const l = links.get(key); if (!l) return;
    bead(l.pts.slice().reverse(), 7, 800, l.ink); fadeOut(l.svg); links.delete(key);
  }
  // busy: on after 3 s on the list, off after 5 s off it (lines every 100-1000 ms must not
  // flicker a cord); logged: 2.6 s from the newest event of that session
  const busySeen = new Map(), logUntil = new Map();
  let lastEvT = null;
  function drawLinks(bySlot, events, sys, now) {
    const want = new Map(), claudeCpu = (sys.top_cpu || []).filter((r) => /claude/i.test(r[0])).map((r) => r[1]);
    // events: what landed since the last line (the first line only sets the mark)
    let newest = lastEvT;
    for (const e of events) if (lastEvT == null || e.t > lastEvT) { if (lastEvT != null && e.sid) logUntil.set(e.sid, now + 2.6); newest = newest == null ? e.t : Math.max(newest, e.t); }
    lastEvT = newest == null ? now : newest;
    bySlot.forEach((x, i) => {
      if (!x) return;
      if (x.state === "waiting" || x.state === "failed") want.set(`need|${x.sid}|${i}`, ["need", i]);
      const onList = x.cpu != null && x.cpu > 0 && claudeCpu.some((v) => Math.abs(v - x.cpu) < 0.05);
      let b = busySeen.get(x.sid); if (!b) busySeen.set(x.sid, (b = { on: false, t: now }));
      if (onList === b.on) b.t = now; else if (now - b.t >= (b.on ? 5 : 3)) { b.on = onList; b.t = now; }
      if (b.on) want.set(`busy|${x.sid}|${i}`, ["busy", i]);
      if ((logUntil.get(x.sid) || 0) > now) want.set(`log|${x.sid}|${i}`, ["log", i]);
    });
    for (const sid of busySeen.keys()) if (!bySlot.some((x) => x && x.sid === sid)) busySeen.delete(sid);
    for (const [sid, t] of logUntil) if (t <= now) logUntil.delete(sid);
    for (const key of [...links.keys()]) if (!want.has(key)) linkOff(key);
    for (const [key, [kind, i]] of want) if (!links.has(key)) linkOn(key, kind, i);
  }

  // The machine's spoke: total CPU over the last two minutes as a ribbon, now at the CPU
  // card and the two minutes carried up into the hub, so its shape climbs a little every
  // line. One small canvas, redrawn per line like Network's. (A dash train running at the
  // load's speed was built and measured first: 1.4 points of WebContent at 300 ms for one
  // always-on animation; the load column that replaced it read as a static stub.)
  // The canvas starts 12 pt above the hub card's edge (top 552, not 564) so the ribbon's
  // oldest end runs on up into the ring: its rows are drawn 12 pt down, the oldest row carried
  // up the extra 12, and the ring's disc clipped out, so the spoke ends on the ring's curve.
  const mach = $("mach").getContext("2d"), MACH_UP = 12, MACH_CY = HUB.y - (564 - MACH_UP), MACH_CX = HUB.x - 744;
  function drawMachine(now) {
    const s = Kiln.series("cpu"), H = 216, rows = new Float32Array(H), cnt = new Uint16Array(H);
    for (let i = winStart(s, now); i < s.length; i++) { const y = Math.round((1 - (now - s[i].t) / SPAN) * (H - 1)); if (y >= 0 && y < H) { rows[y] += s[i].v; cnt[y]++; } }
    // fill the rows between samples from the newer sample, so a slow period draws no gaps;
    // above the oldest sample (a series younger than two minutes) there is nothing yet
    let last = -1, oldest = H;
    for (let y = 0; y < H; y++) if (cnt[y]) { oldest = y; break; }
    for (let y = H - 1; y >= 0; y--) { if (cnt[y]) { rows[y] /= cnt[y]; last = rows[y]; } else rows[y] = y > oldest && last >= 0 ? last : -1; }
    mach.setTransform(2, 0, 0, 2, 0, 0); mach.clearRect(0, 0, 24, H + MACH_UP);
    mach.save(); mach.beginPath(); mach.rect(0, 0, 24, H + MACH_UP); mach.arc(MACH_CX, MACH_CY, RIM_OUT, 0, 2 * Math.PI); mach.clip("evenodd");
    mach.translate(0, MACH_UP);
    mach.fillStyle = C.z2; mach.beginPath();
    let started = false;
    const wAt = (y) => 0.75 + 7.25 * Math.min(100, rows[y]) / 100;
    for (let y = 0; y < H; y++) { if (rows[y] < 0) continue; const w = wAt(y); if (!started) { mach.moveTo(12 - w, y ? y : -MACH_UP); started = true; } mach.lineTo(12 - w, y); }
    for (let y = H - 1; y >= 0; y--) { if (rows[y] < 0) continue; const w = wAt(y); mach.lineTo(12 + w, y); if (!y) mach.lineTo(12 + w, -MACH_UP); }
    if (started) { mach.closePath(); mach.fill(); }
    mach.restore();
  }

  // ---------- the weather window: looking south from campus, painted (sky.js) ----------
  // A continuous sky by the real sun's altitude with the sun's and moon's aureoles; the real
  // southern skyline from 3DEP (horizon.js), hazed with distance and its rim lit like the
  // ground; sun and moon at their real azimuth and altitude, the moon at its phase; cloud as
  // a layer seen in perspective whose cover is the real cloud share, lit by a march toward
  // the real light and drifting with the wind; rain, snow, fog and storm by their rates.
  // Painted into bitmaps when the key changes (at most about once a minute); only the cloud
  // and precipitation layers move, by compositor translate.
  // v4 drew cloud as rows of strokes (scan lines under overcast); v4.1 as four terraces over
  // eight flat sky bands, which review called "8-bit rendered" (2026-11-06). Rejected in
  // a comparison sheet: a flat fBm sheet (blobs, no depth) and a painterly
  // Kuwahara pass (nothing at card size, hard steps at 2x).
  const HZ = window.MM_HORIZON, WW = 262, WH = 96, HY = 83, HS = 7;
  const landY = (x) => { const d = HZ.deg, f = x / (WW - 1) * (d.length - 1), i = Math.min(d.length - 2, Math.floor(f)); return HY - (d[i] + (d[i + 1] - d[i]) * (f - i)) * HS; };
  const mix = (a, b, f) => { const A = hex(a), B = hex(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * clamp01(f)).toString(16).padStart(2, "0")).join(""); };
  // A canvas as a blob URL for a moving layer's background (the layer's box never changes);
  // the previous URL is released once the new one has been set. The new picture is loaded and
  // decoded off the page first (an <img> held until the swap), so the layer is never handed a
  // URL it has still to fetch and decode, which would paint it empty for a frame or more.
  const urls = {};
  function layerImage(id, canvas) {
    const el = $(id), job = (urls[id] = urls[id] || { n: 0 }), n = ++job.n;
    const swap = (url) => { const old = job.url; job.url = url; el.style.backgroundImage = url ? `url("${url}")` : "none"; if (old) setTimeout(() => URL.revokeObjectURL(old), 1000); };
    if (!canvas) { swap(null); return; }
    canvas.toBlob((png) => {
      canvas.width = canvas.height = 0;
      if (n !== job.n) return;
      if (!png) { swap(null); return; }
      const url = URL.createObjectURL(png), pre = new Image(); pre.src = url;
      const put = () => { if (n === job.n && pre.naturalWidth) swap(url); else URL.revokeObjectURL(url); };
      pre.decode().then(put, put);
    }, "image/png");
  }
  const skyAnims = [];
  let skyKey = "";
  function drawSky(w, now) {
    const k = sky(now), sunAlt = k.sun.alt / RAD, moonAlt = k.moon.alt / RAD;
    const cov = clamp01(w.cloud / 100), kind = w.kind;
    const covShown = kind === "clear" ? Math.min(cov, 0.1) : kind === "partly" ? Math.max(0.2, Math.min(cov, 0.7)) : Math.max(cov, 0.85);
    const heavy = kind === "rain" || kind === "storm" || kind === "drizzle" || kind === "snow" || kind === "fog" || (kind === "cloudy" && cov > 0.85);
    const windX = Math.sin((w.wind_dir || 0) * RAD) * (w.wind_kmh || 0);          // + = toward the right (west)
    const rate = kind === "snow" ? (w.snow_cm || 0.5) : (w.rain_mm || w.precip_mm || (kind === "drizzle" ? 0.2 : 1));
    const raining = kind === "rain" || kind === "drizzle" || kind === "storm" || (w.rain_mm > 0 && kind !== "snow"), snowy = w.snow_cm > 0 || kind === "snow";
    const key = [kind, Math.round(covShown * 20), Math.round(sunAlt), Math.round(moonAlt / 2), Math.round(k.moonLit * 30), Math.round(windX), Math.round(rate * 4), w.snow_cm > 0].join("|");
    if (key === skyKey) return; skyKey = key;
    for (const a of skyAnims.splice(0)) a.cancel();
    // --- the real positions, in window points (1.45 pt a degree both ways, east at the left)
    const px = (az) => (az / RAD - 90) / 180 * WW, py = (alt) => HY - alt * 1.45;
    const sun = { x: px(k.sun.az), y: py(sunAlt), alt: sunAlt };
    const moon = { x: px(k.moon.az), y: py(moonAlt), alt: moonAlt, lit: k.moonLit, waxing: k.waxing };
    // the light: the sun by day and in twilight (from below once it has set), the moon when
    // it is up over a broken sky, otherwise the town's glow from below (diffuse, no
    // direction: null); one direction for the
    // whole cloud tile, from the window's middle toward the light, so it stays right as the
    // tile drifts
    const moonLight = moonAlt > 0 && k.moonLit > 0.3 && covShown < 0.85;
    const toward = (x, y) => { const dx = x - WW / 2, dy = y - HY * 0.55, n = Math.hypot(dx, dy) || 1; return [dx / n, dy / n]; };
    const lg = light(k), rimC = mix(mix("#524b43", "#a35e3b", lg.sunUp), "#8a8782", lg.moonUp / 0.7);
    const kz = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const { cloud, precip } = MM_SKY.paint({
      W: WW, H: WH, HY, k: kz, landY, sun, moon, kind, cov: covShown, heavy, raining, snowy: snowy && (kind === "snow" || w.snow_cm > 0), rate, windX,
      rim: rimC, moonLight, light: sunAlt > -6 ? toward(sun.x, sun.y) : moonLight ? toward(moon.x, moon.y) : null,
    }, { sky: $("WXsky"), front: $("WXfr"), fx: $("WXfx") });
    // --- cloud drifts with the wind: a tile one window wide, repeated across a layer two
    // windows wide that slides one window per cycle
    const cl = $("WXcl");
    layerImage("WXcl", cloud);
    const v = windX * 0.1;   // pt/s: a 16 km/h wind crosses the window in under three minutes
    if (cloud && Math.abs(v) > 0.15 && !RM) skyAnims.push(keep(cl.animate(v < 0 ? [{ transform: "translateX(0)" }, { transform: `translateX(-${WW}px)` }] : [{ transform: `translateX(-${WW}px)` }, { transform: "translateX(0)" }], { duration: WW / Math.abs(v) * 1000, iterations: Infinity })));
    else cl.style.transform = "";
    // --- lightning: the bolt and the cloud it lights, three flashes in twenty seconds
    const fx = $("WXfx");
    if (kind === "storm" && !RM) skyAnims.push(keep(fx.animate([0, 0, 1, 0.15, 1, 0, 0, 0, 0.8, 0, 0].map((o, i) => ({ opacity: o, offset: [0, 0.3, 0.31, 0.33, 0.34, 0.37, 0.72, 0.73, 0.74, 0.77, 1][i] })), { duration: 20000, iterations: Infinity })));
    fx.style.opacity = kind === "storm" && RM ? "1" : "0";
    // --- precipitation: a tile two windows tall, falling one window per cycle
    const pr = $("WXpr");
    layerImage("WXpr", precip);
    pr.style.top = -WH + "px";
    if (precip && !RM) skyAnims.push(keep(pr.animate([{ transform: "translateY(0)" }, { transform: `translateY(${WH}px)` }], { duration: snowy ? 9000 : kind === "drizzle" ? 1400 : 700, iterations: Infinity })));
  }

  // ---------- charts ----------
  const ramp = (p, v, mx) => v <= 0 ? C[p + "0"] : v < mx * 0.08 ? C[p + "1"] : v < mx * 0.25 ? C[p + "2"] : v < mx * 0.55 ? C[p + "3"] : C[p + "4"];
  function drawHours(hm) {
    const g = $("HMc").getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 456, 224);
    const mx = Math.max(1, ...hm.out.flat());
    for (let r = 0; r < 7; r++) for (let h = 0; h < 24; h++) { g.fillStyle = ramp("t", hm.out[r][h], mx); g.fillRect(h * 19, r * 32, 17, 30); }
  }
  function drawGithub(gh) {
    const g = $("GHg").getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, 468, 63);
    if (!gh.days || !gh.days.length) return;
    const last = gh.days[gh.days.length - 1], wd = new Date(last[0] + "T12:00:00").getDay();
    const days = gh.days.slice(-(51 * 7 + wd + 1));
    const lvl = (n) => n === 0 ? C.g0 : n < 5 ? C.g1 : n < 13 ? C.g2 : n < 31 ? C.g3 : C.g4;
    days.forEach(([, n], i) => { g.fillStyle = lvl(n); g.fillRect(Math.floor(i / 7) * 9, (i % 7) * 9, 7, 7); });
  }
  const SPAN = 120;
  const winStart = (s, now) => { let i = s.length; while (i > 0 && now - s[i - 1].t <= SPAN) i--; return i; };
  function drawSeries(id, a, b, h, now) {
    const c = $(id), g = c.getContext("2d"), W = 240; g.setTransform(2, 0, 0, 2, 0, 0); g.clearRect(0, 0, W, h);
    const ia = winStart(a, now), ib = winStart(b, now);
    let mx = 1;
    for (let i = ia; i < a.length; i++) if (a[i].v > mx) mx = a[i].v;
    for (let i = ib; i < b.length; i++) if (b[i].v > mx) mx = b[i].v;
    const X = (p) => W - (now - p.t) / SPAN * W, Y = (v) => h - 1 - (v / mx) * (h - 3);
    if (a.length - ia > 1) {
      g.fillStyle = C.z4; g.beginPath(); g.moveTo(X(a[ia]), h);
      for (let i = ia; i < a.length; i++) g.lineTo(X(a[i]), Y(a[i].v));
      g.lineTo(X(a[a.length - 1]), h); g.closePath(); g.fill();
    }
    if (b.length - ib > 1) {
      g.strokeStyle = C.z1; g.lineWidth = 1.5; g.lineJoin = "round"; g.beginPath();
      g.moveTo(X(b[ib]), Y(b[ib].v));
      for (let i = ib + 1; i < b.length; i++) g.lineTo(X(b[i]), Y(b[i].v));
      g.stroke();
    }
    g.fillStyle = C.idle; g.fillRect(0, h - 0.5, W, 0.5);
    for (let k = 1; k < 4; k++) g.fillRect(W * k / 4 - 0.25, h - 3.5, 0.5, 3);
  }
  // The week's burn-down: axis once, points per limits block.
  function drawWeek(L, lim, now) {
    const svg = $("WKc"); svg.innerHTML = "";
    const add = (tag, attrs) => mk(tag, attrs, svg);
    const W = 146, top = 14, bot = 96, start = L.resets_at - 7 * 86400, end = L.resets_at;
    const X = (t) => (Math.max(start, Math.min(end, t)) - start) / (end - start) * (W - 1) + 0.5, Y = (p) => bot - (p / 100) * (bot - top);
    for (const p of [0, 50, 100]) add("rect", { x: 0, y: Y(p) - 0.25, width: W, height: 0.5, fill: C.idle });
    for (let d = 0; d <= 7; d++) {
      const x = Math.round(X(start + d * 86400)) + 0.5;
      add("rect", { x: x - 0.25, y: bot, width: 0.5, height: 4, fill: C.sec });
      if (d < 7) { const t = add("text", { x: x + (W - 1) / 14, y: 112, "text-anchor": "middle" }); t.textContent = dayName(start + d * 86400).slice(0, 2); }
    }
    add("path", { d: `M${X(start).toFixed(1)},${Y(0)}L${X(end).toFixed(1)},${Y(100)}`, fill: "none", stroke: C.idle, "stroke-width": 1, "stroke-dasharray": "2 3" });
    let tl = add("text", { x: 0, y: 7, "text-anchor": "start", "font-size": "10" }); tl.textContent = "% of the limit";
    tl = add("text", { x: W, y: 7, "text-anchor": "end", "font-size": "10" }); tl.textContent = "dotted: even";
    let pts = lim.week_points;
    if (!pts) { const h = lim.history || []; pts = h.filter((r) => r[0] >= start).map((r) => [r[0], r[2]]); const prev = h.filter((r) => r[0] < start).pop(); if (prev) pts.unshift([prev[0], prev[2], "prev"]); }
    const prev = pts.find((p) => p[2] === "prev"), cur = pts.filter((p) => p[2] !== "prev");
    if (prev) add("circle", { cx: X(start), cy: Y(prev[1]), r: 3, fill: C.bg, stroke: C.sec, "stroke-width": 1.5 });
    if (cur.length) {
      add("path", { d: cur.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join(""), fill: "none", stroke: C.m1, "stroke-width": 1.5, "stroke-linejoin": "round" });
      const l = cur[cur.length - 1];
      if (L.pace != null && L.projected != null) add("path", { d: `M${X(l[0]).toFixed(1)},${Y(l[1]).toFixed(1)}L${X(L.runout_at || end).toFixed(1)},${Y(L.runout_at ? 100 : L.projected).toFixed(1)}`, fill: "none", stroke: C.m1, "stroke-width": 1, "stroke-dasharray": "3 3" });
      add("circle", { cx: X(l[0]), cy: Y(l[1]), r: 2.5, fill: C.now });
    }
    add("rect", { x: Math.round(X(now)) - 0.25, y: top, width: 0.5, height: bot - top, fill: C.now });
  }

  // ---------- dev overrides: ?busy ?one ?n=K ?empty ?weather=kind ?day=0|1 ?sun=HH ----------
  const OV = { busy: q.has("busy") || q.has("one") || q.has("n"), n: q.has("one") ? 1 : q.has("n") ? +q.get("n") : null, empty: q.has("empty"), weather: q.get("weather"), day: q.get("day"), sun: q.get("sun") };
  function override(s) {
    const c = s.claude, t = s.t;
    if (OV.empty) { s.claude = Object.assign({}, c, { sessions: [], agents_running: [] }); s.weather = null; s.github = null; return; }
    if (OV.busy && c.sessions.length >= 2 && !c._busy) {
      const L = c.sessions.map((x) => Object.assign({}, x)), base = L[0].out_per_min.some((v) => v) ? L[0].out_per_min : L[1].out_per_min;
      const shift = (arr, k, f) => arr.map((_, i) => Math.round((arr[(i + k) % 60] || 0) * f));
      L[0].state = "working"; L[0].out_per_min = base; L[1].state = "background"; L[1].out_per_min = shift(base, 20, 0.6); L[1].out_15m = 9000;
      const mkS = (name, kind, state, mdl, pct, opm, extra) => Object.assign({ sid: "dev-" + name, name, kind, state, model: mdl, ctx_tokens: pct * 1e4, ctx_window: 1e6, ctx_pct: pct, out_per_min: opm, out_15m: opm.slice(-15).reduce((a, b) => a + b, 0), agents_running: 0, ask: null, since: t - 5400, last_activity: t - 30, up_s: 5400, cpu: 12, rss: 5e8 }, extra);
      L.push(mkS("docs-site-nav", "interactive", "waiting", "claude-fable-5-1", 61.2, shift(base, 44, 0.4), { ask: { t: t - 272, text: "permission: Bash" }, last_activity: t - 272 }));
      L.push(mkS("billing-rls-audit", "interactive", "working", "claude-opus-5-5", 42.3, shift(base, 31, 0.55)));
      L.push(mkS("release-notes-nov", "bg", "failed", "claude-sonnet-5-5", 8.4, shift(base, 50, 0.1).map((v, i) => i > 48 ? 0 : v), { since: t - 720, last_activity: t - 720 }));
      const ag = (id, s, type, started, idle, desc) => ({ id, sid: s.sid, session: s.name, type, desc: desc || "", started: t - started, age_s: started, idle_s: idle });
      const agents = [ag("a1", L[0], "designer", 1510, 4, "Flight Deck: layout + gauges"), ag("a2", L[0], "researcher", 420, 90, "Survey queue retry policies"), ag("a3", L[0], "browser", 1200, 10, "Drive the staging console"), ag("a4", L[0], "builder", 140, 1, "Dock contract in the runtime"),
        ag("a5", L[1], "tester", 360, 5, "Playwright suite on the docs site"), ag("a6", L[1], "general-purpose", 3300, 12, ""), ag("a7", L[3], "verifier", 600, 3, "RLS policies, pass B")];
      // the made-up events keep the time of the replay's first line, so they land once;
      // &ping=S lands one more S seconds into the replay (the Log's transient cord)
      const t0 = OV.t0 = OV.t0 || t, ping = +q.get("ping");
      const ev = (c.events || []).concat([
        { t: t0 - 1510, kind: "agent_start", sid: L[0].sid, name: L[0].name, detail: "designer: Flight Deck: layout + gauges" },
        { t: t0 - 900, kind: "agent_done", sid: L[0].sid, name: L[0].name, detail: "researcher" },
        { t: t0 - 272, kind: "ask", sid: L[2].sid, name: L[2].name, detail: "permission: Bash" },
        { t: t0 - 720, kind: "fail", sid: L[4].sid, name: L[4].name, detail: "" },
        { t: t0 - 1900, kind: "done", sid: L[3].sid, name: L[3].name, detail: "", n: 3 },
      ], ping && t >= t0 + ping ? [{ t: t0 + ping, kind: "done", sid: L[0].sid, name: L[0].name, detail: "" }] : []).sort((a, b) => a.t - b.t);
      // two of the made-up sessions' processes on the busiest list, as the feed reports them
      L[3].cpu = 31.4;
      s.sys = Object.assign({}, s.sys, { top_cpu: [["claude", L[3].cpu], ["claude", L[0].cpu || 0]].concat((s.sys.top_cpu || []).filter((r) => !/claude/i.test(r[0]))).sort((a, b) => b[1] - a[1]).slice(0, 4) });
      let S = L, A = agents;
      if (OV.n != null) { S = L.slice(0, OV.n); const keepSid = new Set(S.map((x) => x.sid)); A = agents.filter((a) => keepSid.has(a.sid)); }
      s.claude = Object.assign({}, c, { sessions: S, agents_running: A, events: ev, _busy: true });
    }
    // ?load=low|mid|high: calm, strained and over on the machine tiles (normal, warn, critical)
    const LD = { low: [[7, 5, 3, 2, 2, 1, 1, 0, 0, 0], 0.44, "normal"], mid: [[74, 66, 58, 52, 47, 40, 33, 26, 18, 12], 0.8, "warn"], high: [[100, 99, 97, 95, 92, 88, 81, 74, 63, 50], 0.95, "critical"] }[q.get("load")];
    if (LD) {
      const total = s.sys.mem.total, used = total * LD[1];
      s.sys = Object.assign({}, s.sys, { cores: LD[0], cpu: LD[0].reduce((a, b) => a + b, 0) / 10, mem: Object.assign({}, s.sys.mem, { used, pressure: LD[2], wired: total * 0.16, active: used * 0.45, compressed: used * 0.2, cached: total - used - total * 0.03, free: total * 0.03 }) });
    }
    if (s.weather && (OV.weather || OV.day != null)) {
      const w = Object.assign({}, s.weather);
      if (OV.weather) {
        w.kind = OV.weather; w.text = { partly: "partly cloudy", cloudy: "overcast" }[OV.weather] || OV.weather;
        w.cloud = { clear: 4, partly: 45, cloudy: 96, fog: 100, drizzle: 90, rain: 97, snow: 95, storm: 100 }[OV.weather] ?? w.cloud;
        w.rain_mm = OV.weather === "rain" || OV.weather === "storm" ? 2.4 : OV.weather === "drizzle" ? 0.3 : 0; w.precip_mm = w.rain_mm;
        w.snow_cm = OV.weather === "snow" ? 1.2 : 0;
      }
      if (OV.day != null) { const noon = (w.sunrise + w.sunset) / 2, mid = noon + 43200; w.is_day = OV.day === "1"; w._now = w.is_day ? noon - 7200 : mid - 3600; }
      s.weather = w;
    }
  }

  // ---------- numbers that tween (fast figures only) ----------
  const nums = {
    cpn: Kiln.num($("CPn"), { fmt: (v) => v.toFixed(1) + " %" }),
    tdo: Kiln.num($("TDo"), { fmt: F.tokens }), tdc: Kiln.num($("TDc"), { fmt: F.int }),
    bt: Kiln.num($("BTn"), { fmt: (v) => Math.round(v) + " %" }), dk: Kiln.num($("DKn"), { fmt: (v) => String(Math.round(v / 1e9)) }),
  };
  Kiln.track("rx", (s) => s.sys.net.rx_bps, SPAN); Kiln.track("tx", (s) => s.sys.net.tx_bps, SPAN);
  Kiln.track("rd", (s) => s.sys.disk.read_bps, SPAN); Kiln.track("wr", (s) => s.sys.disk.write_bps, SPAN);
  Kiln.track("cpu", (s) => s.sys.cpu, SPAN);
  const slotOf = new Map();   // sid -> slot 0..2, sticky while the session is open
  let lastWeatherAt = 0, wkResetAt = null, booted = false, skyMin = null, lastSky = null;
  const CORE_BARS = [...$("CPc").querySelectorAll("i")], BH_COLS = [...$("BHc").querySelectorAll("i")];
  const VERB = { PushEvent: "pushed", PullRequestEvent: "PR opened", IssuesEvent: "issue", WatchEvent: "starred", CreateEvent: "created", ForkEvent: "forked", IssueCommentEvent: "commented", ReleaseEvent: "released" };
  function evText(e) {
    const det = e.detail || "";
    if (e.kind === "done") return e.n > 1 ? `${e.n} turns finished` : "turn finished";
    if (e.kind === "fail") return "turn failed" + (det ? ", " + det : "");
    if (e.kind === "ask") return "asked: " + (det ? det.replace(/^perm(ission)?:?\s+/, "permission: ") : "needs an answer");
    if (e.kind === "remind") return det || "reminded";
    if (e.kind === "answered") { const m = /^after (\d+)s$/.exec(det); return m ? "answered after " + age(+m[1]) : "answered"; }
    if (e.kind === "agent_start" || e.kind === "agent_done") {
      const m = /^([^:]+):?\s*(.*)$/.exec(det), type = m && m[1] ? m[1].trim() : "agent";
      return `${type} ${e.kind === "agent_start" ? "out" : "back"}${m && m[2] ? ", " + m[2] : ""}`;
    }
    return e.kind;
  }
  const askT = (x) => (x.ask && (x.ask.t || x.ask.since || x.ask.started || x.ask.at)) || x.last_activity || x.since;
  const needLine = (x, now) => x.state === "failed" ? "failed " + ago(x.last_activity || x.since, now)
    : "waiting " + age(now - askT(x)) + (x.ask && x.ask.text ? " · " + x.ask.text : "");
  const rank = (x) => x.state === "waiting" || x.state === "failed" ? 0 : x.state === "working" || x.state === "background" ? 1 : 2;

  // ---------- per line ----------
  Kiln.on((s, prev) => {
    override(s);
    const now = s.t, sys = s.sys, c = s.claude, d = new Date(now * 1000);
    const lt = lightTime(now, s.weather), gm = Math.floor(lt / 60);
    if (gm !== groundMin) { groundMin = gm; drawGround(lt); }

    // clock and place
    const ck = F.clock(now).split(" ");
    slots($("CKt"), ck[0].padStart(5, " "), true);
    if (!$("CKt")._ap) { const ap = document.createElement("span"); ap.className = "ap"; ap.id = "CKap"; $("CKt").appendChild(ap); $("CKt")._ap = ap; }
    set("CKap", ck[1]); set("CKd", FMT.long.format(d)); set("CKp", s.weather ? s.weather.place : "");

    // sessions: three sticky slots; a newcomer takes the first free one; the rest overflow
    const all = c.sessions || [], events = c.events || [];
    const open = all.filter((x) => x.kind === "interactive"), bg = all.filter((x) => x.kind !== "interactive");
    const liveSid = new Set(all.map((x) => x.sid));
    for (const [sid] of slotOf) if (!liveSid.has(sid)) slotOf.delete(sid);
    for (const x of all.slice().sort((a, b) => rank(a) - rank(b) || (b.last_activity || 0) - (a.last_activity || 0))) {
      if (slotOf.has(x.sid)) continue;
      const used = new Set(slotOf.values()); for (let i = 0; i < 3; i++) if (!used.has(i)) { slotOf.set(x.sid, i); break; }
    }
    const bySlot = [null, null, null];
    for (const x of all) if (slotOf.has(x.sid)) bySlot[slotOf.get(x.sid)] = x;
    const over = all.filter((x) => !slotOf.has(x.sid));
    const agents = c.agents_running || [];
    const lastHere = []; { const seen = new Set(); for (let i = events.length - 1; i >= 0 && lastHere.length < 3; i--) { const e = events[i]; if (e.name && !liveSid.has(e.sid) && !seen.has(e.name)) { seen.add(e.name); lastHere.push([e.name, e.t]); } } }
    for (let i = 0; i < 3; i++) {
      const x = bySlot[i], el = leaves[i], L = "L" + i;
      cls(el, `card leaf s${i + 1} ` + (x ? x.state : "free"));
      if (!x) {
        set(L + "n", "No session");
        for (let j = 0; j < 3; j++) { const r = lastHere[j]; set(L + "l" + j, r ? r[0] : j === 0 ? "nobody in the last 40 events" : ""); set(L + "t" + j, r ? F.clock(r[1], { h24: true }) : ""); }
        continue;
      }
      const ag = agents.filter((a) => a.sid === x.sid);
      // the model alone fits its box; a background session says so on its state line
      set(L + "n", x.name); set(L + "m", model(x.model));
      set(L + "s", (x.kind === "bg" && x.state !== "background" ? "bg · " : "") + (x.state === "working" ? "working · " + age(now - x.since) : x.state === "background" ? "background " + age(now - x.since)
        : x.state === "waiting" ? "waiting " + age(now - askT(x)) : x.state === "failed" ? "failed " + ago(x.last_activity || x.since, now)
        : "idle since " + F.clock(x.last_activity || x.since)));
      set(L + "u", "up " + (x.up_s >= 86400 ? age(x.up_s).replace(/ \d+ m$/, "") : age(x.up_s)));   // "1 d 6 h": two units fit the box
      const cp = x.ctx_pct == null ? null : x.ctx_pct;
      set(L + "c", x.ctx_tokens == null ? "context not reported" : `context ${F.tokens(x.ctx_tokens)} of ${x.ctx_window >= 1e6 ? x.ctx_window / 1e6 + "M" : F.tokens(x.ctx_window)}`);
      set(L + "p", cp == null ? "–" : Math.round(cp) + " %"); tf(L + "b", `scaleX(${cp == null ? 0 : (cp / 100).toFixed(3)})`);
      set(L + "o", x.state === "waiting" ? (x.ask && x.ask.text ? x.ask.text : "waiting for an answer") : x.out_15m > 0 ? `${F.tokens(x.out_15m)} in 15 min · ${F.tokens(x.out_15m / 15)}/min` : "quiet for 15 min");
      const opm = x.out_per_min, pk = Math.max(...opm), avg = opm.reduce((a, b) => a + b, 0) / 60;
      set(L + "h", pk ? `past hour: peak ${F.tokens(pk)}/min, avg ${F.tokens(avg)}` : "past hour: quiet");
      set(L + "a", ag.length ? `${ag.length} ${ag.length === 1 ? "agent" : "agents"} out` : "no agents out");
      set(L + "x", x.cpu != null ? `${x.cpu.toFixed(1)} % · ${F.bytes(x.rss || 0)}` : "");
      set(L + "f", i === 2 && over.length ? `+${over.length} more: ${over.map((o) => o.name).join(", ")}` : "");
    }
    drawRibbons(bySlot, events, now); drawToday(all);
    const strandOrder = drawStrands(agents, slotOf, bySlot);
    tokensLanding(bySlot, now);
    drawLinks(bySlot, events, sys, now);

    // hub: the open count and how many of those work; the rest lives elsewhere
    slots($("HBn"), String(open.length).padStart(2, " "));
    const nWork = open.filter((x) => x.state === "working" || x.state === "background").length, nNeed = open.filter((x) => x.state === "waiting" || x.state === "failed").length;
    set("HBs", open.length ? [nWork ? nWork + " working" : "", nNeed ? nNeed + " need you" : "", open.length - nWork - nNeed ? open.length - nWork - nNeed + " idle" : ""].filter(Boolean).join(" · ") : "no session open");
    set("HBbg", bg.length ? `+${bg.length} in the background` : "");
    sys.cores.forEach((v, i) => {
      const a = rimArcs[i], da = `${(a.len * v / 100).toFixed(2)} ${a.len.toFixed(2)}`, ink = coreInk(v);
      if (a.e.getAttribute("stroke-dasharray") !== da) a.e.setAttribute("stroke-dasharray", da);
      if (a.ink !== ink) { a.ink = ink; a.e.setAttribute("stroke", ink); }
    });
    drawMachine(now);

    // the crown: agents out, in landing order, each with its session's ink
    const byId = new Map(agents.map((a) => [a.id, a])), listed = strandOrder.map((id) => byId.get(id)).filter(Boolean).concat(agents.filter((a) => !strands.has(a.id)));
    const A = s.analytics && s.analytics.ready ? s.analytics : null;
    const spawned = A ? Object.values(A.spawns.today || {}).reduce((a, b) => a + b, 0) : null;
    set("CRd", spawned != null ? `${spawned} spawned today` : "");
    const lastBack = events.filter((e) => e.kind === "agent_done").pop();
    for (let i = 0; i < 4; i++) {
      const a = listed[i], more = listed.length > 4 && i === 3, r = $("CRr" + i);
      const slot = a ? slotOf.get(a.sid) : null;
      kvar(r, a && !more ? (slot != null ? KINK[slot] : C.k0) : "transparent");
      if (more) { set("CRk" + i, `+${listed.length - 3} more out`); set("CRv" + i, ""); continue; }
      if (a) { set("CRk" + i, a.type + (a.desc ? ", " + a.desc : "")); set("CRv" + i, coarse(now - a.started)); continue; }
      if (i === 0 && !listed.length) { set("CRk0", "none out"); set("CRv0", ""); continue; }
      if (i === (listed.length ? listed.length : 1) && lastBack) { set("CRk" + i, "last back: " + evText(lastBack).replace(/ back,?/, ",")); set("CRv" + i, coarse(now - lastBack.t)); continue; }
      set("CRk" + i, ""); set("CRv" + i, "");
    }

    // the week
    const L = c.limits && c.limits.seven_day;
    if (L) {
      set("WKp", Math.round(L.pct) + " %");
      if (L.resets_at !== wkResetAt) { wkResetAt = L.resets_at; set("WKr", "resets " + dayName(L.resets_at) + " " + F.clock(L.resets_at)); }
      set("WKi", age(L.resets_at - now));
      set("WKb", L.burn_per_h == null ? "–" : L.burn_per_h.toFixed(1) + " %/h");
      const fc = L.resets_at - 7 * 86400 + 12 * 3600;
      // "Thu 8 pm": the hour alone when the minutes are :00, so the figure fits its box
      const when = (t) => dayName(t) + " " + F.clock(t).replace(/:00(?= |$)/, "");
      set("WKf", L.pace == null ? "from " + when(fc) : L.runout_at ? "out " + when(L.runout_at) : `ends at ${Math.round(L.projected)} %`);
      const f5 = c.limits.five_hour, has5 = !!(f5 && !f5.stale && f5.pct != null);
      show("WK5r", has5); if (has5) set("WK5", Math.round(f5.pct) + " % used");
      if (c.limits !== (prev && prev.claude.limits) || !$("WKc").childNodes.length) drawWeek(L, c.limits, now);
    }

    // GitHub: the year as a grid, figures, recent activity as typed verbs (never a repo)
    if (!prev || s.github !== prev.github) {
      const g = s.github;
      if (g) {
        set("GHt", `GitHub, ${g.login}`); set("GHn", `${F.int(g.total_year)} in a year`);
        drawGithub(g);
        set("GH1", String(g.today)); set("GH2", String(g.week)); set("GH3", g.streak + (g.streak === 1 ? " day" : " days"));
        set("GH4", g.commits_year == null ? "–" : F.int(g.commits_year)); set("GH5", g.prs_year == null ? "–" : F.int(g.prs_year)); set("GH6", g.issues_year == null ? "–" : F.int(g.issues_year));
        const seen = new Set(), rec = [];
        for (const e of g.recent || []) { const v = VERB[e.type] || e.type.replace(/Event$/, "").toLowerCase(); if (!seen.has(v)) { seen.add(v); rec.push([v, e.at]); } if (rec.length === 2) break; }
        $("GH")._rec = rec;
      } else {
        set("GHt", "GitHub"); set("GHn", "offline"); $("GHg").getContext("2d").clearRect(0, 0, 468, 63);
        for (const id of ["GH1", "GH2", "GH3", "GH4", "GH5", "GH6"]) set(id, "–");
        $("GH")._rec = [];
      }
    }
    const rec = $("GH")._rec || [];
    set("GHk", rec.length ? rec.map(([v, at]) => `${v} ${coarse(now - at)} ago`).join(" · ") : "no recent activity");

    // needs you: the alert corner
    const needs = all.filter((x) => x.state === "waiting" || x.state === "failed");
    const nw = needs.filter((x) => x.state === "waiting").length, nf = needs.length - nw;
    $("NY").classList.toggle("alert", needs.length > 0);
    set("NYh", needs.length ? [nw ? `${nw} waiting` : "", nf ? `${nf} failed` : ""].filter(Boolean).join(", ") : "nothing waiting");
    const aw = A && A.ask_wait, lines = [];
    if (needs[0]) { lines.push([needs[0].name, "", "nm"]); lines.push([needLine(needs[0], now), "", ""]); }
    if (needs[1]) lines.push([`${needs[1].state === "failed" ? "✕" : "●"} ${needs[1].name}, ${needLine(needs[1], now)}`, "", ""]);
    if (aw && aw.count) { lines.push([`median wait ${age(aw.median_s)}`, `${aw.count} asks, 14 d`, "sec"]); lines.push([`9 of 10 under ${coarse(aw.p90_s)}`, `longest ${coarse(aw.max_s)}`, "sec"]); }
    else lines.push(["no asks in 14 days", "", "sec"]);
    if (A) lines.push([`failed turns today`, `${A.fails.today} · ${A.fails.d14} in 14 d`, "sec"]);
    for (let i = 0; i < 3; i++) {
      const [k, v, cl] = lines[i] || ["", "", ""], ke = $("NYk" + (i + 1));
      set("NYk" + (i + 1), k); set("NYv" + (i + 1), v);
      ke.classList.toggle("sec", cl === "sec"); ke.classList.toggle("nm", cl === "nm");
    }
    if (needs.length > 2) set("NYs", `+${needs.length - 2} more need you`);
    else { const ans = events.filter((e) => e.kind === "answered").pop(); set("NYs", ans ? `last answered ${F.clock(ans.t)}` : "no ask answered in the last 40 events"); }
    set("NYr", "");

    // today, and the fortnight: only when the analytics block changes
    const Tk = c.tokens;
    if (Tk) { nums.tdo.set(Tk.today.out); nums.tdc.set(Tk.today.calls); }
    set("TDd", FMT.short.format(d));
    if (A && s.analytics !== (prev && prev.analytics)) {
      const ds = A.days.slice(-14), td = ds[ds.length - 1] || {};
      set("TDr", `${F.tokens(Tk ? Tk.today.cache_read : td.cache_read)} · ${A.cache_hit_pct.today.toFixed(1)} % hit`);
      set("TDw", `${F.tokens(Tk ? Tk.today.cache_write : td.cache_write)} · ${F.tokens(Tk ? Tk.today.input : td.input)}`);
      set("TDp", `${F.int(A.prompts.today)} · ${F.int(A.fails.today)}`);
      // today's models, each with its ink (the same as the fortnight's columns)
      const bm = Object.entries(td.by_model || {}).sort((a, b) => b[1] - a[1]);
      for (let i = 0; i < 2; i++) {
        const r = bm[i], j = r ? MODEL_ORDER.indexOf(r[0]) : -1, key = r ? r[0] + r[1] : "";
        const e = $("TDmk" + i); if (e._k !== key) { e._k = key; e.innerHTML = r ? `<em class="sw" style="background:var(--m${j < 0 ? 3 : j + 1})"></em>${esc(model(r[0]))}` : i === 0 ? '<span class="sec">no model yet today</span>' : ""; }
        set("TDmv" + i, r ? F.tokens(r[1]) : "");
      }
      // by hour, each column in the tokens ramp; the hour under way outlined in "now"
      const hrs = td.hours || [], hmx = Math.max(1, ...hrs), cur = d.getHours();
      BH_COLS.forEach((e, i) => { e.classList.toggle("now", i === cur); const b = e.firstChild, col = ramp("t", hrs[i] || 0, hmx); if (b._c !== col) { b._c = col; b.style.background = col; } b.style.transform = `scaleY(${((hrs[i] || 0) / hmx).toFixed(3)})`; });
      const pk = hrs.indexOf(Math.max(...hrs));
      set("BHn", hrs.some((v) => v > 0) ? `peak ${F.tokens(hrs[pk])} at ${F.clock(pk * 3600 + new Date(td.date + "T00:00:00").getTime() / 1000)}` : "nothing yet today");
      const mx = Math.max(1, ...ds.map((x) => x.out));
      $("D14s").querySelectorAll("i").forEach((col, i) => {
        const day = ds[i] || { by_model: {} }; let off = 0;
        MODEL_ORDER.forEach((m, j) => { const f = (day.by_model[m] || 0) / mx; col.children[j].style.transform = `translateY(${(-off * 112).toFixed(2)}px) scaleY(${f.toFixed(4)})`; off += f; });
      });
      set("D14n", F.tokens(ds.reduce((a, x) => a + x.out, 0)) + " tokens out");
      set("D14a", new Date(ds[0].date + "T12:00:00").toLocaleDateString("en-US", { day: "numeric", month: "short" }));
      const used = MODEL_ORDER.filter((m) => ds.some((x) => x.by_model[m])), lk = used.join();
      if ($("D14l")._k !== lk) { $("D14l")._k = lk; $("D14l").innerHTML = used.map((m, i) => `<span style="left:${i * 62}px"><em class="sw" style="background:var(--m${MODEL_ORDER.indexOf(m) + 1})"></em>${esc(model(m).replace(/ .*$/, ""))}</span>`).join(""); }
      drawHours(A.hour_matrix);
      const flat = A.hour_matrix.out, best = flat.reduce((b, r, ri) => { r.forEach((v, h) => { if (v > b.v) b = { v, ri, h }; }); return b; }, { v: 0, ri: 0, h: 0 });
      set("HMn", best.v ? `busiest ${A.hour_matrix.rows[best.ri]} ${F.clock(best.h * 3600 + new Date(td.date + "T00:00:00").getTime() / 1000)}` : "");
      const au = Object.entries(A.agent_tokens.today || {}).sort((a, b) => b[1].out - a[1].out).slice(0, 7), amx = Math.max(1, ...au.map((x) => x[1].out));
      for (let i = 0; i < 7; i++) {
        const r = au[i]; set("AUk" + i, r ? (r[0] === "main" ? "main thread" : r[0]) : ""); set("AUv" + i, r ? F.tokens(r[1].out) : "");
        $("AUb" + i).classList.toggle("main", !!r && r[0] === "main"); $("AUb" + i).firstChild.style.transform = `scaleX(${r ? (r[1].out / amx).toFixed(3) : 0})`;
      }
      set("AUn", au.length ? `${au.length} authors, tokens out` : "nobody yet");
    }

    // log: the last seven events, newest first; every row from an open session carries its
    // ink (a slot's, or --k0 past the three slots); a closed session's rows only its name
    const ev = events.slice(-7).reverse();
    for (let i = 0; i < 7; i++) {
      const e = ev[i], slot = e ? slotOf.get(e.sid) : null, named = e && (slot == null ? true : all.length > 1 && (i === 0 || ev[i - 1].sid !== e.sid));
      kvar($("LGr" + i), slot != null ? KINK[slot] : e && liveSid.has(e.sid) ? C.k0 : "transparent");
      set("LGt" + i, e ? F.clock(e.t, { h24: true }) : ""); set("LGx" + i, e ? (named && slot == null ? e.name + " · " : "") + evText(e) : (i === 0 ? "nothing yet" : ""));
    }
    set("LGn", events.length ? `${events.length} events kept` : "");

    // weather, the real one, in the user's unit
    const w = s.weather;
    if (w) {
      lastWeatherAt = now;
      show("WXwin", true); show("WXo", false);
      const wm = Math.floor((w._now || now) / 60);
      if (w !== lastSky || wm !== skyMin) { lastSky = w; skyMin = wm; drawSky(w, lightTime(now, w)); }
      set("WXt", `${w.text.charAt(0).toUpperCase() + w.text.slice(1)}, ${w.is_day ? "day" : "night"}`); set("WXd", F.temp(w.temp_c));
      set("WXf", `${F.temp(w.feels_c)} · ${w.humidity} %`);
      const mph = Kiln.tempUnit === "F";
      const wind = F.wind ? F.wind(w.wind_kmh) : `${Math.round(mph ? w.wind_kmh * 0.621371 : w.wind_kmh)} ${mph ? "mph" : "km/h"}`;
      set("WXw", `${wind} from ${COMPASS[Math.round(w.wind_dir / 22.5) % 16]}`);
      set("WXu", `${F.clock(w.sunrise)} – ${F.clock(w.sunset)}`);
    } else {
      show("WXwin", false); show("WXo", true);
      set("WXo", lastWeatherAt ? `weather offline since ${F.clock(lastWeatherAt)}` : "weather offline");
      set("WXt", "no reading"); set("WXd", "–"); set("WXf", "–"); set("WXw", "–"); set("WXu", "–");
    }

    // the root: the machine
    const rxs = Kiln.series("rx"), tracked = rxs.length > 1 ? rxs[rxs.length - 1].t - rxs[0].t : 0;
    const span = Math.max(tracked, s.hist && s.hist.span_s != null ? s.hist.span_s : 0);
    set("NTt", span >= SPAN - 5 ? "Network, 2 min" : `Network, ${coarse(span)}`);
    set("NTn", `in ${F.rate(sys.net.rx_bps)} · out ${F.rate(sys.net.tx_bps)}`);
    drawSeries("NTc", rxs, Kiln.series("tx"), 56, now);
    set("NTd", `read ${F.rate(sys.disk.read_bps)} · write ${F.rate(sys.disk.write_bps)}`);
    drawSeries("NTk", Kiln.series("rd"), Kiln.series("wr"), 44, now);
    const m = sys.mem;
    set("MEt", `Memory, ${GB(m.used)} of ${Math.round(m.total / 1073741824)} GB`); set("MEp", `pressure ${m.pressure}`);
    let off = 0;
    for (const [id, v] of [["ME1", m.wired], ["ME2", m.active], ["ME3", m.compressed], ["ME4", m.cached]]) { const f = v / m.total; tf(id, `translateX(${(off * 240).toFixed(2)}px) scaleX(${f.toFixed(4)})`); off += f; }
    set("MEa", GB(m.wired)); set("MEb", GB(m.active)); set("MEc", GB(m.compressed)); set("MEd", GB(m.cached));
    set("MEe", GB(m.free)); set("MEf", GB(sys.swap)); set("MEg", GB(m.used)); set("MEh", Math.round(m.total / 1073741824) + " GB");
    nums.cpn.set(sys.cpu);
    CORE_BARS.forEach((e, i) => {
      const b = e.firstChild, v = `scaleY(${(sys.cores[i] / 100).toFixed(3)})`, ink = coreInk(sys.cores[i]);
      if (b.style.transform !== v) b.style.transform = v;
      if (b._c !== ink) { b._c = ink; b.style.background = ink; }
    });
    const mInk = memInk(m);
    if ($("ME")._ink !== mInk) { $("ME")._ink = mInk; memSteps(mInk).forEach((c, i) => $("ME").style.setProperty("--mz" + (i + 1), c)); }
    set("CPl", sys.load.map((v) => v.toFixed(2)).join(" · "));
    set("CPg", `${Math.round(sys.gpu || 0)} % · ${sys.gpu_detail ? (sys.gpu_detail.vram_used / 1073741824).toFixed(1) + " GB VRAM" : ""}`);
    set("CPu", `${sys.user.toFixed(1)} % · ${sys.sys.toFixed(1)} %`);
    const tc = sys.top_cpu || [], tm = sys.top_mem || [], cmx = Math.max(100, ...tc.map((x) => x[1]));
    for (let i = 0; i < 4; i++) { const r = tc[i]; set("BZn" + i, r ? r[0] : ""); set("BZv" + i, r ? Math.round(r[1]) + " %" : ""); $("BZb" + i).firstChild.style.transform = `scaleX(${r ? (r[1] / cmx).toFixed(3) : 0})`; }
    for (let i = 0; i < 2; i++) { const r = tm[i]; set("BZm" + i, r ? r[0] : ""); set("BZw" + i, r ? F.bytes(r[1]) : ""); }
    const b = sys.batt;
    nums.bt.set(b.pct); tf("BTg", `scaleY(${(b.pct / 100).toFixed(3)})`);
    set("BTs", b.charging ? "charging" : b.ac ? "on power" : b.mins_left ? age(b.mins_left * 60).replace(/ m$/, "") : "battery");
    nums.dk.set(sys.disk.free); tf("DKg", `scaleY(${(sys.disk.free / sys.disk.total).toFixed(3)})`);
    if (!booted) { booted = true; requestAnimationFrame(() => document.documentElement.classList.add("mm-live")); }
  });

  // the period readout and its beat (rule 6), in the clock card
  const per = $("LDn"), dot = $("LDd");
  per.textContent = String(Kiln.period);
  Kiln.onPeriod((ms) => { per.textContent = String(ms); $("CK").classList.add("hi"); setTimeout(() => $("CK").classList.remove("hi"), 1500); });
  Kiln.onBeat(() => { dot.style.opacity = 1; setTimeout(() => { dot.style.opacity = 0.5; }, 300); });
  // One look: no appearance code. The unit is honoured through Kiln.fmt.temp every line.
})();
