#!/usr/bin/env node
// dev-audit.mjs: a one-minute recording and a layout-shift audit of one design.
//
//   node dev-audit.mjs <design dir> <out dir> [--seconds 60] [--period 100]
//                      [--weather rain] [--no-video] [--no-home]
//
// Runs the design in WebKit (the wallpaper's own engine, via Playwright) in real time,
// replaying the captured feed (?fixture) at --period, with the Dock and notch drawn on
// top (?home). Writes to <out dir>:
//   video.webm      the whole run, 1512x982 (what a screen recording would show)
//   frame-NN.png    a 2x still every 10 s, for nitpicking detail
//   audit.txt       what moved. After every update the page's layout is sampled
//                   (offset boxes, which ignore transforms, so tweened bars and
//                   needles do not count). It lists:
//                   MOVED       elements whose layout x/y changed: tiles, rows or labels
//                               shoved by a neighbour whose text changed width. The
//                               defect reported on 2026-11-05.
//                   RESIZED     boxes (not bare text) whose size changed.
//                   PROPORTIONAL text with changing digits set without tabular figures.
//                   ERRORS      console errors.
//
// ENGINE: chrome-headless-shell by default, never Playwright's WebKit on this Mac.
// Measured 2026-11-05 from the WindowServer log while the Mac was in use:
//   - Playwright's "headless" WebKit is a real app (Playwright.app). It made itself the
//     frontmost process 28 times in one evening. On every exit, macOS handed focus to
//     another app and the Dock reopened or relaunched it (Messages, Mail): "apps
//     popping out by themselves".
//   - Its offscreen windows are real windows. Mission Control showed them flying
//     across the screen (a screen recording, 12:55 am: a Glass render frozen at the
//     fixture's 10:34 pm).
// chrome-headless-shell has no bundle, no window and no WindowServer focus, and
// produced 0 front events in the same log. Layout-shift findings (offsets, tabular
// figures) are engine-independent. Judge WebKit rendering itself on the real host:
// `KilnWall --snapshot` is an LSUIElement app whose window sits below the desktop.
// `--engine webkit` remains for a deliberate check when nobody is using the Mac.
import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// playwright-core: $PLAYWRIGHT_CORE (or the older $KILN_PLAYWRIGHT), a path to its index.mjs,
// else the repo's devDependency (npm install at the repo root).
const PW = process.env.PLAYWRIGHT_CORE || process.env.KILN_PLAYWRIGHT || "playwright-core";
const { webkit, chromium } = await import(PW);
const engineArg = (() => { const i = process.argv.indexOf("--engine"); return i < 0 ? "chromium" : process.argv[i + 1]; })();
// Through chrome-bg.sh: at most two headless renders at once across all agents, at
// background QoS (2026-11-05: parallel renders pinned all ten cores while the Mac was in use).
const SHELL = new URL("./chrome-bg.sh", import.meta.url).pathname;

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const has = n => args.includes(n);
const dir = resolve(args[0] || ""), out = resolve(args[1] || "");
if (!args[0] || !args[1]) { console.error("usage: dev-audit.mjs <design dir> <out dir> [--seconds 60] [--period 100] [--weather kind] [--no-video] [--no-home]"); process.exit(2); }
const seconds = +flag("--seconds", 60), period = +flag("--period", 100), weather = flag("--weather", "");
mkdirSync(out, { recursive: true });

const q = new URLSearchParams({ period: String(period) });
q.set("fixture", ""); if (!has("--no-home")) q.set("home", ""); if (weather) q.set("weather", weather);
const url = "file://" + join(dir, "index.html") + "?" + q.toString().replace(/=(&|$)/g, "$1");

const browser = engineArg === "webkit"
  ? await webkit.launch()
  : await chromium.launch({ executablePath: SHELL, args: ["--allow-file-access-from-files"] });
const ctx = await browser.newContext({
  viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2,
  // Video only on request (--video): the audit and the 2x stills are what find defects,
  // and recordings that don't earn their keep are not wanted (2026-11-05).
  ...(has("--video") ? { recordVideo: { dir: out, size: { width: 1512, height: 982 } } } : {}),
});
const page = await ctx.newPage();
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
page.on("pageerror", e => errors.push(String(e).slice(0, 300)));
await page.goto(url);
await page.waitForFunction(() => window.Kiln && window.Kiln.state, null, { timeout: 15000 });

