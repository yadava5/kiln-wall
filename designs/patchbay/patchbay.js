// Patchbay, sixth version. Read left to right, fast to slow: the rail (now), what you owe
// and what is left of the week, the three session slots, the cords, what they wrote this
// hour, who they sent out, what happened, today, the fortnight, what shipped. Each figure
// is printed in one place only (v6): a cord joins a session to its agents and its events,
// it does not join two copies of the same line. Every box on
// the page is cut once at load and never moves or resizes: a patch panel does not grow a
// jack when something is plugged in. What changes is what is plugged in (which session sits
// in which slot, which jacks are lit) and the cords. A slot with nothing in it is drawn as
// an unpatched jack; sessions beyond the three slots go on the designation strip. The live
// jackfield is smoked-acrylic plates over the 1898 jack patent, each an SVG outline with
// half-round bushings on the channel edge, one per jack; the record and the machine are
// opaque cards. Fixed row geometry throughout, so nothing in the update path reads layout
// and no figure can push a neighbour.
(function () {
  "use strict";
  const F = Kiln.fmt;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const q = new URLSearchParams(location.search);
  const MODEL = { "claude-opus-5-5": "Opus 5.5", "claude-fable-5-1": "Fable 5.1", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5" };
  const model = (id) => MODEL[id] || (id || "").replace(/^claude-/, "");
  // the models print in metallic inks: Opus white, Fable gold (what the work costs), the rest grey
  const modelInk = (id) => /opus/.test(id) ? "var(--ink)" : /fable/.test(id) ? "var(--gold)" : "var(--idle)";
  const short = (s) => F.span(s).replace(/ \d+ s$/, "") || "0 m";
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  // per-line arrays (sessions[].out_per_min, ...) are new objects on every line: compare them
  // by content. Only the sticky blocks keep their identity (README 6b).
  const sameNums = (a, b) => { if (a === b) return true; if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const hourName = (i) => i === 0 ? "midnight" : i === 12 ? "noon" : i < 12 ? i + " am" : (i - 12) + " pm";

  // ---------- the grid (pt), cut once ----------
  // C1 cards 78-330; the session slots 342-642 with the designation strip under them; the
  // channel 642-864 (under the notch); the jackfield plates from 864: This hour (the hero,
  // full width, up to the top margin since v6 dropped the counts rail above it), Agents
  // (split: out now | roster), then the Log beside Today's faceplate; the record along the
  // foot. Reasoning and rejected options: the design notes (v6).
  const C1 = { x: 78, w: 252 }, JX0 = 642, JX1 = 864;
  const NSLOT = 3, SLOT = { x: 342, w: 300, h: 230 }, SLOT_Y = [54, 296, 538];
  const STRIP = { x: 342, y: 780, w: 300, h: 28 };
  const HERO = { x: 864, y: 12, w: 636, h: 288 }, AGT = { x: 864, y: 312, w: 636, h: 184 };
  const LOGB = { x: 864, y: 508, w: 312, h: 300 }, LOG_ROWS = 13, AG_ROWS = 6;
  const B = {
    allow: { ...C1, y: 54, h: 146, t: "Needs you" },
    week: { ...C1, y: 212, h: 244, t: "The week" },
    mac: { ...C1, y: 468, h: 340, t: "This Mac" },
    weather: { ...C1, y: 820, h: 150, t: "Weather" },
    today: { x: 1188, y: 508, w: 312, h: 300, t: "Today" },
    fort: { x: 342, y: 820, w: 300, h: 150, t: "The fortnight" },
    hours: { x: 654, y: 820, w: 522, h: 150, t: "Hours of the week" },
    github: { x: 1188, y: 820, w: 312, h: 150, t: "GitHub" },
  };
  // the jacks, in each plate's own coordinates: a session's header (log mult), output
  // (the chart's middle) and its agents row (a mult too: one cord to each of its agents'
  // rows); This hour's three slot jacks; one per Agents row and one per Log row
  const S_JACKS = [16, 142, 214], H_JACKS = [76, 150, 224];
  const A_JACKS = Array.from({ length: AG_ROWS }, (_, k) => 48 + 20 * k), L_JACKS = Array.from({ length: LOG_ROWS }, (_, k) => 48 + 20 * k);
  const SLOT_INK = ["var(--p1)", "var(--p2)", "var(--p3)"];

  const cards = $("cards"), el = {};
  function card(k, b) {
    const d = document.createElement("div");
    d.className = "card"; d.id = "c-" + k;
    d.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
    d.innerHTML = `<div class="hd"><span class="t" id="t-${k}">${b.t || ""}</span><span class="m" id="m-${k}"></span></div><div class="bd" id="bd-${k}"></div>`;
    cards.appendChild(d); el[k] = d; return d;
  }
  for (const k in B) card(k, B[k]);

  // ---------- plates: the outline is one SVG path ----------
  // Chamfered outer corners (c = [tl, tr, br, bl]); half-round bushings on the channel side
  // (side "r" or "l"), each centred on a jack; an optional socket hole (evenodd). Integer
  // coordinates and a 1-pt edge, so every corner is crisp at 2x.
  const CHAM = 12, BUSH = 8, NS = "http://www.w3.org/2000/svg";
  function outline(x0, y0, x1, y1, c, side, ys, r) {
    const [tl, tr, br, bl] = c;
    let d = `M${x0 + tl},${y0}H${x1 - tr}L${x1},${y0 + tr}`;
    if (side === "r") for (const y of ys) d += `V${y - r}A${r},${r} 0 0 1 ${x1},${y + r}`;
    d += `V${y1 - br}L${x1 - br},${y1}H${x0 + bl}L${x0},${y1 - bl}`;
    if (side === "l") for (const y of ys.slice().reverse()) d += `V${y + r}A${r},${r} 0 0 1 ${x0},${y - r}`;
    return d + `V${y0 + tl}Z`;
  }
  const circ = (x, y, r) => `M${x + r},${y}A${r},${r} 0 1 0 ${x - r},${y}A${r},${r} 0 1 0 ${x + r},${y}Z`;
  // an unpatched slot's socket: a hole through the acrylic held by a hex panel nut, as the
  // patent's front view draws the jack
  const HOLE = { x: 72, y: 130, r: 30 };
  const hex = (x, y, r) => "M" + Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 6 + k * Math.PI / 3; return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`; }).join("L") + "Z";
  function plateSvg(b, o) {
    const w = b.w, h = b.h, pad = 12, c = o.c || [0, 0, 0, 0];
    const wc = c.map((v) => v ? 5 : 0), jx = o.side === "r" ? w : 0;
    return `<svg class="plate" width="${w + 2 * pad}" height="${h}" viewBox="${-pad} 0 ${w + 2 * pad} ${h}" style="left:${-pad}px">` +
      `<path class="pf" fill-rule="evenodd"/><path class="pw" fill-rule="evenodd"/><path class="pe"/>` +
      `<path class="pt" d="M${c[0]},0.5H${w - c[1]}"/>` +
      // each jack sits in a bushing: a half-round of metal (the jackfield's grey) proud of
      // the edge, under its ring
      (o.ys || []).map((y) => `<path class="bz" d="M${jx},${y - BUSH}A${BUSH},${BUSH} 0 0 ${o.side === "r" ? 1 : 0} ${jx},${y + BUSH}Z"/><circle class="jk" cx="${jx}" cy="${y}" r="5"/>`).join("") + (o.extra || "") + `</svg>`;
  }
  // set (or re-cut) a plate's outline: the box stays, the path's d changes
  function cut(p, b, o, hole) {
    const w = b.w, h = b.h, c = o.c || [0, 0, 0, 0], wc = c.map((v) => v ? 5 : 0);
    const hd = hole ? " " + circ(HOLE.x, HOLE.y, HOLE.r) : "";
    const d = outline(0, 0, w, h, c, o.side, o.ys || [], BUSH) + hd;
    const svgEl = p.firstElementChild, [pf, pw, pe] = svgEl.querySelectorAll("path");
    pf.setAttribute("d", d); pe.setAttribute("d", d);
    pw.setAttribute("d", (o.wells || [[6, 36, w - 6, h - 6]]).map(([a, bb, cc, dd]) => outline(a, bb, cc, dd, wc, null, [], 0)).join(" ") + hd);
  }
  function plate(id, b, o, inner) {
    const d = document.createElement("div");
    d.className = "plt " + (o.cls || ""); d.id = id;
    d.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
    d.innerHTML = plateSvg(b, o) + inner;
    cards.appendChild(d); cut(d, b, o, false); return d;
  }

  const slot = (id, w) => `<span class="slot" id="${id}" style="width:${w}px"></span>`;
  const row = (k, id, nw) => `<div class="r"${nw ? ` style="--nw:${nw}px"` : ""}><span class="k">${k}</span><span class="n" id="${id}"></span></div>`;
  function set(id, s) { const e = $(id); if (e && e.textContent !== s) e.textContent = s; }
  function html(id, s) { const e = $(id); if (e && e.innerHTML !== s) e.innerHTML = s; }
  function svg(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  const glyph = (cls, ch) => `<span class="g ${cls}">${ch}</span>`;

  // ---------- the rail: printed on the paper ----------
  // Clock, date, place. The counts rail that stood over the jackfield (open, background,
  // agents out, waiting) went in v6: each count already has its own home on the page.
  const rail = (id, x, w, inner) => { const d = document.createElement("div"); d.className = "rail"; d.id = id; d.style.cssText = `left:${x}px;top:12px;width:${w}px`; d.innerHTML = inner; cards.appendChild(d); return d; };
  rail("railL", 78, 564, `<span class="clk" id="rClock"></span><span class="dt" id="rDate" style="width:240px"></span><span class="sec fill" id="rPlace"></span>`);

  // ---------- the Dock strips: four 48-pt modules placed by Kiln.dock ----------
  // Above the Dock, stacked down from the top corner: live dot + period, battery. Below
  // it, stacked up from the bottom corner: net, GPU. Each list is in rank order; when the
  // Dock grows, the lowest-ranked module that no longer fits is dropped whole, and it
  // returns when the Dock shrinks. Nothing ever sits in the Dock's span. (The asks and sky
  // tiles went in v6: Needs you and the Weather card print both.)
  const tiny = (id, h, inner) => { const d = document.createElement("div"); d.className = "tiny"; d.id = id; d.style.cssText = `top:12px;height:${h}px`; d.innerHTML = inner; cards.appendChild(d); return d; };
  const ring = (id) => `<div class="ring"><svg viewBox="0 0 34 34"><circle class="tr" cx="17" cy="17" r="14"/><circle class="fg" id="${id}" cx="17" cy="17" r="14" stroke-dasharray="88" stroke-dashoffset="88"/></svg><div class="ct" id="${id}T"></div></div>`;
  tiny("tLive", 42, `<span id="dot"></span><b><span id="per"></span> ms</b>`);
  tiny("tBatt", 56, `${ring("btR")}<span id="btL"></span>`);
  tiny("tNet", 76, `<div class="twin" style="margin-top:1px"><span>down</span><span>up</span></div><div class="meters"><i><b id="rxM"></b></i><i class="tx"><b id="txM"></b></i></div><div class="twin v"><span id="rxL"></span><span id="txL"></span></div><span>bytes/s</span>`);
  tiny("tGpu", 56, `${ring("gpuR")}gpu`);
  const ABOVE = [["tLive", 42], ["tBatt", 56]], BELOW = [["tNet", 76], ["tGpu", 56]];
  const DOCK0 = { side: "left", y0: 225, y1: 757, x0: 0, x1: 66, thickness: 66, autohide: true, exact: false };  // until the host says
  function layoutDock(d) {
    d = d || DOCK0;
    const left = d.side === "left";
    let y = 12, top = left ? d.y0 - 12 : 970;
    for (const [id, h] of ABOVE) { const ok = y + h <= top; $(id).classList.toggle("off", !ok); if (ok) { $(id).style.top = y + "px"; y += h + 12; } }
    let b = d.side === "bottom" ? Math.min(970, d.y0 - 12) : 970;
    const bot = left ? d.y1 + 12 : y;
    for (const [id, h] of BELOW) { const ok = b - h >= bot; $(id).classList.toggle("off", !ok); if (ok) { b -= h; $(id).style.top = b + "px"; b -= 12; } }
  }
  Kiln.onDock(layoutDock);
  // the arc moves in whole percent (what the label prints) and is written only when that
  // changes: no transition, so a dash offset is one repaint per change (README recipe 2)
  const ringSet = (id, frac, text) => {
    const e = $(id), off = (88 * (1 - Math.round(100 * Math.max(0, Math.min(1, frac))) / 100)).toFixed(1);
    if (e._off !== off) { e._off = off; e.style.strokeDashoffset = off; }
    set(id + "T", text);
  };
  const kb = (b) => b < 1000 ? Math.round(b) + "B" : b < 1e6 ? Math.round(b / 1000) + "K" : (b / 1e6).toFixed(1) + "M";
  const meter = (b) => Math.min(1, Math.log10(1 + b) / 7.5);   // 0 .. ~30 MB/s, log

  // ---------- the session slots: three jack plates, cut once ----------
  // A plate carries live state only: what its session is doing, its context, its output
  // and cpu, its hour as bars, and how many agents it has out. The agents themselves are
  // printed once, in Agents; the slot's agents jack is a mult with a cord to each of their
  // rows. Every row and the chart sit at fixed offsets; nothing in a slot depends on what
  // is in it. Unpatched,
  // the same plate shows a socket hole cut through the acrylic, says what the slot is for
  // and, once known, who was last in it; its chart box keeps a dormant baseline.
  const S_OPT = { side: "r", ys: S_JACKS, c: [CHAM, 0, 0, CHAM], cls: "sess",
    extra: `<g class="sock" style="display:none"><path d="${hex(HOLE.x, HOLE.y, HOLE.r + 14)} ${circ(HOLE.x, HOLE.y, HOLE.r)}" fill-rule="evenodd" fill="var(--e)" stroke="var(--acr-top)" stroke-width="1"/><circle cx="${HOLE.x}" cy="${HOLE.y}" r="${HOLE.r + 6}" fill="none" stroke="var(--acr-e)" stroke-width="1"/><circle cx="${HOLE.x}" cy="${HOLE.y}" r="${HOLE.r - 8}" fill="none" stroke="var(--acr-e)" stroke-width="1" stroke-dasharray="2 3"/></g>` };
  const slotEl = [], slotBox = [], SCH = 76;   // the slot's hour chart, 274 x 76
  for (let i = 0; i < NSLOT; i++) {
    const b = { x: SLOT.x, y: SLOT_Y[i], w: SLOT.w, h: SLOT.h };
    const p = plate("s" + i, b, S_OPT, `<i class="tab"></i>
      <div class="hd"><span class="t" id="nm${i}"></span><span class="m" id="md${i}"></span></div>
      <div class="live">
        <div class="ab" style="left:12px;top:38px;width:276px">
          <div class="r l" style="--kw:240px"><span class="k" id="st${i}" style="color:var(--ink);font-size:13px"></span><span class="n" id="kd${i}" style="text-align:right"></span></div>
          <div class="r l" style="--kw:56px"><span class="k">context</span><span class="n"><span class="bar" style="display:inline-block;width:92px;vertical-align:1px;margin-right:8px"><i id="cb${i}" style="--bc:var(--sec);transform:scaleX(0)"></i></span><span class="slot" id="cx${i}" style="width:120px;text-align:left"></span></span></div>
          <div class="r"><span class="k" id="o15${i}" style="flex:none;width:150px"></span><span class="n" id="cm${i}" style="width:126px;color:var(--sec);font-size:12px"></span></div>
        </div>
        <div class="cap ab" style="left:12px;top:184px;width:274px"><span>60 min ago</span><span id="pk${i}"></span><span>now</span></div>
        <div class="ab r" style="left:12px;top:204px;width:276px"><span class="k" id="sag${i}"></span></div>
      </div>
      <div class="free">
        <div class="say"><b>Nothing patched in</b><span>A new session plugs in here</span><span class="lh" id="lh${i}"></span><span id="lt${i}"></span></div>
      </div>
      <div class="chart" id="sp${i}" style="left:12px;top:104px;width:274px;height:${SCH}px"></div>`);
    p.style.setProperty("--pk", SLOT_INK[i]);
    slotEl.push(p); slotBox.push(b);
  }
  // the designation strip: a ticket with notched ends, listing who has no slot
  {
    const d = document.createElement("div");
    d.className = "plt"; d.id = "strip";
    d.style.cssText = `left:${STRIP.x}px;top:${STRIP.y}px;width:${STRIP.w}px;height:${STRIP.h}px`;
    const w = STRIP.w, h = STRIP.h, m = h / 2, r = 6;
    const dd = `M0,0H${w}V${m - r}A${r},${r} 0 0 0 ${w},${m + r}V${h}H0V${m + r}A${r},${r} 0 0 0 0,${m - r}Z`;
    d.innerHTML = `<svg class="plate" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="left:0"><path class="pf" d="${dd}"/><path class="pe" d="${dd}"/><path class="pt" d="M0,0.5H${w}"/></svg><div class="tx" id="stripT"></div>`;
    cards.appendChild(d);
  }

  // ---------- This hour, the hero: three slot jacks on its channel edge ----------
  // By the minute, each column stacked by slot in the slots' inks with grey on top for
  // everyone else (sessions without a slot, and sessions now closed). The output cords
  // plug into its left edge and their ink carries on into the bars. Beside the chart, its
  // key: each slot's hour and share in its ink (printed here only; the slot's own chart
  // shows the shape), everyone else in grey, then the minutes.
  const HC = { w: 420, h: 212 };
  const keyRow = (k) => `<div class="r hk"><span class="k"><i class="sw" id="hkS${k}"></i><span id="hkN${k}"></span></span><span class="n" id="hkP${k}" style="width:36px;color:var(--sec);font-size:12px"></span><span class="n" id="hkV${k}" style="width:40px"></span></div>`;
  plate("c-out", HERO, { side: "l", ys: H_JACKS, c: [0, CHAM, CHAM, 0] }, `<div class="hd"><span class="t">This hour</span><span class="m" id="m-hour"></span></div>
    <div class="chart" id="hChart" style="left:16px;top:44px;width:${HC.w}px;height:${HC.h}px"><div class="vbars" id="hBars" style="position:absolute;left:0;top:0;width:${HC.w}px;height:${HC.h}px"></div><div class="base" style="position:absolute;left:0;right:0;bottom:0"></div><div style="position:absolute;left:0;right:0;top:0;height:1px;background:var(--rule);opacity:.6"></div><div style="position:absolute;left:0;right:0;top:${HC.h / 2}px;height:1px;background:var(--rule);opacity:.25"></div></div>
    <div class="cap ab" style="left:16px;top:${44 + HC.h + 4}px;width:${HC.w}px"><span>60 min ago</span><span>now</span></div>
    <div class="ab" style="left:452px;top:44px;width:1px;height:${HC.h + 20}px;background:var(--acr-e)"></div>
    <div class="ab" style="left:468px;top:38px;width:156px"><div class="hero-n" style="text-align:left">${slot("hTot", 156)}</div><div class="lbl" style="line-height:16px">tokens out, last 60 min</div></div>
    <div class="ab" style="left:468px;top:122px;width:156px">${[0, 1, 2, 3].map(keyRow).join("")}</div>
    <div class="ab" style="left:468px;top:212px;width:156px;--nw:64px">${row("last full minute", "hLast")}${row("this minute so far", "hNow")}${row("busiest minute", "hPeak")}</div>`);
  for (let k = 0; k < 4; k++) $("hkS" + k).style.background = k < NSLOT ? SLOT_INK[k] : "var(--idle)";
  const hBars = $("hBars"); for (let i = 0; i < 60; i++) hBars.insertAdjacentHTML("beforeend", `<i style="width:5.6px${i < 59 ? ";margin-right:1.4px" : ""}"><b style="transform:scaleY(0)">${SLOT_INK.map((k) => `<s style="background:${k}"></s>`).join("")}<s style="background:var(--idle)"></s></b></i>`);

  // ---------- Agents: out now | the roster, one plate in two cells ----------
  // Who is out, one line each (type, task, age), in slot order so the agent cords keep
  // their order: six jacks, the sixth row turning into "+k more" past six. The roster is
  // sorted by today's tokens, so the order is the ranking.
  plate("c-agents", AGT, { side: "l", ys: A_JACKS, c: [0, CHAM, CHAM, 0], wells: [[6, 36, 378, AGT.h - 6], [390, 36, AGT.w - 6, AGT.h - 6]] }, `<div class="hd"><span class="t">Agents</span><span class="m" id="m-agents"></span></div>
    <div class="ab ruled" id="agNow" style="left:16px;top:38px;width:352px;height:${20 * AG_ROWS}px"></div>
    <div class="ab" style="left:400px;top:38px;width:224px"><table><thead><tr><th>type</th><th style="width:72px">tokens today</th><th style="width:52px">14 days</th></tr></thead><tbody id="agRows"></tbody></table></div>`);

  // ---------- the Log: a jack strip, one jack per row ----------
  plate("c-log", LOGB, { side: "l", ys: L_JACKS, c: [0, CHAM, CHAM, 0] }, `<div class="hd"><span class="t">Log</span><span class="m" id="m-log"></span></div><div class="ab log" id="logRows" style="left:12px;top:38px;width:288px;height:${20 * LOG_ROWS}px;overflow:hidden"></div>`);

  // ---------- card bodies ----------
  $("t-allow").innerHTML = `<i class="lamp"></i>Needs you`;
  // one fixed body: up to two asks on two rows each, the 14-day ask record in a line under
  // them; with nothing waiting, the record takes the rows the asks would use
  $("bd-allow").innerHTML = `<div class="ab" id="nyBody" style="left:12px;top:38px;width:228px;height:102px;overflow:hidden"></div>`;
  // the week: the tag is the figure, the burn-down is its history; the reset date is the
  // chart's right-hand end and "resets in" sits in the header, so neither needs a row
  const WKH = 80;
  $("bd-week").innerHTML = `<div class="ab" style="left:12px;top:40px;width:228px;display:flex;align-items:center;height:44px"><span class="gtag"><span class="slot" id="wkPct" style="width:84px"></span></span><div class="lbl" style="flex:1 1 auto;margin-left:12px;line-height:16px">of the week used</div></div>
    <div class="ab" style="left:12px;top:90px;width:228px">${row("burn, last 6 h", "bnRate", 100)}${row("forecast", "bnFc", 150)}<div class="r"><span class="k" id="wkPrevK">last week ended at</span><span class="n" id="wkPrev" style="width:56px"></span></div></div>
    <svg id="wkChart" class="ab" width="228" height="${WKH}" viewBox="0 0 228 ${WKH}" style="left:12px;top:156px"></svg>`;
  $("bd-mac").innerHTML = `${row("CPU, 10 cores", "cpu", 60)}<div class="cores" id="cores"></div>
    ${row("memory", "mem", 110)}<div class="stack" id="meStack"></div><div class="leg" id="meLeg"></div>
    <div class="r"><span class="k">pressure <span id="mePr" style="color:var(--ink)"></span></span><span class="n" id="swap" style="width:90px"></span></div>
    ${row("disk free", "dk", 120)}${row("read, write", "dkIo", 150)}
    <div class="lbl" style="margin-top:4px">Busiest</div><div id="tops" style="height:100px;overflow:hidden"></div>`;
  $("bd-weather").innerHTML = `<canvas id="skyW" class="ab" width="456" height="88" style="left:12px;top:38px;width:228px;height:44px"></canvas>
    <div class="ab" style="left:12px;top:86px;width:228px"><div class="r"><span class="k">feels, humidity</span><span class="n" id="wxFeels" style="width:100px"></span></div>${row("wind", "wxWind", 130)}${row("daylight", "wxSun", 140)}</div>`;
  // Today: a round 24-hour dial on a square faceplate, the day's readings in its corners
  const DIAL = 232;
  $("bd-today").innerHTML = `<svg id="dial" class="ab" width="${DIAL}" height="${DIAL}" viewBox="0 0 ${DIAL} ${DIAL}" style="left:39px;top:37px"></svg>
    <div class="cn" style="left:11px;top:38px"><span>tokens out</span><b><span class="slot" id="tdOut" style="width:76px;text-align:left"></span></b></div>
    <div class="cn rt" style="right:11px;top:38px"><span>calls</span><b>${slot("tdCalls", 76)}</b></div>
    <div class="cn" style="left:11px;top:236px"><b id="tdHit"></b><span>cache hit</span></div>
    <div class="cn rt" style="right:11px;top:236px"><b id="tdFl"></b><span>failed turns</span></div>
    <div class="leg ab" style="left:0;right:0;top:278px;justify-content:center"><span><i style="background:var(--h3)"></i>today by hour</span><span><i style="height:1px;vertical-align:3px;background:var(--sec)"></i>yesterday</span></div>`;
  const BH = 64;
  $("bd-fort").innerHTML = `<div class="ab" style="left:11px;top:38px;width:276px;height:${BH}px"><div class="vbars" id="dBars" style="position:absolute;left:0;top:0;width:276px;height:${BH}px;gap:4.5px"></div><div class="base" style="position:absolute;left:0;right:0;bottom:0"></div></div>
    <div class="cap ab" style="left:11px;top:106px;width:276px"><span id="dFrom"></span><span>today</span></div><div class="leg ab" id="dLeg" style="left:11px;top:126px;width:276px"></div>`;
  $("bd-hours").innerHTML = `<svg id="heat" class="ab" width="498" height="74" viewBox="0 0 498 74" style="left:11px;top:38px"></svg>
    <div class="cap ab" style="left:41px;top:114px;width:468px"><span>midnight</span><span>6 am</span><span>noon</span><span>6 pm</span><span>11 pm</span></div>
    <div class="leg ab" style="left:11px;top:130px;width:498px"><span>an average hour over two weeks: less</span><span style="gap:2px;display:flex;align-items:center"><i style="background:var(--h1);margin:0"></i><i style="background:var(--h2);margin:0"></i><i style="background:var(--h3);margin:0"></i><i style="background:var(--h4);margin:0"></i></span><span>more</span></div>`;
  // the year grid: 52 columns of 4.9-pt squares at a 5.5-pt pitch (285.4 wide), the last
  // column being the week so far
  const CALP = 5.5;
  $("bd-github").innerHTML = `<svg id="cal" class="ab" width="288" height="38" viewBox="0 0 288 38" style="left:11px;top:38px"></svg>
    <div class="cap ab" style="left:11px;top:80px;width:288px"><span id="calFrom"></span><span id="calBest"></span></div>
    <div class="ab" style="left:11px;top:98px;width:288px">${row("today, this week, streak", "ghT", 120)}${row("past year", "ghY", 220)}</div>`;
  const cores = $("cores"); for (let i = 0; i < 10; i++) cores.insertAdjacentHTML("beforeend", `<i><b style="transform:scaleY(0)"></b></i>`);
  const dBars = $("dBars"); for (let i = 0; i < 14; i++) dBars.insertAdjacentHTML("beforeend", `<i style="width:15.5px"></i>`);
  const nums = {
    cpu: Kiln.num($("cpu"), { fmt: (v) => v.toFixed(1) + " %" }),
    mem: Kiln.num($("mem"), { fmt: (v) => (v / 1073741824).toFixed(1) + " of 16 GB" }),
    wkPct: Kiln.num($("wkPct"), { fmt: (v) => Math.round(v) + " %" }),
    tdOut: Kiln.num($("tdOut"), { fmt: F.tokens }), tdCalls: Kiln.num($("tdCalls"), { fmt: F.int }),
    hTot: Kiln.num($("hTot"), { fmt: F.tokens }),
    hLast: Kiln.num($("hLast"), { fmt: F.tokens }), hNow: Kiln.num($("hNow"), { fmt: F.tokens }),
  };
  Kiln.track("rx", (s) => s.sys.net.rx_bps, 120); Kiln.track("tx", (s) => s.sys.net.tx_bps, 120);

  // ---------- slots: a session keeps its jack until it ends ----------
  // A new session takes the first free slot. With all three full, newcomers go on the
  // designation strip. One from the strip takes a slot only when it needs you and the
  // slotted one does not, or it is working and the slotted one is idle, and never within
  // 30 s of that slot's last change, so a working/idle flicker never swaps cords.
  const LVL = { waiting: 0, failed: 0, working: 1, background: 2, idle: 3 };
  const lvl = (x) => LVL[x.state] ?? 3;
  const rank = (a, b) => lvl(a) - lvl(b) || (a.kind === "interactive" ? 0 : 1) - (b.kind === "interactive" ? 0 : 1) || a.since - b.since;
  const slotSid = new Array(NSLOT).fill(null), slotName = new Array(NSLOT).fill(""), slotAt = new Array(NSLOT).fill(-1e12), lastHere = new Array(NSLOT).fill(null);
  function assignSlots(list, now) {
    const live = new Map(list.map((x) => [x.sid, x]));
    for (let i = 0; i < NSLOT; i++) if (slotSid[i] && !live.has(slotSid[i])) { lastHere[i] = { name: slotName[i], t: now }; slotSid[i] = null; slotAt[i] = now; }
    const held = new Set(slotSid.filter(Boolean)), wait = list.filter((x) => !held.has(x.sid)).sort(rank);
    const take = (i, x) => { slotSid[i] = x.sid; slotName[i] = x.name; slotAt[i] = now; };
    for (let i = 0; i < NSLOT && wait.length; i++) if (!slotSid[i]) take(i, wait.shift());
    for (const c of wait.slice()) {
      let worst = -1, wl = -1;
      for (let i = 0; i < NSLOT; i++) { const x = live.get(slotSid[i]); if (x && now - slotAt[i] >= 30 && lvl(x) > wl) { wl = lvl(x); worst = i; } }
      if (worst < 0) break;
      const cl = lvl(c);
      if ((cl === 0 && wl > 0) || (cl <= 1 && wl === 3)) take(worst, c); else break;
    }
    for (let i = 0; i < NSLOT; i++) if (slotSid[i]) slotName[i] = live.get(slotSid[i]).name;
    return slotSid.map((sid) => sid ? live.get(sid) : null);
  }

  // the session's hour as bars in its ink: 60 minutes at a 3.8-pt pitch on a baseline with
  // 15-min ticks, under a 0.5-pt ceiling rule that the hour's peak minute touches
  // (labelled with its figure). Always the full ink: a thinned ink reads as a different,
  // muddier one; the state row says idle. A silent hour (or an empty slot) is the same box
  // with a flat baseline: the chart never shrinks.
  function hourChart(opm, w, h, dormant) {
    const mx = opm.length ? Math.max(...opm) : 0, bw = 2.8, pitch = 3.8, inner = h - 1, pw = 60 * pitch - 1;
    let r = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute;left:0;top:0">`;
    r += `<rect x="0" y="${h - 1}" width="${w}" height="1" fill="var(--rule)"${dormant ? ` opacity=".5"` : ""}/>`;
    for (let m = 0; m <= 60; m += 15) r += `<rect x="${m * pitch - (m === 60 ? 1 : 0)}" y="${h - 4}" width="1" height="3" fill="var(--rule)"/>`;
    if (!dormant) r += `<rect x="0" y="0" width="${pw}" height="0.5" fill="var(--rule)" opacity=".6"/>`;
    if (mx > 0) {
      r += `<g fill="var(--pk)">`;
      opm.forEach((v, i) => { if (v <= 0) return; const bh = Math.max(1, Math.round(v / mx * inner * 2) / 2); r += `<rect x="${i * pitch}" y="${(inner - bh).toFixed(1)}" width="${bw}" height="${bh}"/>`; });
      r += `</g><text x="${w}" y="9" text-anchor="end">peak ${F.tokens(mx)}</text>`;
    }
    return r + "</svg>";
  }
  // when the ask began: the ask's own start time once the feed carries one, else the
  // session's last activity
  const askedAt = (x) => { const a = x.ask; return (a && (a.t || a.started || a.since || a.asked_at)) || x.last_activity || x.since; };
  function stateLine(x, now) {
    if (x.state === "working") return `${glyph("a", "●")}working, ${short(x.up_s)}`;
    if (x.state === "background") return `${glyph("a", "●")}working in the background, ${short(x.up_s)}`;
    if (x.state === "waiting") return `${glyph("alert", "●")}waiting ${short(now - askedAt(x))}`;
    if (x.state === "failed") return `${glyph("alert", "✕")}failed at ${F.clock(x.last_activity || x.since)}`;
    return `${glyph("idle", "●")}idle since ${F.clock(x.last_activity || x.since)}`;
  }

  // ---------- This hour, stacked by slot ----------
  // The column's height is the minute's whole output (the feed's tokens.out_per_min) and
  // moves on the compositor; inside it, each slot's minute in its ink, bottom up, and on top
  // everyone else (grey). The split snaps, the height glides. Rebuilt only when the tokens
  // block, a slot's occupant or its minutes change.
  let hStruct = "", hCache = [], hT = null;
  function hourStack(T, bySlot) {
    const struct = bySlot.map((x) => x ? x.sid : "-").join(",");
    let dirty = struct !== hStruct || T !== hT;
    bySlot.forEach((x, i) => { if (!sameNums(x ? x.out_per_min : null, hCache[i])) dirty = true; });
    if (!dirty) return;
    hStruct = struct; hT = T; hCache = bySlot.map((x) => x ? x.out_per_min : null);
    const opm = T.out_per_min || [], cols = []; let mx = 1, other = 0, peak = 0;
    for (let m = 0; m < 60; m++) { const v = bySlot.map((x) => x ? (x.out_per_min[m] || 0) : 0), s = sum(v), tot = Math.max(opm[m] || 0, s); cols.push([v, tot - s, tot]); if (tot > mx) mx = tot; if (tot > peak) peak = tot; other += tot - s; }
    cols.forEach(([v, o, tot], m) => {
      const b = hBars.children[m].firstChild, tf = `scaleY(${(tot / mx).toFixed(3)})`;
      if (b._tf !== tf) { b._tf = tf; b.style.transform = tf; }
      // each layer: lifted by the layers under it, scaled to its share of the column
      const segs = b.children; v.push(o); let base = 0;
      v.forEach((val, j) => {
        const f = tot > 0 ? val / tot : 0, g = f > 0 ? `translateY(${(-base * 100).toFixed(2)}%) scaleY(${f.toFixed(4)})` : "scaleY(0)";
        if (segs[j]._g !== g) { segs[j]._g = g; segs[j].style.transform = g; }
        base += f;
      });
    });
    const total = sum(cols.map((c) => c[2]));
    nums.hTot.set(total); set("hPeak", F.tokens(peak));
    set("m-hour", "by slot, a column a minute");
    // the key: four fixed rows, the three slots then everyone else
    const pct = (v) => total > 0 && v > 0 ? Math.round(v / total * 100) + " %" : "";
    bySlot.forEach((x, i) => {
      const v = x ? sum(x.out_per_min || []) : 0;
      set("hkN" + i, x ? x.name : "free slot"); set("hkV" + i, x ? F.tokens(v) : "–"); set("hkP" + i, x ? pct(v) : "");
      $("hkS" + i).style.opacity = x ? "" : ".25";
    });
    set("hkN3", "others"); set("hkV3", F.tokens(other)); set("hkP3", pct(other));
  }

  // ---------- the Today dial: 24 hours round a clock, midnight at the top ----------
  // Each hour a petal from the hub, its length and its ink (the warm ramp) both the
  // tokens written in that hour; yesterday's hour as a line across the same sector. The
  // face is a recessed well inside a bezel; the hour under way is outlined; the hub prints it.
  const RAMP = ["var(--h0)", "var(--h1)", "var(--h2)", "var(--h3)", "var(--h4)"];
  const level = (v, mx) => v <= 0 ? 0 : v < mx * 0.1 ? 1 : v < mx * 0.3 ? 2 : v < mx * 0.6 ? 3 : 4;
  function dial(A, now) {
    const ds = A.days || [], today = ds[ds.length - 1], yday = ds[ds.length - 2];
    const th = (today && today.hours) || [], yh = (yday && yday.hours) || [], mx = Math.max(1, ...th, ...yh);
    const cx = DIAL / 2, cy = DIAL / 2, R = DIAL / 2 - 1, r0 = 24, r1 = DIAL / 2 - 20, hNow = new Date(now * 1000).getHours();
    const P = (r, a) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    const ang = (h) => h / 24 * 2 * Math.PI - Math.PI / 2;
    let s = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="var(--g)" stroke="var(--e)" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="${r1}" fill="none" stroke="var(--rule)" stroke-width=".5" opacity=".6"/><circle cx="${cx}" cy="${cy}" r="${r0}" fill="none" stroke="var(--rule)" stroke-width=".5"/>`;
    // an hour tick between the petals and the bezel; the four quarter hours are named
    // instead (midnight, 6 am, noon, 6 pm), so their ticks would run through the names
    for (let h = 0; h < 24; h++) if (h % 6) s += `<path d="M${P(r1 + 4, ang(h))}L${P(r1 + 7, ang(h))}" stroke="var(--rule)" stroke-width=".5"/>`;
    for (let h = 0; h < 24; h++) {
      const a0 = ang(h) + 0.02, a1 = ang(h + 1) - 0.02, v = th[h] || 0, y = yh[h] || 0;
      if (v > 0) { const r = r0 + (r1 - r0) * v / mx; s += `<path d="M${P(r0, a0)}L${P(r, a0)}A${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${P(r, a1)}L${P(r0, a1)}A${r0},${r0} 0 0 0 ${P(r0, a0)}Z" fill="${RAMP[level(v, mx)]}"${h === hNow ? ` stroke="var(--ink)" stroke-width="1"` : ""}/>`; }
      else if (h === hNow) s += `<path d="M${P(r0, a0)}L${P(r0 + 6, a0)}A${r0 + 6},${r0 + 6} 0 0 1 ${P(r0 + 6, a1)}L${P(r0, a1)}" fill="none" stroke="var(--ink)" stroke-width="1"/>`;
      if (y > 0) { const r = r0 + (r1 - r0) * y / mx; s += `<path d="M${P(r, a0)}A${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${P(r, a1)}" fill="none" stroke="var(--sec)" stroke-width="1"/>`; }
    }
    // the names sit on the petal ring; a 3-pt stroke in the face's own black (painted under
    // the glyphs) cuts the ring where a name crosses it
    const nm = `paint-order="stroke" stroke="var(--g)" stroke-width="3" stroke-linejoin="round"`;
    s += `<text x="${cx}" y="${cy - R + 15}" text-anchor="middle" ${nm}>midnight</text><text x="${cx}" y="${cy + R - 8}" text-anchor="middle" ${nm}>noon</text><text x="${cx - R + 8}" y="${cy + 4}" ${nm}>6 am</text><text x="${cx + R - 8}" y="${cy + 4}" text-anchor="end" ${nm}>6 pm</text>`;
    // the hub names the hour under way (its petal is outlined); its figure is not printed:
    // a clock-hour total beside This hour's last-60-minutes total reads as one figure twice
    s += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" style="fill:var(--ink);font-size:12px;font-weight:500">${hNow === 0 ? "12 am" : hourName(hNow)}</text>`;
    html("dial", s);
  }

  // ---------- cords: every cord joins the two places the same thing is printed ----------
  // and is printed in the ink of the slot it comes from. out: the slot's output jack (its
  // chart's middle) across the channel to that slot's jack on This hour, 4-10 pt = its share
  // of the hour (3 pt when silent). agent: a slot's agent row to that agent's row in Agents.
  // log: the slot's header jack (a mult: one output split to several) to the first row of
  // each run of its rows in the Log. ask: the state row to its row in Needs you, ALERT,
  // ducted through the C1/C2 gutter in 4-pt lanes. The jacks themselves are part of the
  // plates (unlit grey rings); a cord lights its two in its ink. Under every channel cord
  // runs a paper stroke 4 pt wider, so where cords cross the later one passes over the
  // earlier with a gap, like a real cord; thin cords draw first.
  const wires = $("wires"), gW = svg("g", { fill: "none", "stroke-linecap": "round" }, wires), gJ = svg("g", {}, wires);
  const curve = (x0, y0, x1, y1) => { const k = (x1 > x0 ? 1 : -1) * Math.max(24, Math.abs(x1 - x0) / 2); return `M${x0},${y0} C${x0 + k},${y0} ${x1 - k},${y1} ${x1},${y1}`; };
  function duct(pts, r) {
    r = r || 6;
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
      const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by), rr = Math.min(r, l1 / 2, l2 / 2);
      if (!l1 || !l2) continue;
      d += `L${(bx + (ax - bx) / l1 * rr).toFixed(1)},${(by + (ay - by) / l1 * rr).toFixed(1)}Q${bx},${by} ${(bx + (cx - bx) / l2 * rr).toFixed(1)},${(by + (cy - by) / l2 * rr).toFixed(1)}`;
    }
    const e = pts[pts.length - 1]; return d + `L${e[0]},${e[1]}`;
  }
  const cordEls = new Map(); let prevCords = null;
  function drawCords(cords) {
    gW.innerHTML = ""; gJ.innerHTML = ""; cordEls.clear();
    const seen = new Set();
    cords.sort((a, b) => a.w - b.w).forEach((k) => {
      if (k.kind !== "ask") svg("path", { d: k.path, stroke: "var(--g)", "stroke-width": (k.w + 4).toFixed(1) }, gW);
      const p = svg("path", { d: k.path, stroke: k.ink, "stroke-width": k.w.toFixed(1), class: "cord " + k.kind }, gW);
      k.jacks.forEach(([x, y]) => svg("circle", { cx: x, cy: y, r: 5, fill: "var(--g)", stroke: k.ink, "stroke-width": 2 }, gJ));
      cordEls.set(k.id, { el: p, kind: k.kind, ink: k.ink });
      // a cord that was not here a moment ago: an ask draws itself in, an agent or Log
      // cord pulses once as it is plugged in (not at load: nothing just happened)
      if (prevCords && !prevCords.has(k.id)) { if (k.kind === "ask") drawIn(p); else if (k.kind === "agent" || k.kind === "log") pulse(k.id, 8); }
      seen.add(k.id);
    });
    prevCords = seen;
  }
  // ---------- pulses: a bead of the cord's ink runs the cord when something lands ----------
  // The output cord pulses when a response's tokens land (out_per_min[59] steps; Claude
  // Code writes usage once per response), the bead sized by that response, 8-14 pt. A
  // pulse is one small element with one transform animation over points sampled from the
  // path once per cord build (one per 30 pt, 16-48), removed when it ends; one in flight per
  // cord. The dev switch ?pulse=offset runs the same bead on offset-path instead (kept for
  // the measurement that chose between them). With reduced motion the bead appears at the
  // far jack and fades.
  const stage = $("stage"), RM = matchMedia("(prefers-reduced-motion: reduce)"), DEV = window.PB_DEV || {};
  const PULSE = q.get("pulse") || DEV.pulse || "translate", STRESS = q.has("stress") || !!DEV.stress;
  function pulse(id, d) {
    const c = cordEls.get(id); if (!c || c.busy) return;
    if (document.documentElement.classList.contains("kiln-paused")) return;
    const el = document.createElement("div"); el.className = "pulse"; el.style.width = el.style.height = d + "px"; el.style.background = c.ink;
    const at = (p) => `translate(${(p.x - d / 2).toFixed(1)}px,${(p.y - d / 2).toFixed(1)}px)`;
    let anim;
    if (RM.matches) { el.style.transform = at(c.el.getPointAtLength(c.el.getTotalLength())); anim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, delay: 100 }); }
    else if (PULSE === "offset") { el.style.offsetPath = `path("${c.el.getAttribute("d")}")`; anim = el.animate([{ offsetDistance: "0%" }, { offsetDistance: "100%" }], { duration: 600, easing: "ease-out" }); }
    else {
      if (!c.pts) { const n = c.el.getTotalLength(), K = Math.max(16, Math.min(48, Math.round(n / 30))); c.pts = []; for (let i = 0; i <= K; i++) c.pts.push(c.el.getPointAtLength(n * i / K)); }
      anim = el.animate(c.pts.map((p) => ({ transform: at(p) })), { duration: 600, easing: "ease-out" });
    }
    c.busy = true; stage.appendChild(el);
    anim.onfinish = () => { el.remove(); c.busy = false; };
  }
  function drawIn(p) {
    if (RM.matches) return;
    const n = p.getTotalLength(); p.setAttribute("stroke-dasharray", n);
    p.animate([{ strokeDashoffset: n }, { strokeDashoffset: 0 }], { duration: 400, easing: "ease-out" }).onfinish = () => p.removeAttribute("stroke-dasharray");
  }
  const dotSize = (tokens) => Math.max(8, Math.min(14, Math.round(8 + 2 * Math.log2(Math.max(1, tokens) / 250))));

  // ---------- the sky: painted flat, like a print of the real sky ----------
  // Three hard bands by altitude, a sun or moon, clouds, rain, snow, fog or a bolt; every
  // kind, day and night. Ink for the text drawn on it is picked from the painted pixels.
  const SKY = {
    clear: { d: ["#2f7fd0", "#6eb1ea", "#bddcf4"], n: ["#0b1024", "#141b3a", "#1f2b50"] },
    partly: { d: ["#3b89d6", "#7fb9ea", "#c4def2"], n: ["#0d1228", "#171f3e", "#222e52"] },
    cloudy: { d: ["#7e8893", "#9ea7b0", "#bfc5cb"], n: ["#161922", "#222630", "#2e333d"] },
    fog: { d: ["#9ca3aa", "#b3b9bf", "#c9ced3"], n: ["#20242a", "#2a2f36", "#343a41"] },
    drizzle: { d: ["#6c7786", "#8893a0", "#a6afb9"], n: ["#121620", "#1c2230", "#272e3c"] },
    rain: { d: ["#5d6978", "#7a8694", "#98a3ae"], n: ["#0f131c", "#191f2b", "#232a37"] },
    snow: { d: ["#9aa5b2", "#bcc4cd", "#dde2e8"], n: ["#1a1f29", "#2a303c", "#3b424f"] },
    storm: { d: ["#2c3240", "#434a58", "#5b6372"], n: ["#0a0d14", "#141821", "#1e232c"] },
  };
  function cloud(c, x, y, s, fill) {
    c.fillStyle = fill; c.beginPath();
    c.arc(x, y, 7 * s, 0, 7); c.arc(x + 9 * s, y - 4 * s, 9 * s, 0, 7); c.arc(x + 20 * s, y - 1 * s, 7.5 * s, 0, 7); c.arc(x + 28 * s, y + 2 * s, 5.5 * s, 0, 7);
    c.rect(x - 2 * s, y, 32 * s, 5 * s); c.fill();
  }
  function paintSky(cv, w, h, kind, day) {
    const c = cv.getContext("2d"); c.setTransform(2, 0, 0, 2, 0, 0); c.clearRect(0, 0, w, h);
    const k = SKY[kind] ? kind : "cloudy", g = SKY[k][day ? "d" : "n"];
    [[0, 0.42], [0.42, 0.76], [0.76, 1]].forEach(([a, b], i) => { c.fillStyle = g[i]; c.fillRect(0, Math.round(a * h), w, Math.ceil((b - a) * h) + 1); });
    if (!day && (k === "clear" || k === "partly")) { c.fillStyle = "#e9ecf3"; for (let i = 0; i < 9; i++) c.fillRect(((i * 53 + 11) % w), ((i * 29 + 5) % Math.round(h * 0.6)), 1, 1); }
    if (k === "clear" || k === "partly") {
      const r = Math.round(h * 0.16), sx = w - r - 10, sy = r + 6;
      c.fillStyle = day ? "#ffe9a0" : "#e8ecf5"; c.beginPath(); c.arc(sx, sy, r, 0, 7); c.fill();
      if (!day) { c.fillStyle = g[0]; c.beginPath(); c.arc(sx - r * 0.45, sy - r * 0.2, r * 0.8, 0, 7); c.fill(); }
    }
    const cl = day ? (k === "partly" ? "#f6f8fa" : k === "snow" ? "#eef1f4" : "#d6dbe0") : (k === "partly" ? "#3a4256" : "#3c424c");
    if (k === "partly") cloud(c, w * 0.12, h * 0.55, h / 56, cl);
    if (k === "cloudy" || k === "drizzle" || k === "rain" || k === "storm" || k === "snow") { cloud(c, w * 0.06, h * 0.42, h / 56, cl); cloud(c, w * 0.52, h * 0.3, h / 56 * 1.1, cl); }
    if (k === "fog") { c.fillStyle = day ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.08)"; for (let y = 6; y < h; y += 8) c.fillRect(0, y, w, 3); }
    if (k === "rain" || k === "drizzle" || k === "storm") { c.strokeStyle = day ? "rgba(255,255,255,.8)" : "rgba(190,205,230,.6)"; c.lineWidth = k === "drizzle" ? 0.5 : 1; c.beginPath(); for (let x = -h; x < w; x += k === "drizzle" ? 9 : 7) { c.moveTo(x + h * 0.35, h * 0.55); c.lineTo(x, h); } c.stroke(); }
    if (k === "snow") { c.fillStyle = "#ffffff"; for (let i = 0; i < Math.round(w / 4); i++) { const x = (i * 37 + 3) % w, y = (i * 23 + 9) % h; c.fillRect(x, y, 2, 2); } }
    if (k === "storm") { c.fillStyle = "#ffe36b"; const x = w * 0.72, y = h * 0.3; c.beginPath(); c.moveTo(x, y); c.lineTo(x - 5, y + 14); c.lineTo(x + 1, y + 13); c.lineTo(x - 4, y + 26); c.lineTo(x + 6, y + 11); c.lineTo(x, y + 12); c.closePath(); c.fill(); }
  }
  // ink picked from the pixels under the text; the halo hugs the glyphs (2 px) and is the
  // opposite tone, so it separates the letters from clouds and bands without veiling the sky
  function skyText(cv, x, y, w, h, lines) {
    const c = cv.getContext("2d"), px = c.getImageData(x * 2, y * 2, w * 2, h * 2).data;
    let lum = 0, n = 0; for (let i = 0; i < px.length; i += 16) { lum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; n++; }
    const light = lum / n > 128, ink = light ? "#141414" : "#f3efe6", halo = light ? "rgba(243,239,230,.85)" : "rgba(20,20,20,.85)";
    c.lineJoin = "round"; c.lineWidth = 2; c.strokeStyle = halo; c.fillStyle = ink;
    for (const [tx, ty, font, text, align] of lines) { c.font = font; c.textAlign = align || "left"; c.strokeText(text, tx, ty); c.fillText(text, tx, ty); }
  }
  const tempUnitLabel = () => Kiln.tempUnit === "C" ? "°C" : "°F";
  function paintWeather(w) {
    const cv = $("skyW"), W = 228, H = 44;
    if (!w) {
      const c = cv.getContext("2d"); c.setTransform(2, 0, 0, 2, 0, 0); c.clearRect(0, 0, W, H); c.fillStyle = css("--e"); c.fillRect(0, 0, W, H);
      c.fillStyle = css("--sec"); c.font = "13px Barlow"; c.fillText("weather offline", 10, 27);
      return;
    }
    paintSky(cv, W, H, w.kind, w.is_day);
    skyText(cv, 0, 0, 120, H, [[10, 32, "600 24px 'Barlow Condensed'", Math.round(F.tempValue(w.temp_c)) + " " + tempUnitLabel()]]);
    skyText(cv, 120, 22, 108, 22, [[218, 37, "12px Barlow", w.text + ", " + (w.is_day ? "day" : "night"), "right"]]);
  }

  // ---------- the week: burn-down from reset to reset ----------
  // x is the whole week (7 day ticks), y 0–100 %. The "even pace" guide runs from 0 % at
  // the reset to 100 % at the next one; a hairline marks now. Every recorded reading
  // (week_points ∪ limits.history) is a vertex; the hollow point at the reset is the
  // previous week's last reading. The dashed projection appears only when `pace` is non-null.
  function weekChart(L, lim, now, H) {
    const W = 228, ch = H - 16, t1 = L.resets_at, t0 = t1 - 7 * 86400, X = (t) => (t - t0) / (7 * 86400) * W, Y = (p) => 1 + (ch - 2) * (1 - p / 100);
    const hx = (v) => (Math.round(v * 2) / 2).toFixed(1);
    let r = `<rect x="0" y="${ch}" width="${W}" height="1" fill="var(--rule)"/>`;
    for (let d = 0; d <= 7; d++) r += `<rect x="${hx(d * W / 7)}" y="${ch - 3}" width="0.5" height="3" fill="var(--rule)"/>`;
    r += `<rect x="0" y="0" width="${W}" height="0.5" fill="var(--rule)" opacity=".5"/>`;
    r += `<path d="M0,${Y(0)}L${W},${Y(100)}" fill="none" stroke="var(--rule)" stroke-width="1" opacity=".8"/>`;
    const pts = []; let prev = null, before = null;
    for (const p of lim.week_points || []) { if (p[2] === "prev") prev = p[1]; else if (p[0] >= t0) pts.push([p[0], p[1]]); }
    for (const h of lim.history || []) { if (h[0] < t0) before = h[2]; else if (h[0] <= now) pts.push([h[0], h[2]]); }
    if (prev == null) prev = before;
    pts.push([now, L.pct]); pts.sort((a, b) => a[0] - b[0]);
    const nx = X(now), ny = Y(L.pct);
    r += `<rect x="${hx(nx - 0.5)}" y="${ny.toFixed(1)}" width="1" height="${(ch - ny).toFixed(1)}" fill="var(--rule)" opacity=".8"/>`;
    if (prev != null) r += `<circle cx="0" cy="${Y(prev).toFixed(1)}" r="2.5" fill="none" stroke="var(--sec)" stroke-width="1"/>`;
    weekChart.prev = prev;
    r += `<path d="M${pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("L")}" fill="none" stroke="var(--gold)" stroke-width="1.5" stroke-linejoin="round"/>`;
    r += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="3" fill="var(--gold)"/>`;
    const fc = L.pace != null && L.projected != null;
    const out = fc && L.runout_at != null && L.runout_at < t1;
    if (fc) r += `<path d="M${nx.toFixed(1)},${ny.toFixed(1)}L${(out ? X(L.runout_at) : W).toFixed(1)},${Y(out ? 100 : Math.min(100, L.projected)).toFixed(1)}" fill="none" stroke="var(--gold)" stroke-width="1" stroke-dasharray="3 3"/>`;
    const day = (t) => { const d = new Date(t * 1000); return d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.getDate(); };
    r += `<text x="0" y="${H - 2}">${day(t0)}</text><text x="${W}" y="${H - 2}" text-anchor="end">${day(t1)}</text>`;
    let lx = fc ? 50 : 86;   // the legend sits between the two dates
    r += `<rect x="${lx}" y="${H - 6}" width="10" height="1" fill="var(--rule)"/><text x="${lx + 14}" y="${H - 2}">even pace</text>`;
    if (fc) r += `<path d="M${lx + 70},${H - 5.5}L${lx + 82},${H - 5.5}" stroke="var(--gold)" stroke-width="1" stroke-dasharray="3 3"/><text x="${lx + 86}" y="${H - 2}">forecast</text>`;
    html("wkChart", r);
  }

  // ---------- log kinds and GitHub verbs: typed, no repo names ----------
  const KIND = { done: ["sec", "●", "done"], fail: ["alert", "✕", "failed"], ask: ["alert", "●", "asked"], remind: ["alert", "○", "reminder"], answered: ["sec", "◆", "answered"], agent_start: ["a", "▲", "agent out"], agent_done: ["a", "▽", "agent back"] };
  const VERB = { PushEvent: "pushed", PullRequestEvent: "opened a pull request", PullRequestReviewEvent: "reviewed a pull request", IssuesEvent: "opened an issue", IssueCommentEvent: "commented on an issue", WatchEvent: "starred a repo", ForkEvent: "forked a repo", CreateEvent: "created a branch", DeleteEvent: "deleted a branch", ReleaseEvent: "published a release" };
  const ago = (t, now) => F.ago(t, now).replace(/ \d+ (m|s) ago$/, " ago").replace(/^\d+ s ago$/, "just now");
  // what happened, leading with the thing itself. The feed's detail is "type: desc" for
  // agents, "perm Tool" for asks, "after 406s" for answers, and the coalesced turn count
  // rides in `n`.
  const dim = (s) => `<span style="color:var(--sec)">, ${esc(s)}</span>`;
  function what(e) {
    const k = KIND[e.kind] || ["sec", "●", e.kind], det = e.detail || "";
    let s;
    if (e.kind === "agent_start" || e.kind === "agent_done") { const m = det.match(/^([^:]+):?\s*(.*)$/); s = `${esc(m && m[1] ? m[1].trim() : "agent")} ${e.kind === "agent_start" ? "out" : "back"}${m && m[2] ? dim(m[2]) : ""}`; }
    else if (e.kind === "ask" && /^perm\s/.test(det)) s = `permission: ${esc(det.replace(/^perm\s+/, ""))}`;
    else if (e.kind === "answered" && /^after \d+s$/.test(det)) s = `answered${dim("after " + short(+det.slice(6, -1)))}`;
    else s = `${k[2]}${e.n > 1 ? dim(e.n + " turns") : ""}${det ? dim(det) : ""}`;
    return glyph(k[0], k[1]) + s;
  }
  // an agent on one line: what it is, what it was asked to do, how long it has been out
  const agentLine = (a, ink, kw, tail) => `<div class="agr" style="--kw:${kw}px${ink ? ";--pk:" + ink : ""}"><span class="k">${glyph("a", "▲")}${esc(a.type)}</span><span class="d">${tail || esc(a.desc) || "started " + F.clock(a.started)}</span><span class="n">${short(a.age_s)}</span></div>`;
  const moreLine = (rest, kw) => `<div class="agr" style="--kw:${kw}px"><span class="k" style="color:var(--sec)">+${rest.length} more</span><span class="d">${esc(rest.map((g) => g.type).join(", "))}</span><span class="n"></span></div>`;

  // ---------- render ----------
  function render(s, prev) {
    const now = s.t, sys = s.sys, c = s.claude, d = new Date(now * 1000), A = s.analytics;
    set("rClock", F.clock(now)); set("rDate", d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })); set("rPlace", s.weather ? s.weather.place : "");

    const agAll = c.agents_running || [];
    const waiting = c.sessions.filter((x) => x.state === "waiting"), failed = c.sessions.filter((x) => x.state === "failed");
    const needs = waiting.length + failed.length;

    // the slots, and who is on the designation strip
    const bySlot = assignSlots(c.sessions, now);
    const slotIx = new Map(); bySlot.forEach((x, i) => { if (x) slotIx.set(x.sid, i); });
    const inkOf = (sid) => slotIx.has(sid) ? SLOT_INK[slotIx.get(sid)] : null;
    const unslotted = c.sessions.filter((x) => !slotIx.has(x.sid)).sort(rank);
    html("stripT", !c.sessions.length ? "No sessions open" : unslotted.length ? `<b>+${unslotted.length} more:</b> ${unslotted.map((x) => `${esc(x.name)} (${x.state})`).join(", ")}` : "Every open session has a slot");

    // agents in slot order, so the agent cords leave and land in the same order and do not
    // cross one another; agents of sessions without a slot last
    const ag = agAll.slice().sort((a, b) => (slotIx.has(a.sid) ? slotIx.get(a.sid) : NSLOT) - (slotIx.has(b.sid) ? slotIx.get(b.sid) : NSLOT) || a.started - b.started);
    const agShown = ag.length > AG_ROWS ? ag.slice(0, AG_ROWS - 1) : ag;
    const mine = (x) => ag.filter((a) => a.sid === x.sid);

    const T = c.tokens;
    if (T) hourStack(T, bySlot);
    // "% of all" is of everything written this hour, ended sessions included
    const allOut = Math.max(hT ? sum(hT.out_per_min || []) : 0, sum(bySlot.map((x) => x ? sum(x.out_per_min || []) : 0)));
    let wireKey = "";
    bySlot.forEach((x, i) => {
      const box = slotEl[i], b = slotBox[i];
      const idle = !x;
      if (box._idle !== idle) {
        box._idle = idle; box.classList.toggle("idle", idle); cut(box, b, S_OPT, idle);
        box.querySelector(".sock").style.display = idle ? "" : "none";
        box._opm = null;
      }
      if (idle) {
        box.classList.remove("alert");
        set("nm" + i, "Free slot"); set("md" + i, "");
        const lh = lastHere[i]; set("lh" + i, lh ? `Last here: ${lh.name}` : ""); set("lt" + i, lh ? `until ${F.clock(lh.t)}` : "");
        // the chart's box stays where it is, empty: the socket is this slot's picture
        if (box._opm !== "dormant") { box._opm = "dormant"; html("sp" + i, `<svg width="274" height="${SCH}" viewBox="0 0 274 ${SCH}" style="position:absolute;left:0;top:0"></svg>`); }
        wireKey += `${i}:-;`;
        return;
      }
      x.hourSum = sum(x.out_per_min || []);
      box.classList.toggle("alert", x.state === "waiting" || x.state === "failed");
      set("nm" + i, x.name); set("md" + i, model(x.model));
      html("st" + i, stateLine(x, now)); html("kd" + i, x.kind === "bg" ? `<span class="tag">bg</span>` : "");
      // A session has no context reading until its first turn lands (2026-11-05: 220 of
      // 745 live lines); x.ctx_pct.toFixed threw and stopped the whole render mid-line.
      const hasCtx = x.ctx_pct != null && x.ctx_tokens != null;
      set("cx" + i, hasCtx ? `${F.tokens(x.ctx_tokens)} of ${x.ctx_window >= 1e6 ? x.ctx_window / 1e6 + "M" : F.tokens(x.ctx_window || 0)}, ${x.ctx_pct.toFixed(0)} %` : "no reading yet");
      const cbt = `scaleX(${hasCtx ? (Math.min(100, x.ctx_pct) / 100).toFixed(3) : 0})`, cb = $("cb" + i);
      if (cb._t !== cbt) { cb._t = cbt; cb.style.transform = cbt; }
      const a = mine(x);
      html("o15" + i, x.out_15m > 0 ? `<span style="color:var(--ink)">${F.tokens(x.out_15m)}</span> out in 15 min` : "nothing out in 15 min");
      set("cm" + i, x.cpu == null ? "cpu –" : `cpu ${x.cpu.toFixed(1)} %, ${x.rss == null ? "–" : F.bytes(x.rss)}`);
      // by content: out_per_min is a fresh array on every line, so an identity test would
      // rebuild every chart on every line
      if (!sameNums(x.out_per_min, box._opm)) { box._opm = x.out_per_min; html("sp" + i, hourChart(x.out_per_min || [], 274, SCH, false)); }
      // the agents row is the label of the agents jack: how many, in the slot's ink; who
      // they are and what they were asked is on their rows in Agents, at the cords' far ends
      html("sag" + i, a.length ? `${glyph("a", "▲")}<span style="color:var(--ink)">${a.length}</span> agent${a.length === 1 ? "" : "s"} out` : `${glyph("idle", "△")}no agents out`);
      // the hour's total and share are in This hour's key; a silent hour says so here
      set("pk" + i, x.hourSum > 0 ? "" : "nothing this hour");
      wireKey += `${i}:${x.sid}:${x.state}:${x.hourSum}:${a.map((g) => g.id).join("+")};`;
      // tokens landing: the minute in progress steps once per response; each step is one
      // pulse down the output cord, sized by the response (a new minute starts from zero)
      const min = Math.floor(now / 60), o59 = (x.out_per_min || [])[59] || 0, base = box._min === min && box._sid === x.sid ? box._o59 : 0;
      if (box._min != null && box._sid === x.sid && o59 > base) pulse("out" + i, dotSize(o59 - base));
      box._min = min; box._o59 = o59; box._sid = x.sid;
    });
    if (STRESS) cordEls.forEach((_, id) => pulse(id, 8));

    // the cord list is rebuilt only when a relation changes: a slot's occupant, state or
    // hour total, who is out, the events block, who is waiting
    const nyList = waiting.concat(failed).slice(0, 2);
    const evList = c.events.slice(-LOG_ROWS).reverse();
    const ckey = wireKey + "|" + ag.map((g) => g.id).join(",") + "|" + (c.events === wires._ev ? "e" : "E" + now) + "|" + nyList.map((x) => x.sid).join(",");
    if (ckey !== wires._key) {
      wires._key = ckey; wires._ev = c.events;
      const cords = []; let lanes = 0;
      bySlot.forEach((x, i) => {
        if (!x) return;
        const y0 = SLOT_Y[i], ink = SLOT_INK[i], share = allOut > 0 ? x.hourSum / allOut : 0, a = mine(x);
        const oy = y0 + S_JACKS[1], hy = HERO.y + H_JACKS[i];
        cords.push({ id: "out" + i, kind: "out", ink, w: x.hourSum > 0 ? 4 + 6 * share : 3, path: curve(JX0, oy, JX1, hy), jacks: [[JX0, oy], [JX1, hy]] });
        // agents: the slot's agents jack (a mult) <-> each of its agents' rows in Agents
        const ya = y0 + S_JACKS[2];
        a.forEach((g) => { const j = agShown.indexOf(g); if (j < 0) return; const yb = AGT.y + A_JACKS[j]; cords.push({ id: "ag:" + g.id, kind: "agent", ink, w: 3, path: curve(JX0, ya, JX1, yb), jacks: [[JX0, ya], [JX1, yb]] }); });
        // needs you: the state row <-> this session's Needs-you row, through the C1/C2
        // gutter, lanes at a 4-pt pitch from 338 inward
        const ni = nyList.indexOf(x);
        if (ni >= 0) { const ya = y0 + 48, yb = B.allow.y + 48 + 40 * ni, lx = 338 - 4 * lanes++; cords.push({ id: "ask:" + x.sid, kind: "ask", ink: "var(--alert)", w: 3, path: duct([[SLOT.x, ya], [lx, ya], [lx, yb], [C1.x + C1.w, yb]]), jacks: [[SLOT.x, ya], [C1.x + C1.w, yb]] }); }
      });
      // the Log: each run of consecutive rows from one slotted session is one cord from that
      // slot's header jack to the run's first row. Keyed by the run's newest event, so a new
      // row pulses its cord.
      const runs = [];
      evList.forEach((e, j) => { const r = runs[runs.length - 1]; if (r && r.sid === e.sid) r.j1 = j; else runs.push({ sid: e.sid, j0: j, j1: j, t: e.t }); });
      runs.forEach((r) => {
        if (!slotIx.has(r.sid)) return;
        const i = slotIx.get(r.sid), ya = SLOT_Y[i] + S_JACKS[0], yb = LOGB.y + L_JACKS[r.j0];
        cords.push({ id: `log:${r.sid}:${r.t}`, kind: "log", ink: SLOT_INK[i], w: 3, path: curve(JX0, ya, JX1, yb), jacks: [[JX0, ya], [JX1, yb]] });
      });
      drawCords(cords);
    }
    // needs you: the lamp lights. The asks are the body, so the header does not count
    // them; it says when the last one was answered, and how many more wait than fit
    el.allow.classList.toggle("alert", needs > 0);
    if (c.events !== (prev && prev.claude.events) || !el.allow._ev) {
      el.allow._ev = true;
      const ans = c.events.slice().reverse().find((e) => e.kind === "answered");
      el.allow._ans = ans ? "last answered " + F.clock(ans.t) : "";
    }
    set("m-allow", [needs > 2 ? `+${needs - 2} more` : "", el.allow._ans].filter(Boolean).join(", "));
    // the feed's ask: {kind: "permission" | "question", tool, text, n}
    const askText = (x) => {
      const a = x.ask;
      if (x.state === "failed") return (a && a.text) || "the last turn ended in an error";
      if (typeof a === "string") return a;
      if (a && a.kind === "permission") return `permission: ${a.tool || "a tool"}${a.text ? ", " + a.text : ""}`;
      if (a && a.kind === "question") return `question${a.text ? ": " + a.text : ""}`;
      return (a && a.text) || "a question is open";
    };
    // two asks fit, each on two rows: who (glyph and name), then what is asked. How long it
    // has waited is the session plate's state row, at the ask cord's other end; a session
    // on the designation strip has no plate, so its row keeps the time.
    const since = (x) => x.state === "failed" ? "failed " + F.clock(x.last_activity || x.since) : "waiting " + short(now - askedAt(x));
    const nyRows = nyList.map((x) => `<div class="r"><span class="k" style="color:var(--ink);font-size:13px">${glyph("alert", x.state === "failed" ? "✕" : "●")}${esc(x.name)}</span></div><div class="r"><span class="k" style="padding-left:12px">${slotIx.has(x.sid) ? "" : since(x) + ", "}${esc(askText(x))}</span></div>`).join("");
    // the 14-day ask record: one line under the asks, or three rows when nothing waits
    if (A && (A !== (prev && prev.analytics) || !el.allow._aw)) {
      const aw = A.ask_wait; el.allow._aw = aw && aw.count ? [String(aw.count), short(aw.median_s), F.span(aw.max_s).replace(/ \d+ m$/, "")] : ["0", "–", "–"];
    }
    const aw = el.allow._aw || ["–", "–", "–"];
    const rec = (k, v) => `<div class="r"><span class="k">${k}</span><span class="n" style="width:80px">${v}</span></div>`;
    html("nyBody", needs
      ? `<div style="height:80px">${nyRows}</div><div class="lbl" style="margin-top:4px;font-size:11px;line-height:16px">${aw[0]} asks in 14 days, median wait ${aw[1]}, longest ${aw[2]}</div>`
      : `<div class="r" style="height:40px;line-height:36px"><span class="k" style="font-size:16px;color:var(--ink)">Nothing is waiting on you</span></div>${rec("asks in 14 days", aw[0])}${rec("median wait", aw[1])}${rec("longest wait", aw[2])}`);

    // the week
    const L = c.limits && c.limits.seven_day;
    if (L) {
      nums.wkPct.set(L.pct);
      set("m-week", `resets in ${F.until(L.resets_at, now).replace(/ \d+ m$/, "")}`);
      set("bnRate", L.burn_per_h == null ? "–" : L.burn_per_h.toFixed(1) + " %/h");
      const fc = L.resets_at - 7 * 86400 + 12 * 3600;
      set("bnFc", L.pace == null ? "from " + new Date(fc * 1000).toLocaleDateString("en-US", { weekday: "short" }) + " " + F.clock(fc) : L.runout_at ? "runs out " + F.date(L.runout_at) : `${Math.round(L.projected)} % by the reset`);
      if (c.limits !== (prev && prev.claude.limits) || !el.week._drawn) { el.week._drawn = true; weekChart(L, c.limits, now, WKH); }
      // the 5-hour window no longer exists on this account (Ultra, 2026-10-30): if Claude
      // Code ever reports one again, it takes the last row in place; the box never changes.
      // The value box holds a percentage only, so the label always has 172 pt.
      const fh = c.limits.five_hour, fhOn = !!(fh && fh.pct != null && !fh.stale);
      set("wkPrevK", fhOn ? "5-hour window" + (fh.resets_at ? `, resets ${F.clock(fh.resets_at)}` : "") : "last week ended at");
      set("wkPrev", fhOn ? `${Math.round(fh.pct)} %` : weekChart.prev != null ? Math.round(weekChart.prev) + " %" : "–");
    }

    // this Mac
    nums.cpu.set(sys.cpu); set("m-mac", "load " + sys.load.map((v) => v.toFixed(2)).join(", "));
    sys.cores.forEach((v, i) => { if (cores.children[i]) cores.children[i].firstChild.style.transform = `scaleY(${Math.pow(v / 100, 0.7).toFixed(3)})`; });
    const m = sys.mem, GB = (b) => (b / 1073741824).toFixed(1);
    nums.mem.set(m.used); set("mePr", m.pressure); set("swap", "swap " + GB(sys.swap) + " GB");
    html("meStack", `<i style="width:${(m.wired / m.total * 100).toFixed(1)}%;background:var(--m1)"></i><i style="width:${(m.active / m.total * 100).toFixed(1)}%;background:var(--m2)"></i><i style="width:${(m.compressed / m.total * 100).toFixed(1)}%;background:var(--m3)"></i>`);
    html("meLeg", `<span><i style="background:var(--m1)"></i>wired ${GB(m.wired)}</span><span><i style="background:var(--m2)"></i>active ${GB(m.active)}</span><span><i style="background:var(--m3)"></i>compressed ${GB(m.compressed)}</span>`);
    set("dk", `${Math.round(sys.disk.free / 1e9)} of ${Math.round(sys.disk.total / 1e9)} GB`);
    set("dkIo", `${F.rate(sys.disk.read_bps)}, ${F.rate(sys.disk.write_bps)}`);
    html("tops", (sys.top_cpu || []).slice(0, 5).map(([nm, v]) => `<div class="r"><span class="k mono">${esc(nm)}</span><span class="n" style="width:64px">${v.toFixed(1)} %</span></div>`).join(""));

    // the Dock strips
    const b = sys.batt;
    ringSet("btR", b.pct / 100, String(b.pct));
    set("btL", b.charging ? "charging" : b.ac ? "on power" : b.mins_left ? short(b.mins_left * 60) : "battery");
    $("rxM").style.transform = `scaleY(${meter(sys.net.rx_bps).toFixed(3)})`; $("txM").style.transform = `scaleY(${meter(sys.net.tx_bps).toFixed(3)})`;
    set("rxL", kb(sys.net.rx_bps)); set("txL", kb(sys.net.tx_bps));
    ringSet("gpuR", sys.gpu / 100, Math.round(sys.gpu) + "%");

    // weather
    const w = s.weather;
    if (w !== (prev && prev.weather) || !el.weather._painted) {
      el.weather._painted = true;
      paintWeather(w);
      if (w) {
        set("m-weather", "observed " + ago(w.observed_at, now));
        set("wxFeels", `${F.temp(w.feels_c)}, ${w.humidity} %`);
        const mph = Kiln.tempUnit === "F";
        set("wxWind", `${F.wind ? F.wind(w.wind_kmh) : `${Math.round(mph ? w.wind_kmh * 0.621371 : w.wind_kmh)} ${mph ? "mph" : "km/h"}`} from ${w.wind_dir}°`);
        set("wxSun", `${F.clock(w.sunrise)} to ${F.clock(w.sunset)}`);
      } else { set("m-weather", "offline since " + F.clock(prev && prev.weather ? prev.weather.observed_at : now)); set("wxFeels", "–"); set("wxWind", "–"); set("wxSun", "–"); }
    }

    // this hour's figures, today's totals
    if (T) {
      const opm = T.out_per_min || [];
      nums.hLast.set(opm[opm.length - 2] || 0); nums.hNow.set(opm[opm.length - 1] || 0);
      if (T.today) { nums.tdOut.set(T.today.out); nums.tdCalls.set(T.today.calls); }
    }

    // agents out now, one line each in slot order (the cord lands on its row); the sixth
    // row turns into "+k more" when more are out. Empty, it says so and names the last one back.
    let agHtml;
    if (ag.length) {
      agHtml = agShown.map((a) => agentLine(a, inkOf(a.sid), 120, slotIx.has(a.sid) ? null : `<span style="color:var(--ink)">${esc(a.session)}</span>, ${esc(a.desc) || "started " + F.clock(a.started)}`)).join("") + (ag.length > AG_ROWS ? moreLine(ag.slice(AG_ROWS - 1), 120) : "");
    } else {
      const back = c.events.slice().reverse().find((e) => e.kind === "agent_done");
      const bm = back && (back.detail || "").match(/^([^:]+):?\s*(.*)$/);
      agHtml = `<div class="agr"><span class="k" style="width:auto">No agents out</span></div>` + (back ? `<div class="agr"><span class="d">the last came back at ${F.clock(back.t)}: ${esc(bm && bm[1] ? bm[1].trim() : "agent")}${bm && bm[2] ? ", " + esc(bm[2]) : ""}</span></div>` : "");
    }
    html("agNow", agHtml);
    if (A && (A !== (prev && prev.analytics) || !el.today._a)) {
      el.today._a = true;
      const AT = Object.assign({}, (A.agent_tokens && A.agent_tokens.today) || {}), SP = (A.spawns && A.spawns.today) || {}, D14 = (A.spawns && A.spawns.d14) || {};
      // types seen in the fortnight but silent today keep their row, with dashes: the roster is the roster
      for (const k in D14) if (!AT[k]) AT[k] = { out: 0, cache_read: 0, calls: 0 };
      const all = Object.entries(AT).sort((a, b) => b[1].out - a[1].out || (D14[b[0]] || 0) - (D14[a[0]] || 0)), rows = all.slice(0, 6);
      const name = (k) => k === "main" ? "main threads" : k;
      // who is out now is the rows themselves (and "+k more"), so the header does not count them
      set("m-agents", `${F.int(sum(Object.values(SP)))} spawned today, ${F.int(sum(Object.values(D14)))} in 14 days`);
      html("agRows", rows.map(([k, v]) => `<tr><td>${esc(name(k))}</td><td>${v.out ? F.tokens(v.out) : "–"}</td><td>${k === "main" ? "–" : F.int(D14[k] || 0)}</td></tr>`).join(""));
    }
    if (A && (A !== (prev && prev.analytics) || d.getHours() !== el.today._hr)) { el.today._hr = d.getHours(); dial(A, now); }
    if (A && A !== (prev && prev.analytics)) {
      // the header names how many prompts he typed today; the tokens by model are the
      // fortnight's last column (its legend names the models), so they are not repeated here
      set("m-today", A.prompts ? `${F.int(A.prompts.today)} prompt${A.prompts.today === 1 ? "" : "s"}` : "");
      html("tdFl", (A.fails && A.fails.today > 0 ? glyph("alert", "✕") : "") + F.int((A.fails && A.fails.today) || 0));
      set("tdHit", A.cache_hit_pct ? A.cache_hit_pct.today.toFixed(1) + " %" : "–");
      const ds = (A.days || []).slice(-14);
      // 14 days by model, stacked on a baseline: Opus white at the foot, Fable gold, the rest grey
      const dmx = Math.max(1, ...ds.map((x) => x.out));
      const models = {}; ds.forEach((x) => { for (const k in x.by_model) models[k] = (models[k] || 0) + x.by_model[k]; });
      const rk = (k) => /opus/.test(k) ? 0 : /fable/.test(k) ? 1 : 2;
      ds.forEach((x, i) => {
        let acc = 0, h = "", rest = 0;
        const parts = Object.entries(x.by_model || {}).filter(([k]) => rk(k) < 2).sort((a, b) => rk(a[0]) - rk(b[0]));
        for (const [k, v] of Object.entries(x.by_model || {})) if (rk(k) === 2) rest += v;
        rest += Math.max(0, x.out - sum(Object.values(x.by_model || {})));
        for (const [v, ink] of parts.map(([k, v]) => [v, modelInk(k)]).concat([[rest, "var(--idle)"]])) { if (v <= 0) continue; const hh = Math.max(1, Math.round(v / dmx * (BH - 1))); h += `<b style="height:${hh}px;bottom:${acc}px;background:${ink};transform:none"></b>`; acc += hh; }
        if (dBars.children[i]) dBars.children[i].innerHTML = h;
      });
      set("m-fort", F.tokens(sum(ds.map((x) => x.out))) + " tokens out");
      if (ds[0]) set("dFrom", new Date(ds[0].date + "T12:00:00").toLocaleDateString("en-US", { day: "numeric", month: "short" }));
      const named = Object.entries(models).filter(([k]) => rk(k) < 2).sort((a, b) => rk(a[0]) - rk(b[0])), others = sum(Object.entries(models).filter(([k]) => rk(k) === 2).map((x) => x[1]));
      html("dLeg", named.map(([k, v]) => `<span><i style="background:${modelInk(k)}"></i>${model(k)} ${F.tokens(v)}</span>`).join("") + (others > 0 ? `<span><i style="background:var(--idle)"></i>others ${F.tokens(others)}</span>` : ""));
      // the hours of the week: each cell is the average of that weekday-hour over the
      // fortnight (the feed's hour_matrix is the SUM of the two same weekdays). The header
      // names the busiest single hour from the daily records, the Today dial's scale.
      const HM = A.hour_matrix, wdN = [0, 0, 0, 0, 0, 0, 0];
      if (HM) {
        ds.forEach((x) => { wdN[(new Date(x.date + "T12:00:00").getDay() + 6) % 7]++; });
        const avg = HM.out.map((r, ri) => r.map((v) => v / Math.max(1, wdN[ri]))), hmx = Math.max(1, ...avg.flat());
        let r = "";
        HM.rows.forEach((lab, ri) => {
          r += `<text x="0" y="${(ri * 10.5 + 8.5).toFixed(1)}" style="font-size:10px">${lab}</text>`;
          avg[ri].forEach((v, ci) => { r += `<rect id="hc${ri}_${ci}" x="${(30 + ci * 19.5).toFixed(1)}" y="${(ri * 10.5).toFixed(1)}" width="18.5" height="9.5" fill="${RAMP[level(v, hmx)]}"/>`; });
        });
        html("heat", r); $("heat")._now = null;
      }
      let best = null; ds.forEach((x) => (x.hours || []).forEach((v, h) => { if (!best || v > best.v) best = { v, h, date: x.date }; }));
      set("m-hours", best && best.v > 0 ? `busiest hour ${F.tokens(best.v)}, ${new Date(best.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })}, ${hourName(best.h)}` : "no hourly record");
    }
    { const heat = $("heat"), ri = (d.getDay() + 6) % 7, ci = d.getHours(), key = ri + "_" + ci; if (heat.children.length && key !== heat._now) { if (heat._now) { const o = $("hc" + heat._now); if (o) o.removeAttribute("stroke"); } const e = $("hc" + key); if (e) { e.setAttribute("stroke", "var(--ink)"); e.setAttribute("stroke-width", "1"); } heat._now = key; } }

    // log: the one event stream, 13 rows, one per jack. Each row carries its slot's ink as a
    // stripe beside its jack (a run reads as one bar, and the slot's cord lands on its
    // first row). A session without a slot has no ink and no cord, so its rows print its
    // name where it changes from the row above.
    const slotKey = bySlot.map((x) => x ? x.sid : "-").join(",");
    if (c.events !== (prev && prev.claude.events) || slotKey !== el.today._sk) {
      el.today._sk = slotKey;
      let last = null;
      html("logRows", evList.length ? evList.map((e) => { const ink = inkOf(e.sid), nm = !ink && e.name !== last; last = e.name; return `<div class="e"${ink ? ` style="--pk:${ink}"` : ""}><i class="k"></i><span class="t">${F.clock(e.t)}</span><span class="s">${what(e)}</span>${nm ? `<span class="nm">${esc(e.name)}</span>` : ""}</div>`; }).join("") : `<div class="e"><i class="k"></i><span class="s" style="color:var(--sec)">No events yet today</span></div>`);
      set("m-log", `last ${evList.length} of ${c.events.length}`);
    }

    // GitHub: the year as a grid, and the figures
    if (s.github !== (prev && prev.github) || !el.github._painted) {
      el.github._painted = true;
      const g = s.github;
      if (g) {
        const rec = (g.recent || [])[0];
        set("m-github", `${g.login}, ${F.int(g.total_year)} in a year`);
        // the last 52 weeks: 51 full ones from a Sunday, then this week so far
        const dow = new Date(g.days[g.days.length - 1][0] + "T12:00:00").getDay();
        const days = g.days.slice(-(51 * 7 + dow + 1)), first = new Date(days[0][0] + "T12:00:00");
        let col = 0, rw = first.getDay(), out = "";
        for (const [, cnt] of days) { const k = cnt === 0 ? 0 : cnt < 8 ? 1 : cnt < 17 ? 2 : cnt < 45 ? 3 : 4; out += `<rect x="${(col * CALP).toFixed(1)}" y="${(rw * CALP).toFixed(1)}" width="4.9" height="4.9" fill="var(--gh${k})"/>`; if (++rw === 7) { rw = 0; col++; } }
        html("cal", out);
        set("calFrom", first.toLocaleDateString("en-US", { month: "short", year: "numeric" }) + " to now" + (rec ? `, ${VERB[rec.type] || rec.type.replace(/Event$/, "").toLowerCase()} ${ago(rec.at, s.t)}` : ""));
        set("calBest", g.best ? `best day ${g.best[1]}, ${new Date(g.best[0] + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "");
        set("ghT", `${g.today}, ${g.week}, ${g.streak} d`);
        set("ghY", `${F.int(g.commits_year)} commits, ${F.int(g.prs_year)} PRs, ${F.int(g.issues_year)} issues`);
      } else { set("m-github", "offline"); html("cal", `<rect x="0" y="0" width="286" height="38" fill="var(--e)"/><text x="8" y="23">no calendar: GitHub is offline</text>`); set("calFrom", "–"); set("calBest", ""); set("ghT", "–"); set("ghY", "–"); }
    }
  }

  // ---------- dev only: inject states the fixture lacks ----------
  // ?busy[=4|7] adds running agents, a waiting and a failed session (7 sessions, 9 agents
  // by default); ?empty drops sessions, weather and GitHub; ?weather=kind&day=1 forces the
  // sky; ?n=k keeps the first k sessions (0 works). Shallow copies only, so the sticky
  // blocks keep their identity.
  function inject(s) {
    const c = s.claude, now = s.t;
    let ss = c.sessions.map((x) => Object.assign({}, x)), agents = c.agents_running || [];
    if (q.has("busy")) {
      agents = [];
      const nb = +q.get("busy") || 7;
      const spawn = (x, type, age, desc) => { agents.push({ id: x.sid + ":" + agents.length, sid: x.sid, session: x.name, type, desc: desc || "", started: now - age, age_s: age, idle_s: 0 }); x.agents_running = (x.agents_running || 0) + 1; };
      const clone = (src, name, sid) => Object.assign({}, src, { name, sid, agents_running: 0 });
      const extra = ["atlas-api", "docs-site", "billing-migration", "design-system", "data-pipeline"];
      while (ss.length < nb) ss.push(clone(ss[ss.length % Math.max(1, c.sessions.length)], extra[ss.length % extra.length], "busy-" + ss.length));
      ss = ss.slice(0, nb);
      ss[0].agents_running = 0; spawn(ss[0], "general-purpose", 412, "Survey the jack patents"); spawn(ss[0], "researcher", 196, "Cite the 1898 patent"); spawn(ss[0], "tester", 71, "Run the geometry gate");
      if (ss[1]) { ss[1].state = "waiting"; ss[1].kind = "interactive"; ss[1].last_activity = now - 420; ss[1].ask = { kind: "permission", tool: "Bash", text: "git push origin main" }; }
      if (ss[2]) { ss[2].state = "failed"; ss[2].kind = "interactive"; ss[2].last_activity = now - 1310; ss[2].ask = { text: "API error 529, the turn did not finish" }; }
      if (ss[3]) { ss[3].state = "background"; ss[3].agents_running = 0; ss[3].out_15m = 18420; ss[3].out_per_min = ss[3].out_per_min.map((v, i) => i > 40 ? 900 + (i * 137) % 700 : v); spawn(ss[3], "designer", 1330, "Patchbay v5 plates"); spawn(ss[3], "builder", 88); }
      if (ss[4]) { ss[4].state = "working"; ss[4].kind = "interactive"; ss[4].agents_running = 0; ss[4].out_15m = 9120; ss[4].out_per_min = ss[4].out_per_min.map((v, i) => (i * 97) % 11 < 6 ? 300 + (i * 211) % 900 : 0); spawn(ss[4], "critic", 240); spawn(ss[4], "critic", 238); spawn(ss[4], "reviewer", 1020); }
      if (ss[5]) { ss[5].state = "idle"; ss[5].kind = "bg"; }
      if (ss[6]) { ss[6].state = "background"; ss[6].kind = "bg"; ss[6].out_15m = 2210; ss[6].out_per_min = ss[6].out_per_min.map((v, i) => i > 50 ? 150 + (i * 53) % 300 : 0); }
    }
    if (q.has("n")) { ss = ss.slice(0, +q.get("n")); agents = agents.filter((g) => ss.some((x) => x.sid === g.sid)); }
    if (q.has("quiet")) { ss.forEach((x) => { x.state = "idle"; x.agents_running = 0; x.ask = null; }); agents = []; }
    const copy = Object.assign({}, s); copy.claude = Object.assign({}, c, { sessions: ss, agents_running: agents });
    if (q.has("empty")) { copy.claude.sessions = []; copy.claude.agents_running = []; copy.weather = null; copy.github = null; copy.claude = Object.assign({}, copy.claude, { limits: Object.assign({}, c.limits, { five_hour: Object.assign({}, c.limits.five_hour, { stale: true }) }) }); }
    if (q.get("weather") && copy.weather) copy.weather = Object.assign({}, copy.weather, { kind: q.get("weather"), text: q.get("weather"), is_day: q.has("day") ? q.get("day") === "1" : copy.weather.is_day });
    else if (q.has("day") && copy.weather) copy.weather = Object.assign({}, copy.weather, { is_day: q.get("day") === "1" });
    return copy;
  }
  const dev = q.has("busy") || q.has("weather") || q.has("empty") || q.has("day") || q.has("n") || q.has("quiet");
  Kiln.on((s, prev) => render(dev ? inject(s) : s, prev));

  // ---------- the ground: the plate behind the live middle ----------
  // Scribner's 1898 switchboard-jack sheet (US 596,625, "Plug and Spring Jack for
  // Telephone Switchboards", public domain): the patent of the jack these cords plug
  // into, placed once (x 370-1136, centred on the channel) and never touched again. The
  // slots and the jackfield are smoked acrylic over it; the channel shows it at full
  // strength between the cords, and so does an unpatched slot's socket hole.
  const ground = $("ground"), img = document.createElement("img");
  img.src = "ground.png"; img.alt = ""; ground.appendChild(img);

  const per = $("per"), dot = $("dot");
  per.textContent = String(Kiln.period);
  Kiln.onPeriod((ms) => { per.textContent = String(ms); per.classList.add("hi"); setTimeout(() => per.classList.remove("hi"), 1500); });
  Kiln.onBeat(() => { dot.style.opacity = 1; setTimeout(() => { dot.style.opacity = 0.5; }, 300); });
  // the only preference this design reads is the temperature unit: repaint the sky text
  Kiln.onPrefs(() => { if (Kiln.state) { el.weather._painted = false; render(dev ? inject(Kiln.state) : Kiln.state, null); } });
  document.fonts.ready.then(() => { if (Kiln.state) { el.weather._painted = false; render(dev ? inject(Kiln.state) : Kiln.state, Kiln.state); } });
})();
