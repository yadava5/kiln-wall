// geomcheck.mjs <design dir> <feed.jsonl> [--verbose]
// Tile-geometry stress gate. Replays a recorded live feed, then drives the design through the
// transitions a real day produces (agents spawning and returning, a session going quiet for an
// hour, sessions opening and closing 1..6, a session waiting/failing, long names), and after every
// update records the box of every tile (each top-level child of #cards) and every chart/svg/canvas
// inside one. FAIL if any of them ever changes position or size. Tiles must be fixed.
// The feed is a .jsonl recording or a fixture.js (window.KILN_FIXTURE = {lines: [...]}); default
// ../fixture.js, the synthetic demo feed. playwright-core: $PLAYWRIGHT_CORE (a path to its
// index.mjs) if set, else the repo's devDependency. Chromium: chrome-bg.sh beside this folder.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || "playwright-core");
const SHELL = new URL("../chrome-bg.sh", import.meta.url).pathname;
const pos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dir = resolve(pos[0] || "");
if (!pos[0]) { console.error("usage: geomcheck.mjs <design dir> [feed.jsonl|fixture.js] [--verbose]"); process.exit(2); }
const feed = pos[1] ? resolve(pos[1]) : new URL("../fixture.js", import.meta.url).pathname;
const verbose = process.argv.includes("--verbose");
const text = readFileSync(feed, "utf8");
// A fixture carries the sticky blocks (analytics, github, hist, weather, events, limits, tokens)
// only on the lines where they changed; fill them forward so every replayed line is complete.
const lines = /\.js$/.test(feed)
  ? (() => {
      const raw = JSON.parse(text.slice(text.indexOf("{", text.indexOf("KILN_FIXTURE")), text.lastIndexOf("}") + 1)).lines;
      const last = {}, lastC = {};
      return raw.map((l) => {
        const x = structuredClone(l);
        for (const k of ["analytics", "github", "hist", "weather"]) { if (k in x) last[k] = x[k]; else if (k in last) x[k] = last[k]; }
        for (const k of ["events", "limits", "tokens"]) { if (k in x.claude) lastC[k] = x.claude[k]; else if (k in lastC) x.claude[k] = lastC[k]; }
        return x;
      });
    })()
  : text.split("\n").filter(Boolean).map((s) => JSON.parse(s));

// ---- synthetic stress steps, built from the last recorded state ----
const base = structuredClone(lines[lines.length - 1]);
const sessions0 = base.claude.sessions;
const proto = sessions0[0], agentProto = (base.claude.agents_running || [])[0] || { id: "x", type: "builder", desc: "task", started: base.t - 300, age_s: 300, idle_s: 10 };
const names = ["atlas-api", "billing-migration", "design-system", "data-pipeline", "mobile-release", "a-session-with-a-rather-long-folder-name-indeed"];
const mkSess = (i) => ({ ...structuredClone(sessions0[i % sessions0.length] || proto), sid: "sid-" + i, name: names[i], pid: 1000 + i, since: base.t - 600 * (i + 1),
  out_per_min: Array.from({ length: 60 }, (_, m) => ((m * 7 + i * 13) % 11 > 6 ? 900 + 300 * i : 0)), out_15m: 20000, state: i === 0 ? "working" : "idle" });
const mkAgents = (spec, sess) => spec.flatMap((k, i) => Array.from({ length: k }, (_, j) => ({ ...agentProto, id: `ag${i}-${j}`, sid: sess[i].sid, session: sess[i].name,
  type: ["designer", "builder", "tester", "reviewer"][j % 4], desc: j % 2 ? "A deliberately long agent description that will not fit on one line at all" : "short task", started: base.t - 60 * (j + 1), age_s: 60 * (j + 1), idle_s: 5 })));
const step = (label, nSess, agentSpec, tweak) => {
  const s = structuredClone(base); s.t = base.t + steps.length;
  const sess = Array.from({ length: nSess }, (_, i) => mkSess(i));
  agentSpec = agentSpec.slice(0, nSess);
  sess.forEach((x, i) => (x.agents_running = agentSpec[i] || 0));
  s.claude.sessions = sess; s.claude.agents_running = mkAgents(agentSpec, sess);
  if (tweak) tweak(s, sess);
  steps.push({ label, s });
};
const steps = [];
for (const n of [2, 1, 2, 3, 4, 5, 6, 3, 2]) {
  step(`${n} sessions, no agents`, n, []);
  step(`${n} sessions, 1 agent on #0`, n, [1]);
  step(`${n} sessions, 3 agents on #0, 2 on #1`, n, [3, 2]);
  step(`${n} sessions, 6 agents on #0, 1 each on rest`, n, [6, 1, 1, 1, 1, 1]);
  step(`${n} sessions, agents back`, n, []);
  step(`${n} sessions, #0 quiet for the hour`, n, [], (s, x) => { x[0].out_per_min = x[0].out_per_min.map(() => 0); x[0].out_15m = 0; x[0].state = "idle"; });
  step(`${n} sessions, #1 quiet for the hour`, n, [], (s, x) => { if (x[1]) { x[1].out_per_min = x[1].out_per_min.map(() => 0); x[1].out_15m = 0; } });
  step(`${n} sessions, #0 waiting on an ask`, n, [1], (s, x) => { x[0].state = "waiting"; x[0].ask = { text: "Which of these three layouts do you want, A, B or C? Long question text here.", since: s.t - 90, tool: "AskUserQuestion" }; });
  step(`${n} sessions, #0 failed`, n, [], (s, x) => { x[0].state = "failed"; });
  step(`${n} sessions, null context on #0`, n, [], (s, x) => { x[0].ctx_pct = null; x[0].ctx_tokens = null; });
}