// The sampler: after each update, once the frame has rendered, record every element's
// layout box. Keys are per element (a WeakMap id), so keyed rows that are replaced
// count as new elements, not as movement.
await page.evaluate(() => {
  const ids = new WeakMap(); let nid = 0;
  const rec = new Map();   // id -> {name, xs:Set, ys:Set, ws:Set, hs:Set, seen, box, digits:Set, tab}
  let samples = 0;
  const skip = el => el.closest(".hs-dock, .hs-notch");
  function name(el) {
    const part = e => {
      let s = e.tagName.toLowerCase();
      if (e.id) return s + "#" + e.id;
      const c = (e.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (c.length) s += "." + c.join(".");
      const r = e.dataset && e.dataset.r; if (r) s += `[r=${r}]`;
      return s;
    };
    const path = []; let e = el;
    for (let i = 0; e && e !== document.body && i < 4; i++, e = e.parentElement) { path.unshift(part(e)); if (e.id) break; }
    const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    return path.join(" > ") + (t ? `  "${t}"` : "");
  }
  function abs(el) {
    let x = 0, y = 0, e = el;
    while (e) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    return [x, y];
  }
  function sample() {
    samples++;
    for (const el of document.body.querySelectorAll("*")) {
      if (skip(el)) continue;
      let x, y, w, h;
      if (el instanceof HTMLElement) {
        if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;   // display:none
        [x, y] = abs(el); w = el.offsetWidth; h = el.offsetHeight;
      } else if (el instanceof SVGTextElement) {
        let b; try { b = el.getBBox(); } catch (e) { continue; }
        if (!b.width) continue;
        // in its own user space; measure the edge the text is anchored at, so a
        // right- or centre-anchored label whose far edge moves is not reported
        const an = getComputedStyle(el).textAnchor;
        x = an === "end" ? b.x + b.width : an === "middle" ? b.x + b.width / 2 : b.x;
        y = b.y; w = b.width; h = b.height;
      } else continue;
      let id = ids.get(el); if (id == null) { id = ++nid; ids.set(el, id); }
      let r = rec.get(id);
      if (!r) {
        const cs = getComputedStyle(el);
        const leaf = !el.children.length;
        const box = !leaf || cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0;
        r = { el: new WeakRef(el), name: name(el), xs: new Set(), ys: new Set(), ws: new Set(), hs: new Set(),
          seen: 0, box, svg: el instanceof SVGTextElement, digits: new Set(),
          tab: /tabular-nums/.test(cs.fontVariantNumeric) || /tnum/.test(cs.fontFeatureSettings) };
        rec.set(id, r);
      }
      r.seen++;
      r.xs.add(Math.round(x * 2) / 2); r.ys.add(Math.round(y * 2) / 2);
      r.ws.add(Math.round(w * 2) / 2); r.hs.add(Math.round(h * 2) / 2);
      // leaf elements, plus whole SVG <text> (its figures often live in <tspan>s)
      if (!el.children.length || r.svg) { const t = (el.textContent || "").trim(); if (/\d/.test(t) && r.digits.size < 50) r.digits.add(t); }
    }
  }
  Kiln.on(() => requestAnimationFrame(() => setTimeout(sample, 0)));
  window.__audit = () => {
    const span = s => { const a = [...s]; return a.length > 1 ? Math.max(...a) - Math.min(...a) : 0; };
    const moved = [], resized = [], prop = [];
    for (const [id, r] of rec) {
      if (r.seen < samples * 0.5) continue;           // transient (entering/leaving)
      const dx = span(r.xs), dy = span(r.ys), dw = span(r.ws), dh = span(r.hs);
      const row = { id, name: r.name, dx, dy, dw, dh, nx: r.xs.size, el: r.el.deref() };
      if ((dx > 0.5 || dy > 0.5) && !r.svg) moved.push(row);
      else if (r.svg && dx > 0.5 && r.digits.size > 1) moved.push(Object.assign(row, { name: row.name + "  (svg text: its anchor edge moves)" }));
      if (!r.svg && r.box && (dw > 0.5 || dh > 0.5)) resized.push(row);
      if (r.digits.size > 1 && !r.tab) prop.push(r.name);
    }
    // report only the outermost: drop an element whose ancestor moved by the same span
    const top = rows => {
      const set = new Set(rows.map(r => r.el).filter(Boolean));
      return rows.filter(r => { let p = r.el && r.el.parentElement; while (p) { if (set.has(p)) return false; p = p.parentElement; } return true; });
    };
    const fmt = r => `  ${r.name}\n      dx ${r.dx}  dy ${r.dy}  dw ${r.dw}  dh ${r.dh}  (${r.nx} x-positions)`;
    return { samples, moved: top(moved).map(fmt), resized: top(resized).map(fmt), prop };
  };
});

const t0 = Date.now();
let k = 0;
while (Date.now() - t0 < seconds * 1000) {
  await page.waitForTimeout(Math.min(10000, seconds * 1000 - (Date.now() - t0)));
  k++;
  await page.screenshot({ path: join(out, `frame-${String(k).padStart(2, "0")}.png`) });
}
const a = await page.evaluate(() => window.__audit());
const stats = await page.evaluate(() => { const s = Kiln.stats; return { frames: s.frames, updates: s.updates, secs: (performance.now() - s.t0) / 1000 }; });
await ctx.close(); await browser.close();
for (const f of readdirSync(out)) if (f.endsWith(".webm") && f !== "video.webm") renameSync(join(out, f), join(out, "video.webm"));

const txt = [
  `dev-audit ${dir}  ${seconds}s at ${period} ms${weather ? "  weather=" + weather : ""}  (${engineArg}, fixture replay)`,
  `samples ${a.samples}; runtime ${stats.updates} updates, ${(stats.frames / stats.secs).toFixed(1)} frames/s`,
  "", `MOVED (${a.moved.length})`, ...a.moved,
  "", `RESIZED (${a.resized.length})`, ...a.resized,
  "", `PROPORTIONAL digits (${a.prop.length})`, ...a.prop.map(s => "  " + s),
  "", `ERRORS (${errors.length})`, ...[...new Set(errors)].slice(0, 20).map(s => "  " + s), "",
].join("\n");
writeFileSync(join(out, "audit.txt"), txt);
console.log(txt);
