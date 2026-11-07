// ledger.js: The Ledger, live.
//
// Every figure on the page is computed from Kiln.state on every line, and "now" is
// state.t. This is the round-2 build_data.py ported to the page: month totals,
// medians, shares, countdowns and labels are all derived here, never typed.
//
// How things move (the performance recipe, docs/designing.md):
//   - figures are written once per line. They glide (Kiln.num) only where Kiln.glide
//     allows it, at 400 ms and slower, so text never repaints frame by frame;
//   - bars, the memory bar and chart scroll are sprites: small SVGs of their own,
//     moved by one transform per line with a transition of var(--kiln-tween). The
//     compositor moves them and nothing repaints;
//   - charts redraw once per line, never per frame;
//   - a headline re-sets, revealed like a line being set, only when its wording
//     changes; the figures inside it change in place;
//   - tables are keyed by sid, agent id and repository, in boxes of fixed slots, so
//     rows enter, leave and reorder without moving the page;
//   - one-off effects (a row arriving, a headline being set, the pulse) are Web
//     Animations, which the browser runs off the runtime's frames;
//   - the edition re-inks at the real sunset and sunrise, on Kiln.loop.
// Nothing here runs a timer or its own animation frame.
(function () {
  "use strict";
  const K = window.Kiln, F = K.fmt;
  const CFG = Object.assign({ edition: "auto", layout: "daily", fade_s: 8, weather_motion: true }, window.LEDGER_CONFIG || {});
  const Q = new URLSearchParams(location.search);
  const NS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  // Every figure is tabular (the stylesheet sets it page-wide, and fonts/ carries a
  // Schibsted whose tnum covers the digits only). A figure that changes sits in a box
  // whose width does not depend on its text: a table cell, a slot, or a fixed board.

  // ---------- formatting ----------
  const GB = 2 ** 30;
  const NF = new Intl.NumberFormat("en-US");   // one formatter: toLocaleString builds one per call
  const int = (v) => NF.format(Math.round(v));
  const fx = (d, suffix = "") => (v) => v.toFixed(d) + suffix;
  const si = (n) => {
    const a = Math.abs(n);
    return a >= 1e9 ? (n / 1e9).toFixed(3) + "bn" : a >= 1e6 ? (n / 1e6).toFixed(2) + "m"
      : a >= 1e3 ? (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k" : String(Math.round(n));
  };
  const rate = (b) => (b >= 1e6 ? (b / 1e6).toFixed(1) + " MB/s" : b >= 1e3 ? Math.round(b / 1e3) + " kB/s" : Math.round(b) + " B/s");
  const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const word = (n) => WORDS[n] || String(n);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, a) => (n === 1 ? a : a + "s");
  const local = (t) => new Date(t * 1000);
  const hourLbl = (h) => (h % 12 || 12) + (h < 12 ? " am" : " pm");
  const clockShort = (t) => { const d = local(t), m = d.getMinutes(); return (d.getHours() % 12 || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (d.getHours() < 12 ? " am" : " pm"); };
  const dayShort = (t) => { const d = local(t); return d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.getDate() + " " + d.toLocaleDateString("en-US", { month: "short" }); };
  const isoDay = (t) => { const d = local(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const sameDay = (a, b) => isoDay(a) === isoDay(b);
  const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
    FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
    ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
    NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
    OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
    UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "Washington, D.C." };
  const placeLong = (p) => p.replace(/,\s*([A-Z]{2})$/, (m, st) => ", " + (STATES[st] || st));

  // ---------- DOM helpers: write only what changed ----------
  function text(e, s) { if (e.__t !== s) { e.__t = s; e.textContent = s; } }
  function attr(e, k, v) { const c = e.__a || (e.__a = {}); if (c[k] !== v) { c[k] = v; e.setAttribute(k, v); } }
  function svg(tag, a, parent) { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (parent) parent.appendChild(e); return e; }
  // A live figure. Kiln.num sets it directly below 400 ms and glides it above; a
  // missing value is written once, not again on every line.
  function num(e, fmt) {
    const n = K.num(e, { fmt });
    let blank = false;
    return { set(v) { const b = v == null || !isFinite(v); if (!(b && blank)) n.set(v); blank = b; } };
  }
  // A one-off effect as a Web Animation: the browser runs it (on the compositor for
  // opacity and transform), so it costs the runtime no frames. null under reduced motion.
  const OUT = "cubic-bezier(.33,1,.68,1)";   // the runtime's cubic ease-out
  const play = (el, frames, ms, ease) => (K.reduced || !el.animate ? null : el.animate(frames, { duration: ms, easing: ease || OUT }));
  // A long, rare change (the edition's re-inking): Kiln.tween is clamped to part of a
  // period, so this runs on Kiln.loop. It pauses with the wallpaper and always lands.
  // Returns a stop function, so a re-inking can be cut short by the next one.
  function slow(ms, fn) {
    if (K.reduced || !(ms > 0)) { fn(1); return () => {}; }
    let t = 0;
    const stop = K.loop((_, dt) => { t += dt * 1000; const k = Math.min(1, t / ms); fn(k); if (k >= 1) stop(); }, { fps: 20 });
    return stop;
  }
  // A sprite: a small SVG of its own over a chart, in the chart's coordinates (its
  // viewBox is the region it covers). It moves by CSS transform, transitioned over
  // var(--kiln-tween), so the compositor moves it and nothing repaints.
  function sprite(box, x, y, w, h, inner) {
    const e = svg("svg", { class: "spr", width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` }, box);
    e.style.left = x + "px"; e.style.top = y + "px";
    e.innerHTML = inner;
    return e;
  }
  function tf(e, s) { if (e.__tf !== s) { e.__tf = s; e.style.transform = s; } }
  const px = (v) => (Math.round(v * 2) / 2).toFixed(1);   // whole device pixels, for crisp text
  const r1 = (v) => Math.round(v * 10) / 10;
  let REM = 16;
  function fit(el, h) {
    const w = Math.round(el.clientWidth || el.parentNode.clientWidth);
    el.setAttribute("viewBox", `0 0 ${w} ${h}`); el.setAttribute("height", h);
    return w;
  }
  // monotone cubic through points, so a curve never overshoots its data
  function mono(p) {
    const n = p.length;
    if (n < 2) return n ? `M${p[0][0]} ${p[0][1]}` : "";
    const dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0] || 1e-6; m[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
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
  }
  // tween a whole array of values, only where Kiln.glide allows it (a rare redraw)
  function glide(key, from, to, apply) {
    if (!from || from.length !== to.length || !K.glide) { apply(to); return; }
    K.tweenKey(key, 0, 1, (k) => apply(to.map((b, i) => from[i] + (b - from[i]) * k)));
  }

  // ---------- a headline or deck: re-set on new wording, figures change in place ----------
  // parts: "text" (structure; "\n" breaks), {s, b} (structural, bold), {k, v, f, b, tail}
  // (a live figure), {k, t, b} (live text that changes in place, e.g. an age), {g} (a
  // drawn glyph from GLYPHS).
  // A figure changes in place only while it keeps its width: its digits are tabular, so
  // that is while its shape ("0,000") holds. A new shape (9 to 10) re-sets the line like
  // new wording, rather than shoving the words after it sideways. A tail figure ends
  // the line, unit included, so nothing follows it to shove: it always changes in
  // place. That is the place for a figure that changes every line.
  const shapeOf = (p) => {
    if (p.tail) return "";
    if (!("v" in p)) return String(p.t).replace(/\d/g, "0");
    return p.v == null || !isFinite(p.v) ? "–" : (p.f || int)(p.v).replace(/\d/g, "0");
  };
  function Line(box) {
    let shape = null, cur = null, nums = {}, live = {}, gone = null;
    function build(parts) {
      const ln = document.createElement("span");
      ln.className = "ln";
      const n = {}, lv = {};
      for (const p of parts) {
        if (p && p.g) { ln.appendChild(GLYPHS[p.g]()); continue; }
        if (typeof p === "string") {
          p.split("\n").forEach((seg, i) => { if (i) ln.appendChild(document.createElement("br")); if (seg) ln.appendChild(document.createTextNode(seg)); });
          continue;
        }
        const e = document.createElement(p.b ? "b" : "span");
        if (p.k == null) e.textContent = p.s;
        else if ("v" in p) { n[p.k] = num(e, p.f || int); n[p.k].set(p.v); }
        else { lv[p.k] = e; text(e, p.t); }
        ln.appendChild(e);
      }
      return { ln, n, lv };
    }
    function fitLine(ln) {
      ln.style.fontSize = "";
      // too tall, or one word too wide to wrap ("Thunderstorm" beside the temperature)
      const max = box.clientHeight + 2, mw = box.clientWidth + 1;
      for (let i = 0, s = 1; i < 5 && (ln.offsetHeight > max || ln.scrollWidth > mw); i++) { s *= 0.93; ln.style.fontSize = s + "em"; }
    }
    return {
      set(parts) {
        // the line that lifted away goes once its fade is over (at rest it is already
        // transparent, so a late removal never shows)
        if (gone && performance.now() > gone.__until) { gone.remove(); gone = null; }
        const sh = parts.map((p) => (typeof p === "string" ? p : p.g ? "@" + p.g : (p.b ? "*" : "") + (p.k == null ? p.s : "#" + p.k + "=" + shapeOf(p)))).join("|");
        if (sh === shape) {
          for (const p of parts) if (typeof p === "object" && p.k != null) { if ("v" in p) nums[p.k].set(p.v); else text(live[p.k], p.t); }
          return;
        }
        shape = sh;
        const b = build(parts);
        nums = b.n; live = b.lv;
        const old = cur, ln = (cur = b.ln);
        if (gone) { gone.remove(); gone = null; }
        box.appendChild(ln);
        fitLine(ln);
        if (!old) return;
        // A re-set is rare, so it keeps its own pace whatever the period: the old line
        // lifts away over 350 ms while the new one is set left to right over 700 ms.
        // Both are Web Animations; neither costs the runtime a frame.
        old.classList.add("out");
        old.style.opacity = 0;
        if (!play(old, [{ opacity: 1 }, { opacity: 0 }], 350)) { old.remove(); return; }
        old.__until = performance.now() + 350;
        gone = old;
        play(ln, [{ clipPath: "inset(-.3em 100% -.3em -.2em)" }, { clipPath: "inset(-.3em 0% -.3em -.2em)" }], 700);
      },
      refit() { if (cur) fitLine(cur); },
    };
  }

  // ---------- a keyed table in a box of fixed slots ----------
  function KList(tbl, make) {
    const body = tbl.querySelector(".tb"), rows = new Map(), gone = [];
    let empty = null, emptyOn = null, first = true;
    const at = (y) => `translateY(${y.toFixed(2)}px)`;
    return {
      update(items, emptyText) {
        // departed rows are transparent at rest; they leave the DOM once their fade is over
        const now = performance.now();
        while (gone.length && gone[0].__until < now) gone.shift().remove();
        const seen = new Set(), rh = REM * 1.4;
        items.forEach((it, i) => {
          seen.add(it.key);
          let r = rows.get(it.key);
          const y = Math.round(i * rh * 100) / 100;
          if (!r) {
            r = make(it);
            r.el.classList.add("row");
            r.el.style.transform = at(y);
            r.y = y;
            body.appendChild(r.el);
            rows.set(it.key, r);
            // a new row fades in where it belongs (under 400 ms); nothing else moves
            if (!first) play(r.el, [{ opacity: 0 }, { opacity: 1 }], 380);
          } else if (r.y !== y) {
            // a reordered row slides to its new slot
            const from = r.y;
            r.y = y;
            r.el.style.transform = at(y);
            play(r.el, [{ transform: at(from) }, { transform: at(y) }], 320);
          }
          r.update(it);
        });
        for (const [key, r] of rows) {
          if (seen.has(key)) continue;
          rows.delete(key);
          // a finished row fades out in place
          r.el.style.opacity = 0;
          if (!play(r.el, [{ opacity: 1 }, { opacity: 0 }], 260)) { r.el.remove(); continue; }
          r.el.__until = now + 260;
          gone.push(r.el);
        }
        if (emptyText != null && !empty) { empty = document.createElement("div"); empty.className = "empty"; body.appendChild(empty); }
        if (empty) {
          text(empty, emptyText || "");
          const on = !items.length;
          if (on !== emptyOn) {
            empty.style.opacity = on ? 1 : 0;
            if (emptyOn != null) play(empty, [{ opacity: on ? 0 : 1 }, { opacity: on ? 1 : 0 }], 300);
            emptyOn = on;
          }
        }
        first = false;
      },
    };
  }
  const cell = (cls) => { const s = document.createElement("span"); if (cls) s.className = cls; return s; };
  // a figure cell: the value changes in place, and a change draws the "price moved"
  // rule, which fades over 2 s on the compositor
  function ncell(fmt, cls) {
    const el = cell(cls), v = document.createElement("span"), tk = document.createElement("i");
    tk.className = "tk"; v.className = "v";
    el.append(v, tk);
    const n = num(v, fmt);
    let last, fade = null;
    return {
      el, v,
      set(x) {
        // one rule per 2 s at most: a figure that changes every line (Out/min at 100 ms)
        // would otherwise restart the fade, and make the browser a new layer, each line
        if (last !== undefined && x !== last && !(fade && fade.playState === "running")) fade = play(tk, [{ opacity: 1 }, { opacity: 0 }], 2000, "linear");
        last = x; n.set(x);
      },
    };
  }

  // ======================================================================
  // the masthead
  // ======================================================================
  const earHed = Line($("earHed"));
  // the ear's lines hold about one character per half em of their face (Schibsted's
  // running text averages .47 em); CSS's ellipsis stays behind it as the backstop
  const EAR = { room: 60, breath: null, seen: false };
  const BLANK = " ";
  // The printer's fist (a manicule), drawn: neither face has U+261E, and a fallback face
  // would set it on another baseline. Cuff, hand and pointing finger, three curled
  // fingers, and the thumb cut out of the back of the hand.
  const GLYPHS = {
    fist() {
      const g = svg("svg", { class: "fist", viewBox: "0 1.4 23 11.6", "aria-hidden": "true" });
      svg("path", { "fill-rule": "evenodd", d: "M0 1.7h3v10.6H0z"
        + "M4 3.3c0-.5.4-.9.9-.9h16.6a1.35 1.35 0 0 1 0 2.7H12.6v6.9c0 .5-.4.9-.9.9H4.9c-.5 0-.9-.4-.9-.9z"
        + "M6.6 4.1c2.3.1 4.1.8 5.3 2l-.5.6c-1.1-1-2.9-1.7-4.8-1.8z"
        + "M13.3 5.8h2.7a1 1 0 0 1 0 2h-2.7z M13.3 8.5h2.4a.95 .95 0 0 1 0 1.9h-2.4z M13.3 11.1h1.9a.85 .85 0 0 1 0 1.7h-1.9z" }, g);
      return g;
    },
  };
  let lastDay = null;
  function mast(s) {
    const d = local(s.t);
    text($("clk"), (d.getHours() % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0"));
    text($("ap"), d.getHours() < 12 ? "am" : "pm");
    const day = isoDay(s.t);
    if (day !== lastDay) {
      lastDay = day;
      text($("dateLong"), `${d.toLocaleDateString("en-US", { weekday: "long" })} ${d.getDate()} ${d.toLocaleDateString("en-US", { month: "long" })} ${d.getFullYear()}`);
    }
    const place = s.weather && s.weather.place ? ", " + placeLong(s.weather.place) : "";
    // named by the real light, as the plate is drawn (sunEdition), never by the forced
    // appearance: "Night edition" at 3:55 pm in daylight was the dark look being named
    text($("edName"), `${sunEdition(s) === "night" ? "Night" : "Day"} edition${place}`);
    // the ear: what needs him. Calm, it is type on the paper; a waiting or failed session
    // sends it to press (index.html). Three rows beside the head, each cut to the room the
    // ear has (EAR.room, read in measure()).
    const sess = s.claude.sessions || [], ear = $("ear"), room = EAR.room, aw = s.analytics && s.analytics.ask_wait;
    const since = (x) => x.since || s.t, bySince = (a, b) => since(a) - since(b);
    const waiting = sess.filter((x) => x.state === "waiting").sort(bySince), failed = sess.filter((x) => x.state === "failed").sort(bySince);
    const cut = (str, n, close) => (str.length <= n ? str : str.slice(0, n - 1 - close.length).trimEnd() + "…" + close);
    const when = (t) => (sameDay(t, s.t) ? "" : dayShort(t) + ", ") + F.clock(t);
    // what one asks (a subagent's dialog carries its text too since 2026-11-05)
    const asks = (x) => {
      const a = x.ask, atx = a ? String(a.text || "").replace(/\s+/g, " ").trim() : "";
      if (!a) return ["is waiting on you", ""];
      return a.kind === "question" ? [atx ? `asks “${atx}”` : "asks a question", atx ? "”" : ""]
        : [`${a.agent_type ? a.agent_type + " wants " : "wants "}${a.tool || "a tool"}${atx ? ": " + atx : ""}`, ""];
    };
    const failedAt = (x) => `${x.name} failed at ${when(since(x))}`;
    let on = true, breath = 2.4, hot = false;
    if (waiting.length) {
      const n = waiting.length, oldest = waiting[0], age = s.t - since(oldest);
      // "Two need you" is the widest the slot (12.4rem) takes; three and more are a figure
      earHed.set([{ g: "fist" }, n > 2 ? `${n} need you` : n > 1 ? "Two need you" : "Needs you"]);
      // who, and for how long: the age ends the line, so nothing after it moves as it ticks
      const tail = ` has waited ${F.span(age)}`;
      text($("earA"), cut(oldest.name, room - tail.length, "") + tail);
      const [w, close] = asks(oldest);
      text($("earB"), cut(w, room, close));
      // the next one waiting, else a failure, else how fast he usually answers
      // (in the alert ink when it is one)
      let c = BLANK;
      if (n > 1) { const [w2, c2] = asks(waiting[1]), more = n > 2 ? `; ${word(n - 2)} more` : ""; c = cut(`${waiting[1].name}: ${w2}`, room - more.length, c2) + more; }
      else if (failed.length) c = cut(failedAt(failed[0]), room, "");
      else if (aw && aw.count) c = `You usually answer in ${F.span(aw.median_s)}`;
      text($("earC"), c);
      hot = n > 1 || failed.length > 0;
      // the breath quickens as the wait passes half his median answer, then all of it
      const med = aw && aw.count ? aw.median_s : 300;
      breath = age < med / 2 ? 2.4 : age < med ? 1.6 : 1.1;
    } else if (failed.length) {
      const n = failed.length, f = failed[0];
      earHed.set([n > 1 ? `† ${cap(word(n))} failed` : "† Failed"]);
      text($("earA"), cut(failedAt(f), room, ""));
      // the feed's own words for the failure, when its event carries any
      const ev = (s.claude.events || []).filter((e) => e.kind === "fail" && e.sid === f.sid).pop();
      const why = ev && String(ev.detail || "").replace(/\s+/g, " ").trim();
      text($("earB"), cut(why ? `It stopped on: ${why}` : "Its last turn ended on an error; open the session to read it", room, ""));
      text($("earC"), n > 1 ? cut(failedAt(failed[1]) + (n > 2 ? `; ${word(n - 2)} more` : ""), room, "") : BLANK);
      hot = n > 1;
    } else {
      on = false;
      earHed.set(["Nothing needs you"]);
      // the last ask in the feed's events (the last 40, newest last), by its clock time, so
      // no age ticks here; and whether he answered it, against his median. The first row
      // stays blank, so the two notes stand on the head's baseline and the row above it.
      const ev = s.claude.events || [];
      let ask = null, ans = null;
      for (let i = ev.length - 1; i >= 0 && !ask; i--) if (ev[i].kind === "ask") ask = ev[i];
      if (ask) ans = ev.find((e) => e.kind === "answered" && e.sid === ask.sid && e.t >= ask.t);
      const det = ask && /^perm\s+(\S+)/.exec(ask.detail || ""), asked = det ? `, for ${det[1]}` : /^q/i.test(ask && ask.detail || "") ? ", a question" : "";
      text($("earA"), BLANK);
      text($("earB"), cut(ask ? `Last asked ${sameDay(ask.t, s.t) ? "at" : "on"} ${when(ask.t)} by ${ask.name}${asked}`
        : ev.length ? `Nothing has asked since ${when(ev[0].t)}` : " ", room, ""));
      const took = ans && (/after\s+(\d+)\s*s/.exec(ans.detail || "") || [0, ans.t - ask.t])[1];
      const med = aw && aw.count ? `your median over ${aw.count} asks is ${F.span(aw.median_s)}` : "";
      text($("earC"), cut(ans ? `You answered in ${F.span(+took)}${med ? "; " + med : ""}`
        : med ? `When asked, you answer in ${F.span(aw.median_s)} (median of ${aw.count})` : "Nothing has asked for you in 14 days", room, ""));
    }
    // classList writes only on a change: remove() rewrites the attribute even when the
    // class is absent, a style invalidation on every line. The block is laid or lifted
    // over 320 ms while the head re-sets beside it (Line); the breath's tempo is written
    // only when its step changes, at most twice in a wait. Nothing fades at load.
    if (on !== ear.classList.contains("on")) {
      ear.classList.toggle("on", on);
      if (EAR.seen) play($("earPress"), [{ opacity: on ? 0 : 1 }, { opacity: on ? 1 : 0 }], 320);
    }
    EAR.seen = true;
    const C = $("earC");
    if (hot !== C.classList.contains("b")) C.classList.toggle("b", hot);
    if (on && EAR.breath !== breath) { EAR.breath = breath; ear.style.setProperty("--breath", breath + "s"); }
  }

  // ======================================================================
  // the lead: the allowance
  // ======================================================================
  const leadHed = Line($("leadHed")), leadDeck = Line($("leadDeck"));
  const pctN = num($("pct"), (v) => String(Math.round(v)));
  const burnN = num($("burn"), fx(1, "%"));
  const LC = { el: $("limitChart"), w: 0, sig: null, head: null };
  function lead(s) {
    const lim = s.claude.limits || {}, L7 = lim.seven_day || {}, H = lim.history || [];
    if (L7.resets_at == null) { leadHed.set(["The weekly limit\nis not reported"]); return; }
    const weekStart = L7.resets_at - 7 * 86400, age = s.t - weekStart;
    const before = H.filter((h) => h[0] < weekStart);
    const closed = before.length ? before[before.length - 1][2] : null;
    const pctPart = { k: "pct", v: L7.pct, f: (v) => Math.round(v) + "%" };
    if (age < 86400) leadHed.set([`Week reset at ${clockShort(weekStart)}:\n`, pctPart, " used"]);
    else if (L7.runout_at) leadHed.set([`Runs out ${dayShort(L7.runout_at)}:\n`, pctPart, " used"]);
    else if (L7.projected != null) leadHed.set(["On pace for ", { k: "proj", v: L7.projected, f: (v) => Math.round(v) + "%" }, ":\n", pctPart, " used"]);
    else leadHed.set([`Week resets ${dayShort(L7.resets_at)}:\n`, pctPart, " used"]);

    const deck = [];
    if (closed != null) deck.push("Last week closed at ", { b: true, s: Math.round(closed) + "%" }, ". ");
    deck.push(closed != null && age < 86400 ? "The new one is " : "The week is ", { k: "age", t: F.span(age) }, " old");
    // the rate and its unit are one phrase: the no-break spaces keep "hour" off a line of its own
    if (L7.burn_per_h != null) deck.push(" and burning ", { b: true, k: "burn", v: L7.burn_per_h, f: fx(1, "% an hour") });
    deck.push(". ");
    // pace and projection are null until 12 h after the reset: say so, draw nothing
    if (L7.runout_at) deck.push("At this pace it runs out ", { b: true, s: F.date(L7.runout_at) }, ", before the reset.");
    else if (L7.projected != null) deck.push("At this pace it closes at ", { b: true, k: "proj", v: L7.projected, f: (v) => Math.round(v) + "%" }, ` on ${dayShort(L7.resets_at)}.`);
    else if (age < 43200) deck.push(`No forecast yet: it starts 12 hours in, ${F.date(weekStart + 43200)}.`);
    else deck.push("No forecast yet.");
    leadDeck.set(deck);

    pctN.set(L7.pct);
    text($("cdown"), F.span(L7.resets_at - s.t));
    text($("cdownL"), `until reset, ${F.date(L7.resets_at)}`);
    burnN.set(L7.burn_per_h);
    // days and hours past the first day: "1 d 16 h 52 m" wrapped its narrow column, and
    // minutes into a seven-day week carry no meaning the countdown beside it doesn't
    text($("elapsed"), age >= 86400 ? `${Math.floor(age / 86400)} d ${Math.floor((age % 86400) / 3600)} h` : F.span(age));
    // the five-hour window only while Claude Code reports a live one (the plan has none since
    // 2026-10-30): otherwise the line stays blank (its height kept), no "not reported"
    const f5 = lim.five_hour || {};
    text($("five"), f5.pct != null && !f5.stale && f5.resets_at
      ? `Five-hour window: ${Math.round(f5.pct)}% used, resets in ${F.span(f5.resets_at - s.t)}.` : " ");
    limitChart(s, H, L7, weekStart, before);
  }
  // The weekly figure as read every 15 minutes: last week's close, the reset, the new
  // week, and a head that holds the latest read and walks toward the next one.
  function limitChart(s, H, L7, weekStart, before) {
    const el = LC.el, w = LC.w;
    if (!H.length || !w) return;
    const lastRead = H[H.length - 1][0];
    const gaps = H.slice(1).map((h, i) => h[0] - H[i][0]).sort((a, b) => a - b);
    const every = gaps.length ? gaps[gaps.length >> 1] : 900;
    const t0 = H[0][0], stale = s.t > lastRead + every, t1 = stale ? s.t : lastRead + every;
    // 0% sits at 124 and 100% at 10: the chart takes the height the desk beside it sets
    const x = (t) => 4 + ((t - t0) / (t1 - t0)) * (w - 74), y = (p) => 124 - (Math.min(100, p) / 100) * 114;
    const sig = [H.length, t0, lastRead, H[H.length - 1][2], L7.pct, stale ? Math.floor(s.t / 30) : 0, w].join();
    if (sig !== LC.sig) {
      LC.sig = sig;
      const after = H.filter((h) => h[0] >= weekStart);
      let g = "";
      for (const p of [0, 50, 100]) g += `<line x1="0" y1="${y(p)}" x2="${w}" y2="${y(p)}" stroke="${p ? "var(--hair)" : "var(--ink)"}"/><text x="${w}" y="${y(p) - 3}" text-anchor="end" font-size="11" fill="var(--ink2)">${p}%</text>`;
      if (before.length) {
        g += `<path d="${mono(before.map((h) => [x(h[0]), y(h[2])]))}" fill="none" stroke="var(--ink2)" stroke-width="1.6"/>`;
        for (const h of before) g += `<circle cx="${x(h[0]).toFixed(1)}" cy="${y(h[2]).toFixed(1)}" r="1.8" fill="var(--ink2)"/>`;
        const lb = before[before.length - 1];
        g += `<text x="${(x(lb[0]) - 4).toFixed(1)}" y="${(y(lb[2]) + 15).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--ink)">closed ${Math.round(lb[2])}%</text>`;
      }
      if (weekStart >= t0) {
        g += `<line x1="${x(weekStart).toFixed(1)}" y1="${y(0) - 2}" x2="${x(weekStart).toFixed(1)}" y2="${y(100)}" stroke="var(--claret)" stroke-dasharray="2 3"/>
          <text x="${(x(weekStart) - 5).toFixed(1)}" y="${y(0) - 6}" text-anchor="end" font-size="11" fill="var(--claret)">reset, ${clockShort(weekStart)}</text>`;
      }
      const pts = (weekStart >= t0 ? [[x(weekStart), y(0)]] : []).concat(after.map((h) => [x(h[0]), y(h[2])]));
      if (pts.length > 1) g += `<path d="${mono(pts)}" fill="none" stroke="var(--claret)" stroke-width="2.4"/>`;
      const lastY = after.length ? y(after[after.length - 1][2]) : y(L7.pct);
      g += `<line class="hold" x1="${pts.length ? pts[pts.length - 1][0].toFixed(1) : 0}" y1="${lastY.toFixed(1)}" y2="${y(L7.pct).toFixed(1)}" stroke="var(--claret)" stroke-width="2.4" stroke-dasharray="1 3"/>
        <circle class="head" r="3.5" cy="${y(L7.pct).toFixed(1)}" fill="var(--claret)"/>
        <text class="headL" y="${(y(L7.pct) - 8).toFixed(1)}" text-anchor="end" font-size="11" font-weight="600" fill="var(--claret)">${Math.round(L7.pct)}% now</text>
        <text x="0" y="142" font-size="11" fill="var(--ink2)">last ${F.span(lastRead - t0)}, read every ${Math.round(every / 60)} min</text>`;
      el.innerHTML = g;
      LC.head = [el.querySelector(".hold"), el.querySelector(".head"), el.querySelector(".headL")];
      LC.x = x;
    }
    // "now" walks right between reads; this is the only part that moves every tick
    // (it walks about a pixel a minute, so it is held to half pixels and rarely repaints)
    const hx = px(LC.x(Math.min(s.t, t1)));
    attr(LC.head[0], "x2", hx); attr(LC.head[1], "cx", hx); attr(LC.head[2], "x", (hx - 6).toFixed(1));
  }

  // ======================================================================
  // the desk: sessions, agents in the field, spawns
  // ======================================================================
  const deskHed = Line($("deskHed"));
  const ORDER = { waiting: 0, failed: 1, working: 2, background: 3, idle: 4 };
  const STATE_COL = { working: "var(--teal)", background: "var(--bgstate)", idle: "var(--idle)", waiting: "var(--claret)", failed: "var(--claret)" };
  // How to count sessions (README): the headline counts interactive sessions (open in a
  // terminal); kind "bg" (hosted by the daemon, no window) is counted apart, quietly, with
  // its real state. A missing kind is interactive. An idle session is never "running".
  const isBg = (x) => x.kind === "bg";
  const BG_WORD = { waiting: "waiting", failed: "failed", working: "working", background: "with agents out", idle: "idle" };
  function bgNote(bg, more) {
    if (!bg.length) return "";
    const c = {};
    bg.forEach((x) => { const k = BG_WORD[x.state] ? x.state : "idle"; c[k] = (c[k] || 0) + 1; });
    const ks = Object.keys(ORDER).filter((k) => c[k]), lead = `${word(bg.length)}${more ? " more" : ""} in the background`;
    return ks.length === 1 ? `${lead}, ${bg.length > 2 ? "all " : bg.length === 2 ? "both " : ""}${BG_WORD[ks[0]]}`
      : `${lead}: ${ks.map((k) => `${word(c[k])} ${BG_WORD[k]}`).join(", ")}`;
  }
  const sessT = KList($("sessT"), () => {
    const el = document.createElement("div");
    const name = cell("l"), dot = document.createElement("i"), nm = document.createElement("span"), bgk = cell("bgk");
    dot.className = "dot"; bgk.textContent = "bg"; bgk.style.display = "none"; name.append(dot, bgk, nm);
    const st = cell("dim"), ctx = ncell(si), pc = document.createElement("span");
    pc.className = "dim pc"; ctx.el.classList.add("ctx"); ctx.el.insertBefore(pc, ctx.el.lastChild);
    const out = ncell(int), o15 = ncell(si), ag = ncell(int);
    el.append(name, st, ctx.el, out.el, o15.el, ag.el);
    return {
      el,
      update(it) {
        text(nm, it.name);
        const bgOn = !!it.bg && !it.more;
        if (bgk.__on !== bgOn) { bgk.__on = bgOn; bgk.style.display = bgOn ? "" : "none"; }
        if (it.more) { dot.style.background = "transparent"; text(st, ""); text(pc, ""); return; }
        dot.style.background = STATE_COL[it.state] || "var(--idle)";
        // "background" is the feed's word for a session whose work is out with its
        // agents; it did not fit the column, so the table says what it means
        text(st, it.state === "background" ? "delegated" : it.state);
        el.classList.toggle("flag", it.state === "waiting" || it.state === "failed");
        // Math.round(null) is 0: a session with no context reading yet printed "0%".
        ctx.set(it.ctx); text(pc, it.ctxPct == null ? "–" : Math.round(it.ctxPct) + "%");
        out.set(it.out); o15.set(it.o15); ag.set(it.agents);
      },
    };
  });
  const agT = KList($("agT"), () => {
    const el = document.createElement("div");
    const ty = cell("l"), ds = cell("l"), se = cell("dim"), age = cell();
    ds.style.paddingLeft = ".8rem";
    el.append(ty, ds, se, age);
    return {
      el,
      update(it) {
        el.classList.toggle("flag", it.type === "general-purpose");
        text(ty, it.type); text(ds, it.desc); text(se, it.session); text(age, it.age);
      },
    };
  });
  const SB = { el: $("spawnBar"), w: 0, sig: null, vals: null };
  function desk(s) {
    const sess = (s.claude.sessions || []).slice(), agents = s.claude.agents_running || [];
    // the headline counts the sessions open in a terminal; anything waiting on you counts
    // wherever it runs, since it needs you either way
    const open = sess.filter((x) => !isBg(x)), bg = sess.filter(isBg);
    const n = (st, from = sess) => from.filter((x) => x.state === st).length;
    const no = open.length, nw = n("working", open), nq = n("waiting"), nf = n("failed", open), na = agents.length;
    const a = no ? `${word(no)} ${plural(no, "session")} open, ${nw ? word(nw) : "none"} working` : "no sessions open";
    const b = `${word(na)} ${plural(na, "agent")} out`;
    const c = nq ? `${word(nq)} waiting on you` : "nothing waiting on you";
    deskHed.set([(nq ? `${cap(c)}; ${a}, ${b}` : `${cap(a)}; ${b}, ${c}`) + (nf ? `; ${word(nf)} failed` : "")]);

    const wins = [...new Set(sess.map((x) => x.ctx_window).filter(Boolean))];
    const back = bgNote(bg, no > 0);
    text($("ctxWin"), (wins.length === 1 ? `context of a ${wins[0] >= 1e6 ? wins[0] / 1e6 + "M" : Math.round(wins[0] / 1e3) + "k"} window` : "context used")
      + (back ? `; ${back}` : ""));
    // interactive first, then background; within each, the ones that need you lead
    sess.sort((p, q) => isBg(p) - isBg(q) || (ORDER[p.state] ?? 5) - (ORDER[q.state] ?? 5) || p.name.localeCompare(q.name));
    const rows = sess.map((x) => ({
      key: x.sid, name: x.name, state: x.state, bg: isBg(x), ctx: x.ctx_tokens, ctxPct: x.ctx_pct,
      // the newest minute is still filling; the last FULL minute is the honest "now"
      out: x.out_per_min && x.out_per_min.length > 1 ? x.out_per_min[x.out_per_min.length - 2] : 0,
      o15: x.out_15m || 0, agents: x.agents_running || 0,
    }));
    if (rows.length > 4) {
      const rest = rows.splice(3);
      const st = [...new Set(rest.map((x) => x.state))];
      const where = rest.every((x) => x.bg) ? " in the background" : "";
      rows.push({ key: "_more", more: true, name: `${rest.length} more${where}, ${st.length === 1 ? "all " + st[0] : st.join(" and ")}` });
    }
    sessT.update(rows, "No sessions open");

    const names = Object.fromEntries(sess.map((x) => [x.sid, x.name]));
    // an agent's age runs from `started` (epoch s) against state.t, so it ticks every
    // line; `age_s` (whole seconds when the line was written) if `started` is missing
    const ageOf = (x) => (x.started ? Math.max(0, s.t - x.started) : x.age_s);
    const ag = agents.slice().sort((p, q) => (ageOf(q) || 0) - (ageOf(p) || 0)).map((x) => ({
      key: x.id, type: x.type, desc: x.desc || "",
      session: names[x.sid] || x.session ? (names[x.sid] || x.session).split("-").slice(0, 2).join("-") : String(x.sid || "").slice(0, 8),
      age: F.span(ageOf(x)),
    }));
    if (ag.length > 3) {
      const rest = ag.splice(2);
      const types = [...new Set(rest.map((x) => x.type))];
      ag.push({ key: "_more", type: `${rest.length} more`, desc: types.length === 1 ? `all ${types[0]}` : types.join(", "), session: "", age: "" });
    }
    // an empty field still says something true: when the last agent came back
    const done = (s.claude.events || []).filter((e) => e.kind === "agent_done").pop();
    agT.update(ag, done ? `No agents out; the last, ${(done.detail || "").split(":")[0] || "an agent"}, came back ${F.span(s.t - done.t)} ago` : "No agents out");
    text($("agN"), `${na} running`);
    spawns(s);
  }
  // one printed share bar: general-purpose first, in claret, then the named agents.
  // Big segments are labelled under themselves; the small tail is listed at the right.
  function spawns(s) {
    const A = s.analytics;
    // analytics is replaced only when it is re-read (about every 10 s); measure() clears SB.A
    if (!A || !A.spawns || !SB.w || A === SB.A) return;
    SB.A = A;
    const items = Object.entries(A.spawns.today || {}).sort((p, q) => q[1] - p[1]);
    const tot = items.reduce((a, [, v]) => a + v, 0);
    const sig = JSON.stringify(items) + SB.w;
    if (sig === SB.sig) return;
    const keysSame = SB.items && SB.items.map((i) => i[0]).join() === items.map((i) => i[0]).join();
    SB.sig = sig;
    text($("spawnN"), `${tot} ${plural(tot, "agent")}`);
    const gp = A.general_purpose || {}, by = gp.by_session_today || [];
    text($("gpLine"), !tot ? "No agents spawned yet today." : !gp.today ? `None of the ${tot} were general-purpose.`
      : `${gp.today} of ${tot} were general-purpose, ${by.length === 1 ? "every one from " + by[0][0] : "most from " + (by[0] ? by[0][0] : "one session")}.`);
    const w = SB.w, draw = (vals) => {
      const T = vals.reduce((a, b) => a + b, 0) || 1, big = (v) => (v / T) * w > 120;
      let x = 0, g = "", end = 0;
      const tail = [];
      // label widths are estimated (about 6 px a character at 11 px): the update path
      // takes no layout reads
      const est = (s) => s.length * 6;
      items.forEach(([k], i) => {
        const v = vals[i], bw = (v / T) * w, gpk = k === "general-purpose";
        g += `<rect x="${x.toFixed(1)}" y="2" width="${Math.max(0, bw - 1.5).toFixed(1)}" height="9" fill="${gpk ? "var(--claret)" : "var(--ink2)"}" opacity="${gpk ? 1 : 0.55}"/>`;
        if (big(items[i][1])) { const s = `${k} ${items[i][1]}`; g += `<text x="${x.toFixed(1)}" y="25" font-size="11" fill="${gpk ? "var(--claret)" : "var(--ink)"}">${s}</text>`; end = x + est(s); }
        else tail.push(`${k} ${items[i][1]}`);
        x += bw;
      });
      // the small tail shares the labels' line when it clears them, else drops below
      const ts = tail.join(", ");
      g += `<text x="${w}" y="${end + 16 < w - est(ts) ? 25 : 38}" text-anchor="end" font-size="11" fill="var(--ink2)">${ts}</text>`;
      SB.el.innerHTML = g;
    };
    const vals = items.map((i) => i[1]);
    glide("spawns", keysSame ? SB.vals : null, vals, draw);
    SB.vals = vals; SB.items = items;
  }

  // ======================================================================
  // the weather
  // ======================================================================
  const condL = Line($("cond"));
  const VG = { w: 0, h: 0 };   // the plate's size, read in measure()
  const tempN = num($("tempF"), (v) => String(Math.round(v)));
  const KIND_TEXT = { clear: "Clear", partly: "Partly cloudy", cloudy: "Overcast", fog: "Fog", drizzle: "Drizzle", rain: "Rain", snow: "Snow", storm: "Thunderstorm" };
  function weather(s) {
    // The plate always shows the real sky: the sun from today's sunrise and sunset, the real
    // weather.kind. The edition (the appearance) chooses only its paper and ink (README,
    // Preferences: "Weather and sky are never fabricated"). Dev only: ?sky=day|night or
    // ?day=1|0 sets the light, ?weather= the kind.
    const devSky = Q.get("sky") || (Q.has("day") ? (Q.get("day") === "0" ? "night" : "day") : null);
    const W = s.weather, o = { kind: Q.get("weather"), sky: devSky, motion: CFG.weather_motion, fade_ms: fadeMs, slow, w: VG.w, h: VG.h };
    const sc = window.LedgerVignette.update($("vig"), W, s.t, edition, o);
    if (!W) {
      text($("wxPlace"), "Weather"); text($("wxObs"), "no report"); condL.set(["No report"]);
      for (const id of ["tempC", "condSub", "wind", "hum", "sun", "nextEd"]) text($(id), "–");
      tempN.set(null);
      return;
    }
    text($("wxPlace"), `${(W.place || "").split(",")[0] || "Local"} weather`);
    text($("wxObs"), `observed ${F.clock(W.observed_at || W.fetched_at)}`);
    // the feed is Celsius; the user's unit (the host's menu) comes from the runtime. The
    // reading to a tenth in °C used to lead this line; in the user's own unit it only
    // repeated the figure above, so it went with the unit menu.
    tempN.set(K.fmt.tempValue(W.temp_c));
    text($("tempC"), `Feels like ${K.fmt.temp(W.feels_c)}`);
    const forced = o.kind && KIND_TEXT[o.kind];
    condL.set([forced ? KIND_TEXT[o.kind] : cap(W.text || KIND_TEXT[W.kind] || W.kind)]);
    const precip = forced ? sc.precip : W.precip_mm || 0, snow = forced ? sc.snow : W.snow_cm || 0;
    text($("condSub"), `${W.cloud}% cloud, ${snow > 0 ? snow + " cm of snow" : precip > 0 ? precip + " mm falling" : "nothing falling"}`);
    // mph under °F, km/h under °C (K.fmt.wind)
    const wv = +K.fmt.wind(W.wind_kmh, { unit: false });
    text($("wind"), !(wv >= 1) ? "calm" : `${K.fmt.wind(W.wind_kmh)} from the ${DIRS[Math.round(W.wind_dir / 22.5) % 16]}`);
    const g = Math.log(W.humidity / 100) + (17.62 * W.temp_c) / (243.12 + W.temp_c), dew = (243.12 * g) / (17.62 - g);
    text($("hum"), `${W.humidity}%, ${K.fmt.temp(dew)}`);
    text($("sun"), `${F.clock(W.sunrise)}, ${F.clock(W.sunset)}`);
    text($("nextEd"), F.span(W.sunset - W.sunrise));
  }

  // ======================================================================
  // output
  // ======================================================================
  const outHed = Line($("outHed"));
  const oToday = num($("oToday"), si), oCache = num($("oCache"), si), oCalls = num($("oCalls"), int), oHit = num($("oHit"), fx(1, "%"));
  const OC = { el: $("flow"), w: 0, sig: null, minute: null, fill: null };
  function niceStep(mx) { for (const st of [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000]) if (mx / st <= 3.4) return st; return 1e6; }
  const tick = (v) => (v >= 1000 ? v / 1000 + "k" : String(v));
  function output(s) {
    const T = s.claude.tokens || {}, opm = T.out_per_min || [];
    const full = opm.slice(0, -1), fill = opm.length ? opm[opm.length - 1] : 0;
    const now = full.length ? full[full.length - 1] : 0;
    const avg = full.length ? Math.round(full.reduce((a, b) => a + b, 0) / full.length) : 0;
    const avgP = { k: "avg", v: avg, f: int };
    outHed.set(now > 0 ? [{ k: "now", v: now, f: int }, " a minute now; the hour averaged ", avgP] : ["Nothing written in the last minute; the hour averaged ", avgP]);
    const td = T.today || {};
    oToday.set(td.out); oCache.set(td.cache_read); oCalls.set(td.calls);
    const hit = s.analytics && s.analytics.cache_hit_pct;
    oHit.set(hit ? hit.today : null);
    text($("oHit14"), hit ? `cache hit, 14 days ${hit.d14}%` : "cache hit");
    flow(s, full, fill, avg);
  }
  // tokens a minute, the last hour. The minute in progress is the dotted stub at the
  // right, filling as responses land; when the minute closes the chart steps left.
  // Three planes: the scale (#flow), the data on its own sliding layer in a window
  // that clips it, and the average and peak notes over both.
  // how many segments of a trace (points in x order) pass through the box x0..x1, y0..y1?
  // Each segment is clipped to the box's x span and its y range tested; 0 means clear. Pad
  // the box for a smoothed curve.
  function traceNear(pts, x0, x1, y0, y1) {
    let c = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      if (bx < x0 || ax > x1) continue;
      const k = (x) => ay + ((by - ay) * (Math.min(Math.max(x, ax), bx) - ax)) / (bx - ax || 1);
      const ya = k(x0), yb = k(x1);
      if (Math.max(ya, yb) >= y0 && Math.min(ya, yb) <= y1) c++;
    }
    return c;
  }
  function flow(s, full, fill, avg) {
    const el = OC.el, w = OC.w, n = full.length;
    if (!w || n < 2) return;
    const pw = w - 34, st = pw / n;
    const mx0 = Math.max(...full, fill, 1), step = niceStep(mx0), top = Math.ceil((mx0 * 1.06) / step) * step;
    const x = (i) => i * st, y = (v) => 94 - (v / top) * 86;
    const minute = Math.floor(s.t / 60);
    const sig = full.join() + "|" + top + "|" + w;
    if (sig !== OC.sig) {
      OC.sig = sig;
      if (!OC.win) {
        const box = el.parentNode;
        OC.win = document.createElement("div"); OC.win.className = "win"; box.appendChild(OC.win);
        OC.scroll = svg("svg", { class: "slide" }, OC.win);
        OC.top = svg("svg", { class: "over" }, box);
      }
      const peak = Math.max(...full), pk = full.lastIndexOf(peak), p = full.map((v, i) => [x(i), y(v)]);
      let g = "";
      for (let v = 0; v <= top; v += step) g += `<line x1="0" y1="${y(v)}" x2="${pw}" y2="${y(v)}" stroke="${v ? "var(--hair)" : "var(--rule)"}"/><text x="${w}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--ink2)">${tick(v)}</text>`;
      g += `<text x="0" y="110" font-size="11" fill="var(--ink2)">60 min ago</text><text x="${pw}" y="110" text-anchor="end" font-size="11" fill="var(--ink2)">this minute so far</text>`;
      el.innerHTML = g;
      // the window runs 4 px past the plot so the open head of the stub is not cut in half
      OC.win.style.cssText = `left:0;top:-12px;width:${pw + 4}px;height:130px`;
      attr(OC.scroll, "width", pw + 4); attr(OC.scroll, "height", 130); attr(OC.scroll, "viewBox", `0 -12 ${pw + 4} 130`);
      OC.scroll.innerHTML = `<path d="${mono(p)}L${x(n - 1)} ${y(0)}L0 ${y(0)}Z" fill="var(--teal)" opacity=".13"/><path d="${mono(p)}" fill="none" stroke="var(--teal)" stroke-width="1.8"/>`
        + `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(full[n - 1]).toFixed(1)}" r="3.5" fill="var(--teal)"/>`
        + `<line class="stub" x1="${x(n - 1).toFixed(1)}" y1="${y(full[n - 1]).toFixed(1)}" x2="${pw}" stroke="var(--teal)" stroke-width="1.6" stroke-dasharray="2 2.5"/>`
        + `<circle class="stubH" cx="${pw}" r="2.2" fill="var(--paper)" stroke="var(--teal)" stroke-width="1.3"/>`;
      // The average is labelled in a fixed slot the curve and the peak's note leave clear,
      // farthest from the peak first; above its line, then below. The chosen
      // slot holds while it stays clear, and the label jumps between slots, never slides.
      // Pinned to one slot it could sit on the curve, since the average is where the curve
      // crosses (2026-11-05). With no clear slot it takes the least crossed one on a plate of
      // paper, so the curve passes under the plate rather than through the letters.
      // AVH: half this label's width, 5.8 pt a character at 11 px (it is centred on its slot)
      const ya = y(avg), AVH = (`average ${int(avg)}`.length * 5.8) / 2;
      const pkRight = x(pk) > pw - 170, pkAbove = y(peak) > 16, pkW = (`peak ${int(peak)}, ${n - 1 - pk} min ago`).length * 6;
      const pkX0 = pkRight ? x(pk) - 6 - pkW : x(pk) + 6, pkY0 = pkAbove ? y(peak) - 13 : y(peak);
      const pkF = pk / n, fr = [];
      for (let f = 0.12; f < 0.87; f += 0.04625) fr.push(f);   // quarter-label steps at ~550 pt
      fr.sort((a, b) => Math.abs(b - pkF) - Math.abs(a - pkF) || a - b);   // farthest from the peak first
      const AVS = fr.flatMap((f) => [[f, 0], [f, 1]]);
      const cost = ([f, below]) => {
        const cx = x(n * f), y0 = below ? ya + 3 : ya - 13, y1 = y0 + 11;
        if (y0 < 0 || y1 > 92) return Infinity;
        if (peak > 0 && cx - AVH < pkX0 + pkW + 3 && cx + AVH > pkX0 - 3 && y0 < pkY0 + 13 && y1 > pkY0 - 2) return Infinity;
        return traceNear(p, cx - AVH - 2, cx + AVH + 2, y0 - 2, y1 + 2);
      };
      const cs = AVS.map(cost), prev = AVS.findIndex(([f, b]) => f === OC.avF && b === OC.avB);
      let k = prev >= 0 && cs[prev] === 0 ? prev : cs.indexOf(0);
      const plate = k < 0;
      if (plate) { k = 0; cs.forEach((v, i) => { if (v < cs[k]) k = i; }); }
      [OC.avF, OC.avB] = AVS[k];
      const al = x(n * AVS[k][0]), aly = AVS[k][1] ? ya + 12 : ya - 4;
      g = `<line x1="0" y1="${y(avg)}" x2="${pw}" y2="${y(avg)}" stroke="var(--rule)" stroke-dasharray="1 3"/>
        ${plate ? `<rect x="${(al - AVH - 3).toFixed(1)}" y="${(aly - 10).toFixed(1)}" width="${2 * AVH + 6}" height="14" fill="var(--paper)"/>` : ""}
        <text x="${al.toFixed(1)}" y="${aly.toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--ink2)" stroke="var(--paper)" stroke-width="3" stroke-linejoin="round" paint-order="stroke">average ${int(avg)}</text>`;
      if (peak > 0) {
        // set beside the peak, clear of the curve: above it when there is headroom
        const right = x(pk) > pw - 170, above = y(peak) > 16;
        g += `<text x="${(x(pk) + (right ? -6 : 6)).toFixed(1)}" y="${(above ? y(peak) - 4 : y(peak) + 9).toFixed(1)}" text-anchor="${right ? "end" : "start"}" font-size="11" fill="var(--ink)">peak ${int(peak)}, ${n - 1 - pk} min ago</text>`;
      }
      attr(OC.top, "width", w); attr(OC.top, "height", 112); attr(OC.top, "viewBox", `0 0 ${w} 112`);
      OC.top.innerHTML = g;
      OC.stub = OC.scroll.querySelector(".stub"); OC.stubH = OC.scroll.querySelector(".stubH");
      OC.fill = null;
      // a closed minute: the hour steps left by one minute. It happens once a minute,
      // so it keeps its own 600 ms whatever the period, on the compositor.
      if (OC.minute != null && minute !== OC.minute) play(OC.scroll, [{ transform: `translateX(${st.toFixed(2)}px)` }, { transform: "none" }], 600);
      OC.minute = minute;
    }
    // the stub's head is set once per line; it glides only where Kiln.glide allows
    const head = (v) => { const yy = y(v).toFixed(1); attr(OC.stub, "y2", yy); attr(OC.stubH, "cy", yy); };
    if (OC.fill == null || !K.glide) head(fill); else K.tweenKey("flowFill", OC.fill, fill, head);
    OC.fill = fill;
  }

  // ======================================================================
  // the Commits desk
  // ======================================================================
  const ghHed = Line($("ghHed")), ghDeck = Line($("ghDeck"));
  const CAL = { el: $("cal"), sig: null };
  const repoT = KList($("repoT"), () => {
    const el = document.createElement("div"), nm = cell("l"), own = document.createElement("span"), rn = document.createElement("span");
    own.className = "dim"; nm.append(own, rn);
    const c = ncell(int), sh = ncell(fx(1, "%"));
    el.append(nm, c.el, sh.el);
    return {
      el,
      update(it) {
        text(own, it.owner ? it.owner + "/" : ""); text(rn, it.name);
        nm.classList.toggle("dim", !!it.other); c.el.classList.toggle("dim", !!it.other); sh.el.classList.toggle("dim", !!it.other);
        c.set(it.n); sh.set(it.share);
      },
    };
  });
  const EVT = {
    PushEvent: (r, when) => `the last push went to ${r} ${when}`,
    PullRequestEvent: (r, when) => `the last pull request was in ${r} ${when}`,
    IssuesEvent: (r, when) => `the last issue was in ${r} ${when}`,
    CreateEvent: (r, when) => `the last branch was cut in ${r} ${when}`,
    WatchEvent: (r, when) => `the last star went to ${r} ${when}`,
    ReleaseEvent: (r, when) => `the last release was ${r} ${when}`,
  };
  function commits(s) {
    const G = s.github;
    if (!G) { ghHed.set(["GitHub has not reported yet"]); return; }
    text($("ghWho"), `${G.login} on GitHub, last 12 months`);
    const L = G.latest;
    let tail = "nothing pushed lately";
    if (L && L.repo) {
      const [owner, name] = L.repo.split("/"), r = owner === G.login ? name : L.repo;
      const when = sameDay(L.at, s.t) ? "at " + F.clock(L.at) : "on " + dayShort(L.at);
      tail = (EVT[L.type] || ((rr, ww) => `the last event was in ${rr} ${ww}`))(r, when);
    }
    ghHed.set([{ k: "today", v: G.today, f: int }, ` ${plural(G.today, "contribution")} today; ${tail}`]);
    const best = G.best || [null, 0];
    ghDeck.set([{ b: true, k: "tot", v: G.total_year, f: int }, " contributions in the year, ", { b: true, k: "wk", v: G.week, f: int },
      ` this week, ${G.streak ? `a ${G.streak}-day streak` : "no streak running"}. The record day is `, { b: true, s: int(best[1]) },
      best[0] ? `, on ${dayShort(new Date(best[0] + "T12:00").getTime() / 1000)}.` : "."]);
    text($("calRings"), `rings: today ${G.today}, best ${best[1]}`);
    const tot = G.commits_year || (G.repos || []).reduce((a, r) => a + r[1], 0) || 1;
    const repos = (G.repos || []).slice().sort((p, q) => q[1] - p[1]);
    const top = repos.slice(0, 6).map(([full, n]) => {
      const [owner, name] = full.split("/");
      return { key: full, owner: owner === G.login ? "" : owner, name: name || full, n, share: (n / tot) * 100 };
    });
    if (repos.length > 6) {
      const rest = repos.slice(6), n = rest.reduce((a, r) => a + r[1], 0);
      top.push({ key: "_others", other: true, owner: "", name: `${rest.length} other ${plural(rest.length, "repository").replace("repositorys", "repositories")}`, n, share: (n / tot) * 100 });
    }
    repoT.update(top, "No commits this year");
    text($("ghYear"), `Year: ${int(G.commits_year)} commits, ${int(G.prs_year)} pull requests, ${int(G.issues_year)} issues`);
    wire(G, s.t);
    calendar(G);
  }
  // What came before the event the headline reports, newest first: three fixed lines,
  // each its time and the feed's own words. Written only when the events change.
  const WIRE = [];
  function wire(G, t) {
    if (!WIRE.length) for (let i = 0; i < 3; i++) {
      const row = document.createElement("div"), at = cell(), what = cell();
      row.append(at, what); $("wire").appendChild(row); WIRE.push([at, what]);
    }
    const L = G.latest || {}, own = (r) => { const [o, n] = (r || "").split("/"); return o === G.login ? n : r; };
    const ev = (G.recent || []).filter((e) => !(e.at === L.at && e.repo === L.repo && e.type === L.type)).slice(0, 3);
    WIRE.forEach(([at, what], i) => {
      const e = ev[i];
      text(at, e ? (sameDay(e.at, t) ? "Today, " : dayShort(e.at) + ", ") + F.clock(e.at) : "");
      text(what, !e ? "" : e.type === "ForkEvent" ? `forked ${e.repo}` : e.text || `${e.type.replace(/Event$/, "").toLowerCase()} in ${own(e.repo)}`);
    });
  }
  // GitHub's 7 x 53 grid as a printed figure, Sunday on top; each day a halftone dot
  // whose AREA tracks the count. Rings mark today and the record day.
  function calendar(G) {
    // the github block changes only when it is polled; its width is read in measure()
    if (G === CAL.G) return;
    CAL.G = G;
    const days = G.days || [], avail = CAL.avail;
    const sig = JSON.stringify(days.slice(-8)) + days.length + (G.best || []).join() + avail;
    if (sig === CAL.sig || !days.length) return;
    CAL.sig = sig;
    const first = new Date(days[0][0] + "T12:00").getDay(), cols = Math.ceil((days.length + first) / 7);
    const ox = 26, oy = 15, pitch = Math.min(10.6, (avail - ox - 14) / cols), w = ox + cols * pitch + 8, h = oy + 7 * pitch + 2;
    const el = CAL.el;
    el.setAttribute("viewBox", `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`); el.setAttribute("width", w.toFixed(1)); el.setAttribute("height", h.toFixed(1));
    const capN = 150, r = (c) => (c ? 0.95 + Math.min(1, Math.sqrt(c / capN)) * (pitch / 2 - 1.05) : 0.55);
    let g = "", lastM = -1, best = null, today = null;
    ["", "Mon", "", "Wed", "", "Fri", ""].forEach((d, i) => { if (d) g += `<text x="0" y="${(oy + i * pitch + pitch / 2 + 3.5).toFixed(1)}" font-size="11" fill="var(--ink2)">${d}</text>`; });
    days.forEach(([date, c], i) => {
      const k = i + first, col = Math.floor(k / 7), row = k % 7, cx = ox + col * pitch + pitch / 2, cy = oy + row * pitch + pitch / 2;
      const dd = new Date(date + "T12:00");
      if (dd.getMonth() !== lastM && row <= 1 && col < cols - 2) { lastM = dd.getMonth(); g += `<text x="${(cx - 3).toFixed(1)}" y="10" font-size="11" fill="var(--ink2)">${dd.toLocaleString("en-US", { month: "short" })}</text>`; }
      const isT = i === days.length - 1;
      if (G.best && date === G.best[0]) best = [cx, cy];
      if (isT) today = [cx, cy];
      g += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r(c).toFixed(2)}" fill="${isT ? "var(--claret)" : "var(--ink)"}" opacity="${c ? 0.9 : 0.3}"/>`;
    });
    for (const p of [best, today]) if (p) g += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(pitch / 2 + 0.6).toFixed(2)}" fill="none" stroke="var(--claret)" stroke-width="1.2"/>`;
    el.innerHTML = g;
    $("calKey").innerHTML = "Dot area is the day's count:" + [1, 10, 50, capN].map((c) =>
      `<svg width="12" height="12" style="display:inline;vertical-align:-1px;margin:0 .15rem 0 .45rem"><circle cx="6" cy="6" r="${r(c).toFixed(2)}" fill="var(--ink)"/></svg>${c === capN ? capN + "+" : c}`).join("");
  }

  // ======================================================================
  // fourteen days: output by day, when the work happens, the agent mix
  // ======================================================================
  const DY = { el: $("days"), w: 0, sig: null, bars: [] };
  function fortnight(s) {
    const A = s.analytics;
    if (!A || !A.days || !A.days.length) return;
    days(s, A); matrix(s, A); mix(A);
  }
  // The dates and the base line are drawn into #days when the days change. The bars,
  // the average and the three notes are sprites over it, so today's bar rising as
  // responses land is a transform the compositor runs.
  function days(s, A) {
    const el = DY.el, w = DY.w, D = A.days, n = D.length, today = isoDay(s.t);
    if (!w) return;
    const liveIdx = D[n - 1].date === today ? n - 1 : -1;
    // the days are re-read with analytics; between reads only today's live bar moves
    const reread = A !== DY.A || today !== DY.today;
    DY.A = A; DY.today = today;
    const sig = reread ? JSON.stringify(D.map((d) => [d.date, liveIdx >= 0 && d.date === today ? 0 : d.out])) + w : DY.sig;
    if (sig !== DY.sig) {
      DY.sig = sig;
      const bw = w / n, base = 82, box = el.parentNode;
      let g = "";
      D.forEach((d, i) => {
        const x = i * bw + 2, dd = new Date(d.date + "T12:00");
        g += `<text x="${(x + (bw - 4) / 2).toFixed(1)}" y="${base + 13}" text-anchor="middle" font-size="11" fill="var(--ink2)">${dd.getDate()}</text>`;
        if (i === 0 || dd.getDate() === 1) g += `<text x="${x.toFixed(1)}" y="${base + 27}" font-size="11" fill="var(--ink2)">${dd.toLocaleString("en-US", { month: "long" })}</text>`;
      });
      g += `<line x1="0" y1="${base}" x2="${w}" y2="${base}" stroke="var(--rule)"/>`;
      el.innerHTML = g;
      for (const e of box.querySelectorAll(".spr")) e.remove();
      // painted in the order the single SVG had: the average under the bars, the notes over them
      DY.avg = sprite(box, 0, -1, w, 2, `<line x1="0" y1="0" x2="${w}" y2="0" stroke="var(--rule)" stroke-dasharray="1 3"/>`);
      // the notes carry a paper halo: today's sits beside its bar, over yesterday's, and
      // on a short bar it rides just above the base line (seen just after midnight)
      const halo = `stroke="var(--paper)" stroke-width="3" stroke-linejoin="round" paint-order="stroke"`;
      DY.avgL = sprite(box, 4.5 * bw, -12, 160, 16, `<text x="${(4.5 * bw).toFixed(1)}" y="0" font-size="11" fill="var(--ink2)" ${halo}></text>`);
      // a bar is drawn full height (70) down to the base line's top edge and scaled
      // from its foot; the line itself is drawn below, in #days
      DY.bars = D.map((d, i) => {
        const last = i === liveIdx, b = sprite(box, i * bw + 2, base - 70, bw - 4, 69.5,
          `<rect x="${(i * bw + 2).toFixed(1)}" y="${base - 70}" width="${(bw - 4).toFixed(1)}" height="69.5" fill="${last ? "var(--claret)" : "var(--ink2)"}" opacity="${last ? 1 : 0.55}"/>`);
        b.style.transformOrigin = "50% 100%";
        return b;
      });
      DY.todayL = sprite(box, -160, -12, 160, 16, `<text x="0" y="0" text-anchor="end" font-size="11" font-weight="600" fill="var(--claret)" ${halo}></text>`);
      DY.bestL = sprite(box, -80, -12, 160, 16, `<text x="0" y="0" text-anchor="middle" font-size="11" fill="var(--ink)" ${halo}></text>`);
      DY.todayN = num(DY.todayL.firstChild, (v) => si(v) + " today");
      DY.idx = liveIdx; DY.D = D;
    }
    // today's bar is the live figure (claude.tokens.today), set once per line
    const live = liveIdx >= 0 ? Math.max(D[liveIdx].out, (s.claude.tokens.today || {}).out || 0) : null;
    layDays(live);
    if (live != null) DY.todayN.set(live);
    text($("d14"), `${si(D.reduce((a, d, i) => a + (i === liveIdx ? live : d.out), 0))} in 14 days`);
  }
  function layDays(liveV) {
    const D = DY.D, n = D.length, w = DY.w, bw = w / n, base = 82;
    const vals = D.map((d, i) => (i === DY.idx && liveV != null ? liveV : d.out));
    const mx = Math.max(...vals, 1), sc = (v) => (v / mx) * 70, avg = vals.reduce((a, b) => a + b, 0) / n;
    vals.forEach((v, i) => tf(DY.bars[i], `scaleY(${((Math.max(1.5, sc(v)) - 0.5) / 69.5).toFixed(4)})`));
    const ay = base - sc(avg);
    tf(DY.avg, `translateY(${ay.toFixed(2)}px)`); tf(DY.avgL, `translateY(${px(ay - 4)}px)`); text(DY.avgL.firstChild, `average ${si(avg)}`);
    if (DY.idx >= 0) {
      // beside the top of its bar; a bar too short for that has its note above both
      // the bar and the average line, never struck through by the line or down among
      // the dates
      const x = DY.idx * bw + 2, h = Math.max(1.5, sc(vals[DY.idx]));
      tf(DY.todayL, `translate(${px(x - 4)}px,${px(h >= 16 ? base - h + 10 : Math.min(base - h, ay) - 5)}px)`);
    }
    // the biggest earlier day carries its figure
    const prior = vals.slice(0, DY.idx >= 0 ? DY.idx : n), bi = prior.indexOf(Math.max(...prior));
    if (bi >= 0) {
      tf(DY.bestL, `translate(${px(bi * bw + 2 + (bw - 4) / 2)}px,${px(base - sc(prior[bi]) - 4)}px)`);
      text(DY.bestL.firstChild, si(prior[bi]));
    }
  }
  const MX = { el: $("matrix"), w: 0, sig: null };
  function matrix(s, A) {
    const M = A.hour_matrix;
    if (!M || !MX.w) return;
    const d = local(s.t), row = (d.getDay() + 6) % 7, hr = d.getHours();
    // analytics is replaced only when it is re-read (about every 10 s)
    // the footnote names today's ink, so the key carries the printing as well
    const key = row + "|" + hr + "|" + MX.w + "|" + edition;
    if (A === MX.A && key === MX.key) return;
    MX.A = A; MX.key = key;
    const sig = JSON.stringify(M.out) + key;
    if (sig === MX.sig) return;
    MX.sig = sig;
    const w = MX.w, ox = 30, cw = (w - ox) / 24, ch = 12.2, mm = Math.max(1, ...M.out.flat());
    let g = "", best = [0, 0, 0];
    M.out.forEach((rowV, r) => {
      g += `<text x="0" y="${(r * ch + 10).toFixed(1)}" font-size="11" fill="${r === row ? "var(--claret)" : "var(--ink2)"}">${M.rows[r]}</text>`;
      rowV.forEach((v, c) => {
        if (v > best[0]) best = [v, r, c];
        const rr = v ? 0.8 + Math.sqrt(v / mm) * (Math.min(cw, ch) / 2 - 0.5) : 0.55;
        g += `<circle cx="${(ox + c * cw + cw / 2).toFixed(1)}" cy="${(r * ch + 6.5).toFixed(1)}" r="${rr.toFixed(2)}" fill="${r === row ? "var(--claret)" : "var(--ink)"}" opacity="${v ? 0.85 : 0.25}"/>`;
      });
    });
    // the hour he is in, ringed
    g += `<circle cx="${(ox + hr * cw + cw / 2).toFixed(1)}" cy="${(row * ch + 6.5).toFixed(1)}" r="${(Math.min(cw, ch) / 2 + 0.4).toFixed(2)}" fill="none" stroke="var(--claret)" stroke-width="1.1"/>`;
    for (const hh of [0, 6, 12, 18]) g += `<text x="${(ox + hh * cw + cw / 2).toFixed(1)}" y="${(7 * ch + 13).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--ink2)">${hourLbl(hh)}</text>`;
    g += `<text x="0" y="${(7 * ch + 28).toFixed(1)}" font-size="11" fill="var(--ink2)">largest dot ${si(mm)}; today in ${edition === "night" ? "vermilion" : "claret"}, this hour ringed</text>`;
    MX.el.innerHTML = g;
    text($("mxPeak"), best[0] ? `peak ${M.rows[best[1]]} ${hourLbl(best[2])}` : "");
  }
  const MI = { el: $("mix"), w: 0, sig: null, rows: null, vals: null };
  // names in #mix; each bar and its figure are sprites, scaled and moved on the compositor
  function mix(A) {
    if (!A.spawns || !MI.w || A === MI.A) return;
    MI.A = A;
    const all = Object.entries(A.spawns.d14 || {}).sort((p, q) => q[1] - p[1]), list = all.slice(0, 6);
    const sig = JSON.stringify(list) + MI.w;
    if (sig === MI.sig) return;
    MI.sig = sig;
    const w = MI.w, tot = all.reduce((a, [, v]) => a + v, 0), bwMax = w - 136, box = MI.el.parentNode;
    text($("mixTot"), int(tot));
    if (!MI.rows) {
      MI.rows = [];
      for (let i = 0; i < 6; i++) {
        const y = i * 16.5;
        const name = svg("text", { x: 0, y: y + 12, "font-size": 11 }, MI.el);
        const bar = sprite(box, 102, y + 4, bwMax, 9, `<rect x="102" y="${y + 4}" width="${bwMax}" height="9"/>`);
        bar.style.transformOrigin = "0 0";
        const val = sprite(box, 107, y, 80, 16, `<text x="107" y="${y + 12}" font-size="11" fill="var(--ink)"></text>`);
        MI.rows.push({ name, bar, rect: bar.firstChild, val, n: num(val.firstChild, int) });
      }
      // a footnote, a row and a half below the last bar rather than crowding it
      MI.note = svg("text", { x: 0, y: 6 * 16.5 + 17, "font-size": 11, fill: "var(--claret)" }, MI.el);
    }
    const mmax = list.length ? list[0][1] : 1;
    MI.rows.forEach((r, i) => {
      const it = list[i], gp = it && it[0] === "general-purpose", bw = it ? Math.max(0, (it[1] / mmax) * bwMax) : 0;
      text(r.name, it ? it[0] : "");
      attr(r.name, "font-weight", gp ? 700 : 400); attr(r.name, "fill", gp ? "var(--claret)" : "var(--ink)");
      attr(r.rect, "fill", gp ? "var(--claret)" : "var(--ink2)"); attr(r.rect, "opacity", gp ? 1 : 0.55);
      r.val.style.visibility = it ? "visible" : "hidden";
      if (it) r.n.set(it[1]);
      tf(r.bar, `scaleX(${(bw / bwMax).toFixed(4)})`); tf(r.val, `translateX(${px(bw)}px)`);
    });
    const gp = A.general_purpose || {};
    text(MI.note, gp.share_d14 != null ? `general-purpose ${gp.share_d14}% of spawns` : "");
  }

  // ======================================================================
  // the machine: memory composition and the per-core small multiples
  // ======================================================================
  const macHed = Line($("macHed"));
  const MEM_PARTS = [["wired", 1], ["active", 0.75], ["compressed", 0.5], ["cached", 0.22], ["free", 0.08]];
  const MB = { el: $("memBar"), w: 0, rects: [], labels: [], at: [] };
  const CORES = 10, CORE_S = 45;
  const CR = { el: $("cores"), w: 0, built: false, n: 0 };
  // Load, in five inks (--load0 calm … --load4 over; index.html). A core by % busy: under
  // 25, 50, 75, 90, then over. Memory by the feed's pressure first (critical is over, warn
  // is heavy, as Activity Monitor's graph), then, at normal pressure, by used/total: macOS
  // fills memory by design, so a full machine at normal pressure is busy, never heavy.
  const CORE_AT = [25, 50, 75, 90];
  const coreBand = (v) => { let i = 0; while (i < 4 && v >= CORE_AT[i]) i++; return i; };
  const memBand = (mem, total) => mem.pressure === "critical" ? 4 : mem.pressure === "warn" ? 3
    : mem.used / total < 0.6 ? 0 : mem.used / total < 0.75 ? 1 : 2;
  // the runtime seeds "core:0".."core:9" from hist.cores, so a reload is never empty
  for (let c = 0; c < CORES; c++) K.track("core:" + c, (s) => (s.sys.cores || [])[c], CORE_S);
  // One-second buckets per core, aligned to the clock so old points never re-bucket as
  // the window moves. Kept incrementally: each line adds its own point, and only a
  // re-seed (older history arriving) rebuilds them. At 100 ms that is 10 points a
  // second per core folded in, instead of 450 re-bucketed.
  const CB = [];
  function buckets(c, t) {
    const ser = K.series("core:" + c);
    let b = CB[c];
    if (!b || (ser.length && ser[0].t < b.first)) b = CB[c] = { first: Infinity, last: -Infinity, k: [], sum: [], n: [], max: [] };
    let i = ser.length;
    while (i > 0 && ser[i - 1].t > b.last) i--;
    for (; i < ser.length; i++) {
      const p = ser[i], k = Math.floor(p.t), j = b.k.length - 1;
      if (j >= 0 && b.k[j] === k) { b.sum[j] += p.v; b.n[j]++; if (p.v > b.max[j]) b.max[j] = p.v; }
      else { b.k.push(k); b.sum.push(p.v); b.n.push(1); b.max.push(p.v); }
      b.last = p.t;
    }
    if (ser.length) b.first = ser[0].t;
    const cut = t - CORE_S - 2;
    let d = 0;
    while (d < b.k.length && b.k[d] < cut) d++;
    if (d) for (const a of [b.k, b.sum, b.n, b.max]) a.splice(0, d);
    return b;
  }
  function machine(s) {
    const Y = s.sys, mem = Y.mem || {}, total = mem.total || 1, cores = Y.cores || [];
    text($("macWho"), `This Mac, ${cores.length} cores, ${Math.round(total / GB)} GB`);
    // CPU changes every line and crosses 10% often, so it ends the line (a tail figure,
    // its unit inside): it grows to the right and nothing moves. Memory crosses 10 GB
    // rarely; when it does, the line re-sets.
    macHed.set([{ k: "mem", v: mem.used / GB, f: fx(1) }, ` of ${Math.round(total / GB)} GB used, pressure ${mem.pressure || "unknown"}; CPU at `,
      { k: "cpu", v: Y.cpu, f: (v) => (v >= 99.95 ? "100%" : v.toFixed(1) + "%"), tail: true }]);
    memBar(mem, total);
    coreCharts(s, cores);
  }
  // Five segments, each a full-width sprite placed and sized by one transform per line
  // (translateX, scaleX from its left edge), with its label as a sprite under it.
  // Positions are held to quarter pixels, so megabyte jitter never starts a transition.
  function memBar(mem, total) {
    const w = MB.w;
    if (!w) return;
    if (!MB.rects.length) {
      const box = MB.el.parentNode;
      // the whole of memory as a hairline frame: what the five parts leave over (the
      // kernel's other pages) reads as the unfilled end, not as a bar that stops short
      MB.el.innerHTML = `<rect x=".5" y=".5" width="${w - 1}" height="9" fill="none" stroke="var(--hair)"/>`;
      MEM_PARTS.forEach(([k, op]) => {
        // what counts as used (wired, active, compressed) is printed in the load ink
        const ink = k === "cached" || k === "free" ? "var(--ink)" : "var(--load0)";
        const r = sprite(box, 0, 0, w, 10, `<rect x="0" y="0" width="${w}" height="10" fill="${ink}" opacity="${op}"/>`);
        r.style.transformOrigin = "0 0";
        MB.rects.push(r);
        const end = k === "free";
        MB.labels.push(sprite(box, end ? -200 : 0, 12, 200, 16, `<text x="0" y="24" font-size="11" fill="var(--ink2)"${end ? ' text-anchor="end"' : ""}></text>`));
      });
    }
    // A segment moves only when an edge has travelled a whole CSS pixel (two device
    // pixels). Every transform written is a compositing pass over the page's layers, and
    // at 100 ms memory jitters by a few MB on every line; quarter pixels (pass 2) still
    // moved one segment or another on most lines. 1 px of this bar is about 30 MB.
    const T = total / GB, q = (v) => Math.round(v * 4) / 4;
    // re-ink the used parts only when the band changes (a repaint of three small sprites)
    const band = memBand(mem, total);
    if (band !== MB.band) { MB.band = band; for (let i = 0; i < 3; i++) attr(MB.rects[i].firstChild, "fill", `var(--load${band})`); }
    let x = 0, lastEnd = -1e9;
    MEM_PARTS.forEach(([k], i) => {
      const v = (mem[k] || 0) / GB, bw = (v / T) * w, isFree = k === "free";
      const at = MB.at[i] || (MB.at[i] = [-1e9, -1e9]), bx = Math.max(0, bw - 1.5);
      if (Math.abs(x - at[0]) >= 1 || Math.abs(x + bx - at[0] - at[1]) >= 1) { at[0] = q(x); at[1] = q(bx); }
      tf(MB.rects[i], `translateX(${at[0]}px) scaleX(${(at[1] / w).toFixed(5)})`);
      // label each part under itself; free sits at the right edge; anything that
      // would collide with the label before it stays unlabelled
      const s = `${k} ${r1(v)}`, lw = s.length * 5.6, lx = isFree ? w : at[0];
      const fits = isFree ? w - lw > lastEnd + 8 : bw > 40 && x > lastEnd + 8 && x + lw < w - 52;
      tf(MB.labels[i], `translateX(${px(lx)}px)`);
      text(MB.labels[i].firstChild, fits ? s : "");
      if (fits && !isFree) lastEnd = x + lw;
      x += bw;
    });
  }
  function coreCharts(s, cores) {
    const w = CR.w, n = Math.min(CORES, cores.length);
    if (!w || !n) return;
    const gap = 10, cw = (w - (n - 1) * gap) / n, base = 36, ch = 32;
    // base lines, rules, numbers and figures in #cores; the ten curves on one sliding sprite
    if (!CR.built || CR.n !== n) {
      CR.built = true; CR.n = n; CR.el.innerHTML = "";
      const box = CR.el.parentNode;
      for (const e of box.querySelectorAll(".spr, .cfs")) e.remove();
      CR.lines = []; CR.areas = []; CR.nums = [];
      // The ten figures change together once a second. Ten separate dirty rects in the
      // page's own layer are more than WebKit paints one by one (five), so it repainted
      // the bounding box of everything changed that line, from the headline down to the
      // close. On a layer of their own they are one small strip.
      const row = document.createElement("div");
      row.className = "cfs"; box.appendChild(row);
      for (let c = 0; c < n; c++) {
        const x0 = c * (cw + gap);
        svg("line", { x1: x0, y1: base, x2: x0 + cw, y2: base, stroke: "var(--ink)" }, CR.el);
        // a hairline in the gutter, from the strip's top to under its figure
        if (c) svg("line", { x1: x0 - gap / 2, y1: 2, x2: x0 - gap / 2, y2: base + 16, stroke: "var(--hair)" }, CR.el);
        // the core and its figure: a box as wide as the strip, the figure right-aligned
        // in the rest of it, so "7%" to "14%" never moves its box (an end-anchored SVG
        // text does move: its box is its text)
        const f = document.createElement("div"), lab = document.createElement("span"), fig = document.createElement("b");
        f.className = "cf"; f.style.left = x0.toFixed(1) + "px"; f.style.width = cw.toFixed(1) + "px";
        lab.textContent = c + 1;
        f.append(lab, fig); row.appendChild(f);
        // percent, as the note above says; ten "%" signs left no room between "10"
        // and its figure in a 38 px strip
        CR.nums.push(num(fig, (v) => String(Math.round(v))));
      }
      CR.figs = [...row.children].map((f) => f.lastChild);
      // the over line: 90% busy, dotted in silver, drawn only while the scale reaches it
      CR.over = svg("g", { stroke: "var(--ink2)", "stroke-width": 1, "stroke-dasharray": "1 2", opacity: 0.6, visibility: "hidden" }, CR.el);
      for (let c = 0; c < n; c++) { const x0 = c * (cw + gap); svg("line", { x1: x0, y1: 0, x2: x0 + cw, y2: 0 }, CR.over); }
      CR.scroll = sprite(box, 0, 0, w, base + 1, "");
      // One gradient for all ten curves, keyed to height, not to the path: hard stops at
      // the bands, so a curve is printed in the ink of the load it stands at, and its wash
      // in the bands it covers. Its stops move only when the scale changes.
      const g = svg("linearGradient", { id: "loadInk", gradientUnits: "userSpaceOnUse", x1: 0, y1: base, x2: 0, y2: base - ch }, svg("defs", {}, CR.scroll));
      CR.stops = [];
      for (let i = 0; i < 5; i++) for (const e of [0, 1]) CR.stops.push(svg("stop", { style: `stop-color:var(--load${i})`, "data-e": e }, g));
      CR.top = 0;
      for (let c = 0; c < n; c++) {
        CR.areas.push(svg("path", { fill: "url(#loadInk)", opacity: 0.15 }, CR.scroll));
        CR.lines.push(svg("path", { fill: "none", stroke: "url(#loadInk)", "stroke-width": 1.3 }, CR.scroll));
      }
    }
    // The curves are one-second buckets, so they are redrawn once a second, not per line:
    // within a second a 45 s strip has moved under a device pixel (0.08 px per 100 ms).
    // The figures under them keep the strip's own rate, so each reads as its curve's
    // head; CPU per line is in the headline and the close.
    const secK = Math.floor(s.t);
    if (secK === CR.sec) return;
    CR.sec = secK;
    for (let c = 0; c < n; c++) {
      CR.nums[c].set(cores[c]);
      // the band of the figure as printed, so a "90" is always over
      const f = CR.figs[c], k = cores[c] == null ? "" : "l" + coreBand(Math.round(cores[c]));
      if (f.className !== k) f.className = k;
    }
    // the scale: 0 to 50% unless a core went past it in the window, then 0 to 100%
    const B = [];
    let peak = 0;
    for (let c = 0; c < n; c++) { const b = buckets(c, s.t); B.push(b); for (const m of b.max) if (m > peak) peak = m; }
    const top = peak > 50 ? 100 : 50, pxs = cw / CORE_S;
    if (top !== CR.top) {
      CR.top = top;
      // each band from its floor to its ceiling, as a fraction of the scale (past the top: 1)
      const at = [0, ...CORE_AT, 100].map((v) => Math.min(1, v / top).toFixed(4));
      CR.stops.forEach((e, j) => e.setAttribute("offset", at[(j >> 1) + (j & 1)]));
      const y = (base - (CORE_AT[3] / top) * ch).toFixed(1);
      for (const l of CR.over.children) { l.setAttribute("y1", y); l.setAttribute("y2", y); }
      CR.over.setAttribute("visibility", top >= 100 ? "visible" : "hidden");
    }
    let span = 0;
    for (let c = 0; c < n; c++) {
      const x0 = c * (cw + gap), b = B[c];
      // a three-bucket running mean
      const raw = b.sum.map((v, i) => v / b.n[i]);
      const sm = raw.map((_, i) => { const a = raw.slice(Math.max(0, i - 2), i + 1); return a.reduce((p, q) => p + q, 0) / a.length; });
      let pts = b.k.map((k, i) => [x0 + cw - (s.t - Math.min(s.t, k + 0.5)) * pxs, base - (Math.min(sm[i], top) / top) * ch]);
      // the sliding layer has no clip, so each curve starts exactly at its own left edge
      let f = 0;
      while (f < pts.length && pts[f][0] < x0) f++;
      if (f >= pts.length) pts = [];
      else if (f > 0) { const a = pts[f - 1], q = pts[f], u = (x0 - a[0]) / (q[0] - a[0]); pts = [[x0, a[1] + (q[1] - a[1]) * u]].concat(pts.slice(f)); }
      // seconds really covered (hist.span_s's rule: a step over 5 s is a gap, not data):
      // since the feed keeps hist across a restart, the first bucket can sit before a gap
      if (b.k.length) {
        let cov = Math.min(5, Math.max(0, s.t - b.k[b.k.length - 1]));
        for (let i = 1; i < b.k.length; i++) { const dk = b.k[i] - b.k[i - 1]; if (dk <= 5) cov += dk; }
        span = Math.max(span, cov);
      }
      if (pts.length > 1) {
        const d = mono(pts);
        CR.lines[c].setAttribute("d", d);
        CR.areas[c].setAttribute("d", `${d}L${pts[pts.length - 1][0].toFixed(1)} ${base}L${pts[0][0].toFixed(1)} ${base}Z`);
      }
    }
    // the real window, never padded; "last 0 s" before a second of history says nothing
    const win = Math.min(CORE_S, Math.round(span));
    text($("coreHd"), win >= 2 ? `Per core, last ${win} s` : "Per core");
    text($("coreScale"), `scale 0 to ${top}%, figure is % now`);
    // The curves are redrawn once per line with the new point at the right edge. They
    // also slide left by the time it covers, but only when that is a device pixel or
    // more: a 45 s strip moves 0.08 px per 100 ms, and there the redraw is the motion.
    const dx = CR.lastT ? (s.t - CR.lastT) * pxs : 0;
    CR.lastT = s.t;
    if (dx * (window.devicePixelRatio || 1) >= 1 && dx < cw) {
      if (CR.slide) CR.slide.cancel();
      CR.slide = play(CR.scroll, [{ transform: `translateX(${dx.toFixed(2)}px)` }, { transform: "none" }], K.tweenMs, "linear");
    }
  }

  // ======================================================================
  // the close: a fixed board of quotes, figures changing in place
  // ======================================================================
  // each figure is right-aligned in a slot sized in index.html for its widest value
  const C = {
    out: num($("cOut"), int), week: num($("cWeek"), (v) => Math.round(v) + "%"),
    cpu: num($("cCpu"), (v) => (v >= 99.95 ? "100%" : v.toFixed(1) + "%")),
    gpu: num($("cGpu"), (v) => Math.round(v) + "%"), mem: num($("cMem"), fx(1, " GB")),
    swap: num($("cSwap"), (v) => v.toFixed(v >= 10 ? 1 : 2) + " GB"),
    rx: num($("cRx"), rate), tx: num($("cTx"), rate), disk: num($("cDisk"), (v) => Math.round(v) + " GB free"),
    load: num($("cLoad"), fx(2)), batt: num($("cBatt"), (v) => Math.round(v) + "%"),
  };
  // a change: the figure in its slot, the drawn triangle at the slot's left edge
  function delta(el, d, f) {
    const c = "v d " + (d > 0 ? "up" : d < 0 ? "dn" : "dim");
    if (el.className !== c) el.className = c;
    text(el, d > 0 ? f(d) : d < 0 ? f(-d) : "unch");
  }
  // a battery estimate in hours and minutes; seconds would be false precision
  const hm = (min) => { min = Math.round(min); const h = Math.floor(min / 60); return h ? `${h} h ${min % 60} m` : `${min} m`; };
  function close(s) {
    const Y = s.sys, opm = s.claude.tokens.out_per_min || [], H = s.claude.limits.history || [], L7 = s.claude.limits.seven_day || {};
    text($("cLead"), `At the close, ${F.clock(s.t)}`);
    const a = opm[opm.length - 2] || 0, b = opm[opm.length - 3] || 0;
    C.out.set(a); delta($("cOutD"), a - b, int);
    C.week.set(L7.pct);
    if (H.length > 1) delta($("cWeekD"), Math.round(H[H.length - 1][2] - H[H.length - 2][2]), String); else text($("cWeekD"), "");
    C.cpu.set(Y.cpu); C.gpu.set(Y.gpu); C.mem.set(Y.mem.used / GB); C.swap.set(Y.swap / GB);
    C.rx.set(Y.net.rx_bps); C.tx.set(Y.net.tx_bps); C.disk.set(Y.disk.free / 1e9); C.load.set(Y.load[0]);
    const bt = Y.batt || {};
    C.batt.set(bt.pct);
    text($("cBattN"), bt.pct == null ? "" : bt.charging ? ", charging" : bt.ac ? ", on power" : bt.mins_left ? ", " + hm(bt.mins_left) + " left" : "");
  }

  // ======================================================================
  // edition, layout, period, sizing
  // ======================================================================
  let edition = null;
  // The host's appearance menu: "light" prints the Day edition and "dark" the Night one (paper
  // and ink; the weather plate's sky stays the real one). "auto" is config.js's edition (the
  // sun, or a pinned one).
  // A dev ?edition= (the ink only, as before) wins over it.
  function forcedEd() {
    if (Q.get("edition")) return null;
    return K.appearance === "light" ? "day" : K.appearance === "dark" ? "night" : null;
  }
  // a sunrise or sunset re-inks over fade_s; a change he makes in the menu, over 0.6 s
  let fadeMs = CFG.fade_s * 1000;
  function wantEdition(s) {
    const forced = Q.get("edition") || forcedEd() || (CFG.edition !== "auto" ? CFG.edition : null);
    if (forced === "day" || forced === "night") return forced;
    return sunEdition(s);
  }
  // day or night by the sun alone (weather.sunrise/sunset), whatever the appearance forces
  function sunEdition(s) {
    const W = s.weather;
    // no weather: fall back to the system appearance, which is what the CSS shows too
    if (!W || !W.sunrise || !W.sunset) return matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day";
    // shift the reported times to today, so a report from yesterday still switches
    const sh = Math.round((midnightOf(s.t) - midnightOf(W.sunrise)) / 86400) * 86400;
    return s.t >= W.sunrise + sh && s.t < W.sunset + sh ? "day" : "night";
  }
  function midnightOf(t) { const d = local(t); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; }
  // The two printings, as in the stylesheet. They are inverses, so a straight colour
  // morph would pass through a moment where ink equals paper and the page goes
  // unreadable grey. Instead the change at sunrise and sunset is a re-inking over
  // fade_s: the stock glides from one paper to the other, the ink lifts off by the
  // midpoint, the new ink is laid, and it comes back up. It is set inline on :root
  // and handed back to [data-theme] once it lands. Twice a day, so it may cost a
  // full-page repaint per frame; it runs on Kiln.loop at 20 fps, as Kiln.tween is
  // clamped to part of a period.
  const INKS = {
    day: { paper: "#F0DFD0", tint: "#E7D1BF", ink: "#1C2430", ink2: "#4A4440", claret: "#8A1F3D", teal: "#0B5A63",
      hair: "rgba(28,36,48,.22)", grain: "rgba(28,36,48,.035)", idle: "#86735F", bgstate: "#7C6A5C",
      rule: "#1C2430", accent: "#8A1F3D", gold: "#1C2430", "gold-hi": "#1C2430", "gold-lo": "#1C2430", press: "#6E1530",
      load0: "#2A7462", load1: "#3A7030", load2: "#636612", load3: "#784608", load4: "#8A1F3D" },
    // black paper; white, silver and gold inks, vermilion for alerts, verdigris for the live
    night: { paper: "#12100E", tint: "#1D1915", ink: "#F2EDE4", ink2: "#BCBAB4", claret: "#F99B70", teal: "#7CC6A6",
      hair: "rgba(188,186,180,.24)", grain: "rgba(242,237,228,.035)", idle: "#858280", bgstate: "#9A9792",
      rule: "#BCBAB4", accent: "#DBB762", gold: "#DBB762", "gold-hi": "#F1D78A", "gold-lo": "#D4AE5A", press: "#FFB894",
      load0: "#7CC6A6", load1: "#9DD08A", load2: "#C3D673", load3: "#E8D9A0", load4: "#F99B70" },
  };
  const rgba = (c) => c[0] === "#" ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).concat(1) : c.match(/[\d.]+/g).map(Number);
  let inking = null;   // the stop function of a re-inking in progress
  function applyEdition(ed) {
    if (ed === edition) return;
    const from = edition;
    root.dataset.theme = ed;
    edition = ed;
    const page = $("page");
    // a re-inking still running (the menu flipped twice) is cut short; this one starts clean
    if (inking) { inking(); inking = null; for (const name in INKS.day) root.style.removeProperty("--" + name); page.style.opacity = ""; }
    if (!from) return;
    const A = INKS[from], B = INKS[ed], pa = rgba(A.paper), pb = rgba(B.paper);
    let side = null, paper = null;
    inking = slow(fadeMs, (k) => {
      if (k >= 1) {
        for (const name in A) root.style.removeProperty("--" + name);
        page.style.opacity = "";
        inking = null;
        return;
      }
      const e = k * k * (3 - 2 * k), m = pa.map((v, i) => v + (pb[i] - v) * e);
      const p = `rgb(${m[0].toFixed(0)},${m[1].toFixed(0)},${m[2].toFixed(0)})`;
      if (p !== paper) { paper = p; root.style.setProperty("--paper", p); }
      const inks = k < 0.5 ? A : B;
      if (inks !== side) { side = inks; for (const name in inks) if (name !== "paper") root.style.setProperty("--" + name, inks[name]); }
      page.style.opacity = Math.abs(1 - 2 * k).toFixed(3);
    });
  }
  let layout = null;
  function wantLayout(s) {
    let l = Q.get("layout") || CFG.layout;
    if (l === "auto") { const d = local(s.t).getDay(); l = d === 0 || d === 6 ? "weekend" : "daily"; }
    return ["daily", "weekend", "brief"].includes(l) ? l : "daily";
  }
  let dirty = true;
  function measure() {
    REM = parseFloat(getComputedStyle(root).fontSize) || 16;
    LC.w = fit(LC.el, 146); SB.w = fit(SB.el, 40); OC.w = fit(OC.el, 112);
    DY.w = fit(DY.el, 112); MX.w = fit(MX.el, 118); MI.w = fit(MI.el, 118);
    MB.w = fit(MB.el, 30); CR.w = fit(CR.el, 52);
    // every width the update path needs is read here, never between writes
    CAL.avail = CAL.el.parentNode.clientWidth;
    VG.w = Math.round($("vig").clientWidth); VG.h = Math.round($("vig").clientHeight);
    { const p = $("earA"); EAR.room = Math.max(24, Math.floor(p.clientWidth / (parseFloat(getComputedStyle(p).fontSize) * 0.5))); }
    LC.sig = SB.sig = OC.sig = DY.sig = MX.sig = MI.sig = CAL.sig = null;
    CAL.G = MX.A = MI.A = SB.A = DY.A = CR.sec = null;
    // sprites are sized to their chart: rebuilt at the new width
    for (const e of MB.el.parentNode.querySelectorAll(".spr")) e.remove();
    for (const e of MI.el.parentNode.querySelectorAll(".spr")) e.remove();
    MB.rects = []; MB.labels = []; MB.at = [];
    MI.rows = null; MI.el.innerHTML = "";
    CR.built = false;
    for (const l of [earHed, leadHed, leadDeck, deskHed, condL, outHed, ghHed, ghDeck, macHed]) l.refit();
    dirty = false;
  }
  addEventListener("resize", () => { dirty = true; });
  if (document.fonts) document.fonts.ready.then(() => { dirty = true; if (K.state) render(K.state, null); });

  // the period readout: btop's corner. The dot pulses once per update; a change of
  // period lights the readout claret for 1.5 s.
  let litAnims = [];
  function showPeriod(ms, lit) {
    text($("periodMs"), String(ms));
    if (!lit) return;
    const el = $("period");
    // claret held for the first 0.6 s, then fading out over the rest of the 1.5 s; the
    // type stays paper-coloured until the claret has mostly gone. A Web Animation:
    // a tween would be clamped to part of the period.
    for (const a of litAnims) a.cancel();
    const ink = [{ offset: 0, color: "var(--paper)" }, { offset: 0.84, color: "var(--paper)" }, {}];
    litAnims = [
      play(el, [{ offset: 0, backgroundColor: "var(--claret)" }, { offset: 0.6, backgroundColor: "var(--claret)" }, {}], 1500, "linear"),
      play(el, ink, 1500, "linear"), play(el.querySelector("b"), ink, 1500, "linear"),
    ].filter(Boolean);
  }
  // the period the host reports at load is not a change he made, so nothing lights
  // until the first line has been drawn
  let drawn = false;
  showPeriod(K.period, false);
  K.onPeriod((ms) => showPeriod(ms, drawn));

  function run(fn, s) { try { fn(s); } catch (e) { console.error(e); } }
  // Rule 8a.6b: per-line work, not frames, is what this page cost (5.4% at 300 ms with
  // no frames). A sticky block the feed did not re-send keeps its identity, so an
  // unchanged block is one comparison and its section is skipped. Per line run only
  // what reads the fast data: the mast, the sessions, the machine and the close. The
  // allowance's countdowns run once a second; the weather and the Commits desk also
  // once a minute, for their clock-derived words. measure() clears every drawn
  // signature, so after it (and on an edition change) every section draws.
  let lastSec = null, lastMin = null, lastEd = null;
  function render(s, prev) {
    applyEdition(wantEdition(s));
    const l = wantLayout(s);
    if (l !== layout) { layout = l; $("page").dataset.layout = l; dirty = true; }
    const all = dirty || !prev || edition !== lastEd;
    if (dirty) measure();
    const c = s.claude || {}, pc = (prev && prev.claude) || {}, p = prev || {};
    const sec = Math.floor(s.t), min = Math.floor(s.t / 60), newSec = all || sec !== lastSec, newMin = all || min !== lastMin;
    lastSec = sec; lastMin = min; lastEd = edition;
    const tok = all || c.tokens !== pc.tokens, an = all || s.analytics !== p.analytics;
    run(mast, s);
    if (newSec || c.limits !== pc.limits) run(lead, s);
    run(desk, s);
    if (newMin || s.weather !== p.weather) run(weather, s);
    if (tok || an) run(output, s);
    if (newMin || s.github !== p.github) run(commits, s);
    if (newMin || tok || an) run(fortnight, s);
    run(machine, s); run(close, s);
  }
  K.on((s, prev) => {
    render(s, prev);
    drawn = true;
    text($("periodMs"), String(K.period));
  });
  // The host's menu, live. A new appearance re-inks the page and the plate over 0.6 s (a
  // sunset takes fade_s); a new unit re-prints the temperatures at once (a null first cancels
  // any glide from 53 to 12). render(s, null) redraws every section, as after a resize.
  K.onPrefs(() => {
    if (!K.state) return;
    tempN.set(null);
    fadeMs = 600;
    try { render(K.state, null); } finally { fadeMs = CFG.fade_s * 1000; }
  });
  // The live dot beats on Kiln.onBeat, about once a second at any period, never per
  // line (at 100 ms a per-line pulse strobed). Opacity only, a soft rise and fall over
  // 600 ms, run by the compositor. When lines stop, html.kiln-stale turns it into a
  // hollow ring (the CSS).
  const dot = $("pulse");
  K.onBeat(() => play(dot, [{ opacity: 0.65 }, { opacity: 1, offset: 0.4 }, { opacity: 0.65 }], 600, "ease-in-out"));
})();