const b = await chromium.launch({ executablePath: SHELL, args: ["--allow-file-access-from-files"] });
const p = await (await b.newContext({ viewport: { width: 1512, height: 982 } })).newPage();
const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
p.on("console", (m) => { if (m.type() === "error" || /TypeError/i.test(m.text())) errs.push(m.text().slice(0, 160)); });
await p.goto("file://" + dir + "/index.html");
await p.waitForFunction(() => window.kiln && window.kiln.update, null, { timeout: 15000 });

const snap = () => p.evaluate(() => {
  // tiles are the children of #cards, or of the first element that holds more than one child
  // (a design that wraps everything in one <main> is measured one level down)
  let root = document.getElementById("cards") || document.body; const out = {};
  while (root.children.length === 1 && root.firstElementChild.children.length) root = root.firstElementChild;
  const keyOf = (e, i) => e.id || `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}#${i}`;
  [...root.children].forEach((t, i) => {
    if (/pulse|bead|spark|flash/.test(t.className)) return;
    const cs = getComputedStyle(t); if (cs.display === "none" || cs.visibility === "hidden") return;
    const k = keyOf(t, i), r = t.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    out[k] = [r.x, r.y, r.width, r.height].map(Math.round).join(",");
    // charts: a .chart box itself; an svg/canvas by the box that frames it (its parent), so a
    // data sprite drawn inside a fixed frame (a bar segment, a scrolling strip) is content, not
    // geometry, while the frame moving or resizing still fails. Keys are structural (nearest
    // ancestor id + position among same-tag siblings), so inserting a node elsewhere can't
    // rename every later chart.
    const sk = (e) => { const parts = []; for (let n = e; n && n !== t; n = n.parentElement) { if (n.id) { parts.unshift("#" + n.id); break; } const sib = [...n.parentElement.children].filter((s) => s.tagName === n.tagName); parts.unshift(n.tagName.toLowerCase() + (sib.length > 1 ? `[${sib.indexOf(n)}]` : "")); } return parts.join(">"); };
    const seen = new Set();
    t.querySelectorAll(".chart, svg, canvas").forEach((c) => {
      if (c.tagName.toLowerCase() === "svg" && c.parentElement.closest("svg")) return;
      const box = c.classList.contains("chart") ? c : c.parentElement;
      if (!box || box === t || seen.has(box)) return; seen.add(box);
      const q = box.getBoundingClientRect(); if (q.width < 2 || q.height < 2) return;
      out[`${k} > ${sk(box)}`] = [q.x, q.y, q.width, q.height].map(Math.round).join(",");
    });
  });
  return out;
});

const changes = []; let ref = null, refLabel = "";
const check = async (label, payload) => {
  await p.evaluate((x) => window.kiln.update(x), JSON.stringify(payload));
  const g = await snap();
  if (!ref) { ref = g; refLabel = label; return; }
  for (const k of new Set([...Object.keys(ref), ...Object.keys(g)])) {
    if (ref[k] !== g[k]) changes.push({ label, k, from: ref[k] || "absent", to: g[k] || "absent" });
  }
  ref = g; refLabel = label;
};
for (let i = 0; i < lines.length; i++) await check(`feed line ${i}`, lines[i]);
const feedChanges = changes.length;
for (const st of steps) await check(st.label, st.s);
await b.close();

const byStep = new Map(); for (const c of changes) { if (!byStep.has(c.label)) byStep.set(c.label, []); byStep.get(c.label).push(c); }
console.log(`replayed ${lines.length} feed lines + ${steps.length} stress steps; tiles tracked ${Object.keys(ref).length}; page errors ${errs.length}${errs[0] ? " (" + errs[0] + ")" : ""}`);
console.log(`geometry changes: ${changes.length} (${feedChanges} during the recorded feed) across ${byStep.size} updates`);
let shown = 0;
for (const [label, cs] of byStep) {
  if (!verbose && shown++ >= 12) { console.log(`… ${byStep.size - 12} more updates with changes (--verbose)`); break; }
  console.log(`  after "${label}": ${cs.length} moved/resized/appeared/vanished, e.g. ${cs.slice(0, 3).map((c) => `${c.k} ${c.from} -> ${c.to}`).join("; ")}`);
}
console.log(changes.length || errs.length ? "FAIL" : "PASS");
process.exit(changes.length || errs.length ? 1 : 0);
