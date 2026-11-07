#!/usr/bin/env node
// make-fixture.mjs: a deterministic, seeded, SYNTHETIC kiln-feed replay for the designs' ?fixture mode.
//
//   node demo/make-fixture.mjs [out.js] [--seed 20261104] [--lines 180]
//   npm run fixture
//
// Writes window.KILN_FIXTURE = {lines: [...]} (default: designs/_shared/fixture.js): one line per
// 250 ms period, in the exact shape `feed/kiln-feed.py --stream` prints (see docs/designing.md,
// "The feed line"). Every value is invented here: there is no capture of any machine in it, and
// the same seed always writes the same bytes.
//
// The picture it paints, over ~45 s from Wed 4 Nov 2026 15:10 (UTC-5):
//   - three open sessions: "atlas-api" working (Opus, agents starting and finishing),
//     "billing-migration" waiting on a question, "docs-site" idle with no model or context yet;
//   - a weekly limit at 41% (42% partway through), on a pace that runs out before the reset;
//   - 14 days of analytics (by model, by hour), a GitHub block for the fake user `demo-user`
//     (a push lands mid-replay), machine stats with generic processes, "Demo City" weather,
//     and two minutes of `hist`.
// Like the real feed, the sticky blocks (weather, github, analytics, hist, claude.events,
// claude.limits, claude.tokens) appear only on lines where they changed; line 0 has them all.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const SEED = +opt("--seed", 20261104);
const N = +opt("--lines", 180);
const skip = new Set(["--seed", "--lines"].flatMap((n) => { const i = args.indexOf(n); return i < 0 ? [] : [i, i + 1]; }));
const outArg = args.find((a, i) => !skip.has(i) && !a.startsWith("--"));
const OUT = resolve(outArg || resolve(dirname(fileURLToPath(import.meta.url)), "../designs/_shared/fixture.js"));

// ---------- deterministic randomness ----------
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(SEED);
const R = (a, b) => a + (b - a) * rnd();
const RI = (a, b) => Math.floor(R(a, b + 1));
// hash noise: the same (i, k) always gives the same value, so a hist sample and the line at the
// same moment agree
function hn(i, k) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(k | 0, 668265263) + Math.imul(SEED | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// a smooth 0..1 wave per channel k
const sm = (t, k) => 0.5 + 0.5 * (0.6 * Math.sin(t / 23 + k * 1.7) + 0.4 * Math.sin(t / 7.3 + k * 4.1));
const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[RI(0, 15)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[RI(0, 3)]}${hex(3)}-${hex(12)}`;
const agentId = () => "a" + hex(16);

// ---------- time ----------
const T0 = Date.UTC(2026, 10, 4, 20, 10, 0) / 1000;   // Wed 4 Nov 2026, 15:10 at UTC-5
const TZ = -5 * 3600;                                 // the demo's local offset (fixed: deterministic)
const STEP = 0.2505;                                  // a 250 ms period, as a real stream drifts
const lineT = (i) => Math.round((T0 + i * STEP) * 1000) / 1000;
const localDate = (t) => new Date((t + TZ) * 1000).toISOString().slice(0, 10);
const localHour = (t) => new Date((t + TZ) * 1000).getUTCHours();
const localDow = (t) => new Date((t + TZ) * 1000).getUTCDay();   // 0 = Sunday
const midnight = (t) => t - ((((t + TZ) % 86400) + 86400) % 86400);
const TEND = lineT(N - 1);

// ---------- sessions and their responses ----------
// A response is [t, output tokens]: it lands at t (Claude Code writes usage once per response).
function stretch(list, from, to, gapMin, gapMax, outMin, outMax) {
  for (let t = from + R(0, gapMax); t < to; t += R(gapMin, gapMax)) {
    list.push([Math.round(t * 10) / 10, Math.round(R(outMin, outMax) * (rnd() < 0.08 ? 3 : 1))]);
  }
  return list;
}
const sess = [
  { sid: uuid(), name: "billing-migration", cwd: "/Volumes/Work/src/billing-migration", pid: 51734, kind: "interactive", hosted: "bg",
    started: T0 - 5412.6, model: "claude-sonnet-5-5", ctx: 187204, cc: "busy", cpu: [0.4, 2.1], rss: 418e6, resp: [] },
  { sid: uuid(), name: "atlas-api", cwd: "/Volumes/Work/src/atlas-api", pid: 48211, kind: "interactive", hosted: "interactive",
    started: T0 - 12061.4, model: "claude-opus-5-5", ctx: 412380, cc: "busy", cpu: [7, 26], rss: 642e6, resp: [] },
  { sid: uuid(), name: "docs-site", cwd: "/Volumes/Work/src/docs-site", pid: 39027, kind: "interactive", hosted: "interactive",
    started: T0 - 26118.9, model: null, ctx: null, cc: "idle", cpu: [0.1, 0.6], rss: 377e6, resp: [] },
];
const [B, A, C] = sess;
const ASK_AT = T0 - 95.4;
stretch(A.resp, T0 - 3600, T0 - 2700, 5, 15, 150, 1300);
stretch(A.resp, T0 - 1500, TEND + 1, 4, 13, 150, 1400);
stretch(B.resp, T0 - 1900, ASK_AT - 8, 6, 18, 120, 900);
B.resp.push([Math.round(ASK_AT * 10) / 10, 412]);
// sessions that ended within the hour still count in the hour's totals
const ended = [
  { sid: uuid(), name: "design-system", resp: stretch([], T0 - 3500, T0 - 2400, 6, 16, 120, 1100) },
  { sid: uuid(), name: "data-pipeline", resp: stretch([], T0 - 4900, T0 - 3300, 6, 16, 120, 1000) },
];
const turnStart = { [A.sid]: T0 - 1496.2, [B.sid]: T0 - 1903.7 };
C.last = T0 - 7822.3;

// subagents: [session, type, desc, start, end|null]
const agentsDef = [
  [A, "general-purpose", "Trace the flaky webhook retry", T0 - 1262.8, null],
  [A, "Explore", "Map the auth middleware", T0 - 410.3, T0 + 30.1],
  [A, "reviewer", "Review the rate-limit patch", T0 - 95.0, null],
  [A, "tester", "Run the integration suite", T0 + 10.2, null],
].map(([s, type, desc, start, end]) => ({ id: agentId(), s, type, desc, start, end }));
for (const a of agentsDef) stretch(A.resp, Math.max(a.start, T0 - 3600), Math.min(a.end ?? TEND + 1, TEND + 1), 7, 20, 80, 600);
for (const s of [...sess, ...ended]) s.resp.sort((x, y) => x[0] - y[0]);
const allResp = [...sess, ...ended].flatMap((s) => s.resp).sort((x, y) => x[0] - y[0]);

const perMin = (resp, t) => {
  const m = Math.floor(t / 60), out = new Array(60).fill(0);
  for (const [rt, n] of resp) { if (rt > t) break; const i = Math.floor(rt / 60) - m + 59; if (i >= 0) out[i] += n; }
  return out;
};
const since15 = (resp, t) => resp.reduce((a, [rt, n]) => (rt > t - 900 && rt <= t ? a + n : a), 0);
const landed = (resp, t, from = -Infinity) => resp.filter(([rt]) => rt > from && rt <= t);

// ---------- sys ----------
const PROCS = [["Xcode", 31, 2.31e9], ["Safari", 12, 1.42e9], ["node", 9, 0.96e9], ["WindowServer", 7, 0.61e9], ["python3", 4, 0.44e9]];
function sysAt(t, i) {
  const q = Math.floor(t * 4);
  const cpu = r1(clamp(13 + 22 * sm(t, 1) + 9 * hn(q, 1), 2, 96));
  const user = r1(cpu * (0.64 + 0.08 * hn(q, 2)));
  const cores = Array.from({ length: 10 }, (_, k) => r1(clamp(cpu * (0.35 + 1.25 * hn(q, 10 + k)) + (k < 4 ? 5 : 0), 0, 100)));
  const gpu = Math.round(3 + 15 * sm(t, 2) * hn(q, 3));
  const app = Math.round(6.08e9 + 0.21e9 * sm(t, 4)), wired = Math.round(2.41e9 + 0.05e9 * hn(q, 5)), compressed = Math.round(2.62e9 + 0.02e9 * sm(t, 6));
  const burst = (k, base, peak) => Math.round(base * (0.5 + hn(q, k)) + (hn(q, k + 1) > 0.82 ? peak * hn(q, k + 2) : 0));
  const p5 = Math.floor(t / 5);   // ps runs every 5 s: the process lists hold between
  const top = PROCS.map(([n, c, m], k) => [n, r1(c * (0.6 + 0.8 * hn(p5, 40 + k))), Math.round(m * (0.97 + 0.06 * hn(p5, 50 + k)))]);
  return {
    cpu, user, sys: r1(cpu - user), cores,
    load: [2.12 + 0.4 * sm(t / 30, 7), 2.34 + 0.1 * sm(t / 60, 8), 2.51].map((v) => Math.round(v * 100) / 100),
    gpu, gpu_detail: { renderer: Math.max(0, gpu - 1), tiler: gpu, vram_used: Math.round(3.8e8 + 2.1e8 * sm(t, 9)), vram_alloc: 4206886912 },
    mem: { total: 17179869184, used: app + wired + compressed, app, wired, active: Math.round(4.61e9 + 0.1e9 * sm(t, 11)),
      compressed, cached: Math.round(3.92e9 - 0.1e9 * sm(t, 4)), free: Math.round(1.8e8 + 0.9e8 * hn(q, 12)), pressure: "normal" },
    swap: 1210056704,
    net: { rx_bps: burst(20, 3200, 1.8e5), tx_bps: burst(23, 1400, 4.2e4) },
    disk: { free: 412331180032 - Math.floor((t - T0 + 200) * 1500), total: 994662584320, read_bps: burst(26, 9000, 2.4e7), write_bps: burst(29, 22000, 6.1e6) },
    batt: { pct: i != null && i >= 150 ? 77 : 78, charging: false, ac: false, mins_left: i != null && i >= 150 ? 309 : 312, state: "discharging" },
    top_cpu: top.map(([n, c]) => [n, c]).sort((a, b) => b[1] - a[1]),
    top_mem: top.map(([n, , m]) => [n, m]).sort((a, b) => b[1] - a[1]),
  };
}

// ---------- hist: 1 s samples, the last 120 ----------
const HIST0 = T0 - 121;
const samples = [];
for (let s = HIST0; s <= TEND; s += 1) {
  const st = Math.round((s + 0.104) * 10) / 10, x = sysAt(st, null);
  samples.push({ t: st, cpu: x.cpu, gpu: x.gpu, mem: x.mem.used, rx: x.net.rx_bps, tx: x.net.tx_bps, rd: x.disk.read_bps, wr: x.disk.write_bps, cores: x.cores, out_15m: since15(allResp, st) });
}
function histAt(t) {
  const sl = samples.filter((p) => p.t <= t).slice(-120);
  const h = { t: [], cpu: [], gpu: [], mem: [], rx: [], tx: [], rd: [], wr: [], cores: [], out_15m: [] };
  for (const p of sl) for (const k of Object.keys(h)) h[k].push(p[k]);
  h.span_s = r1(sl.length ? sl[sl.length - 1].t - sl[0].t : 0);
  return { h, n: sl.length ? sl[sl.length - 1].t : 0 };
}

// ---------- weekly limit ----------
// two days into the week: a pace that runs out well before the reset
const WSTART = T0 - 48 * 3600, RESET = WSTART + 168 * 3600;
const PCT_UP_AT = T0 + 30.0;       // 41% -> 42% partway through the replay
// the week's readings: one per percent, at work hours, ending at 41% just before T0
const weekPts = [[Math.round(WSTART - 2900), 88, "prev"], [Math.round(WSTART + 1200), 0]];
{
  let w = [], acc = 0;
  for (let h = WSTART; h < T0 - 600; h += 600) { const lh = localHour(h); const v = lh >= 9 && lh <= 23 ? 0.6 + hn(Math.floor(h / 600), 70) : 0.03; w.push([h, v]); acc += v; }
  let c = 0, pct = 0;
  for (const [h, v] of w) { c += v; const p = Math.floor((41 * c) / acc); if (p > pct) { pct = p; weekPts.push([Math.round(h + 600 * hn(h, 71)), pct]); } }
}
const weekAt = (t) => { let p = 0; for (const x of weekPts) if (x.length === 2 && x[0] <= t) p = x[1]; return p; };
function limitsAt(tt) {
  // the statusline records whole percents and the feed re-reads them about once a second;
  // the run-out estimate is good to the minute, so the block changes when the reading does
  const t = Math.floor(tt / 60) * 60, pct = tt >= PCT_UP_AT ? 42 : 41;
  const hrs = (t - WSTART) / 3600, frac = hrs / 168, rate = pct / hrs;
  const projected = Math.round(pct / frac);
  const history = [];
  for (let q = Math.floor(tt / 900) * 900 - 95 * 900; q <= tt; q += 900) history.push([q, null, q >= PCT_UP_AT ? 42 : weekAt(q)]);
  return {
    five_hour: { pct: 0, resets_at: null, stale: true, last_reset_at: Math.round(WSTART - 86400 * 9.3), pace: 0, burn_per_h: null, projected: null, runout_at: null },
    seven_day: { pct, resets_at: RESET, stale: false, pace: projected, burn_per_h: 1.1, projected,
      runout_at: projected > 100 ? Math.round((t + ((100 - pct) / rate) * 3600) / 60) * 60 : null },
    read_at: Math.round(tt >= PCT_UP_AT ? PCT_UP_AT : T0 - 3),
    history,
    week_points: tt >= PCT_UP_AT ? [...weekPts, [Math.round(PCT_UP_AT), 42]] : weekPts.slice(),
  };
}

// ---------- tokens today ----------
const TODAY0 = { out: 1618233, cache_read: 168204511, cache_write: 5203377, input: 18140, calls: 1831 };
function tokensAt(t) {
  const L = landed(allResp, t, T0 - 3600);
  const today = { ...TODAY0 };
  for (const [, n] of L) { today.out += n; today.calls += 1; today.cache_read += 61000 + n * 40; today.cache_write += Math.round(n * 1.6); today.input += 3; }
  return { out_per_min: perMin(allResp, t), today, partial: false };
}

// ---------- events: the last 40, newest last ----------
const evPast = [];
const ev = (t, kind, s, detail, extra) => evPast.push({ t: Math.round(t * 10) / 10, kind, sid: s.sid, name: s.name, detail, ...extra });
const others = [...ended, { sid: uuid(), name: "mobile-release" }];
// older turns and agents across the afternoon
{
  const pastTypes = [["Explore", "Find the retry config"], ["Plan", "Plan the schema split"], ["general-purpose", "Summarise the failing tests"],
    ["builder", "Port the CSV exporter"], ["researcher", "Compare cache eviction policies"], ["tester", "Run the web suite"], ["reviewer", "Review the migration order"]];
  let t = T0 - 6 * 3600;
  let k = 0;
  while (t < T0 - 1600) {
    const s = [A, B, ...others][k % 5];
    if (k % 3 === 0) { const [ty, d] = pastTypes[k % pastTypes.length]; const id = agentId(), dur = R(120, 900); ev(t, "agent_start", s, `${ty}: ${d}`, { id }); ev(t + dur, "agent_done", s, `${ty}: ${d}`, { id }); }
    else ev(t, "done", s, "", k % 4 === 1 ? { n: RI(2, 7) } : undefined);
    t += R(380, 900); k++;
  }
}
ev(T0 - 4100, "fail", ended[1], "");
ev(T0 - 2911, "ask", B, "permission Bash"); ev(T0 - 2863, "answered", B, "after 48s");
ev(T0 - 2400, "done", ended[0], "", { n: 4 });
ev(T0 - 1497, "done", A, "", { n: 3 });
for (const a of agentsDef) if (a.start < T0) ev(a.start, "agent_start", a.s, `${a.type}: ${a.desc}`, { id: a.id });
ev(ASK_AT, "ask", B, "question AskUserQuestion");
ev(T0 - 35.2, "remind", B, "reminder 1");
const evLive = [
  ...agentsDef.filter((a) => a.start >= T0).map((a) => ({ t: a.start, kind: "agent_start", sid: a.s.sid, name: a.s.name, detail: `${a.type}: ${a.desc}`, id: a.id })),
  ...agentsDef.filter((a) => a.end != null).map((a) => ({ t: a.end, kind: "agent_done", sid: a.s.sid, name: a.s.name, detail: `${a.type}: ${a.desc}`, id: a.id })),
  { t: T0 + 25.1, kind: "remind", sid: B.sid, name: B.name, detail: "reminder 2" },
];
const eventsAt = (t) => [...evPast, ...evLive.filter((e) => e.t <= t)].filter((e) => e.t <= t).sort((a, b) => a.t - b.t).slice(-40);

// ---------- sessions and agents at t ----------
function sessionsAt(t) {
  return sess.map((s) => {
    const q = Math.floor(t * 4);
    const mine = landed(s.resp, t);
    const last = mine.length ? mine[mine.length - 1][0] : null;
    let state = "idle", since = s === C ? C.last : null, open = false, ask = null;
    if (s === A) { state = "working"; since = turnStart[A.sid]; open = true; }
    if (s === B) {
      state = "waiting"; since = ASK_AT; open = true;
      ask = { kind: "question", tool: "AskUserQuestion", text: "Which migration should run first?", n: 1, since: Math.round(ASK_AT * 10) / 10, agent: null, agent_type: null };
    }
    const ctx = s.ctx == null ? null : s.ctx + Math.round(1.3 * landed(s.resp, t, T0 - 60).reduce((a, [, n]) => a + n, 0));
    const win = s.model && s.model.includes("haiku") ? 200000 : 1000000;
    return {
      sid: s.sid, name: s.name, cwd: s.cwd, pid: s.pid, kind: s.kind, hosted: s.hosted, up_s: Math.floor(t - s.started),
      cpu: r1(s.cpu[0] + (s.cpu[1] - s.cpu[0]) * hn(q, s.pid)), rss: Math.round(s.rss * (0.98 + 0.04 * sm(t, s.pid % 97))),
      state, since: since == null ? null : Math.round(since * 10) / 10,
      agents_running: agentsDef.filter((a) => a.s === s && a.start <= t && (a.end == null || a.end > t)).length,
      model: s.model, ctx_tokens: ctx, ctx_window: ctx == null ? null : win, ctx_pct: ctx == null ? null : r1((100 * ctx) / win),
      out_15m: since15(s.resp, t), out_per_min: perMin(s.resp, t), ask, turn_open: open,
      last_activity: s === C ? Math.round(C.last * 10) / 10 : last == null ? null : last, cc_status: s.cc,
    };
  });
}
const agentsAt = (t) => agentsDef.filter((a) => a.start <= t && (a.end == null || a.end > t)).map((a) => ({
  id: a.id, type: a.type, sid: a.s.sid, session: a.s.name, desc: a.desc, started: Math.round(a.start * 10) / 10,
  age_s: Math.floor(t - a.start), idle_s: Math.floor(((Math.floor(t / 3) * 7 + a.id.charCodeAt(3)) % 19) * hn(Math.floor(t / 3), a.id.charCodeAt(5))),
}));

// ---------- weather (sticky; one reading) ----------
const OBS = Math.floor(T0 / 900) * 900;
const weather = {
  place: "Demo City", lat: 41.02, lon: -77.53, fetched_at: OBS + 61, observed_at: OBS,
  temp_c: 14.2, feels_c: 12.9, code: 2, kind: "partly", text: "partly cloudy", cloud: 46, humidity: 58,
  precip_mm: 0.0, rain_mm: 0.0, snow_cm: 0.0, wind_kmh: 13.7, wind_dir: 251, is_day: true,
  sunrise: midnight(T0) + 6 * 3600 + 47 * 60, sunset: midnight(T0) + 17 * 3600 + 3 * 60,
};

// ---------- github (demo-user) ----------
const REPOS = [["atlas-api", "TypeScript"], ["docs-site", "MDX"], ["billing-migration", "Python"], ["design-system", "TypeScript"], ["data-pipeline", "Python"],
  ["mobile-release", "Swift"], ["edge-cache", "Rust"], ["queue-worker", "Go"], ["status-page", "TypeScript"], ["metrics-exporter", "Go"], ["auth-service", "TypeScript"],
  ["search-index", "Rust"], ["payments-sdk", "Kotlin"], ["chart-kit", "TypeScript"], ["cli-tools", "Rust"], ["infra-terraform", "HCL"], ["ml-notebooks", "Jupyter Notebook"],
  ["benchmarks", "C++"], ["theme-tokens", "CSS"], ["lint-rules", "JavaScript"], ["config-schema", null], ["dotfiles", "Shell"], ["api-gateway", "Go"], ["blog", "Astro"], ["fixtures", null]];
const ghDays = [];
for (let d = 367; d >= 0; d--) {
  const t = T0 - d * 86400, dow = localDow(t), wk = dow === 0 || dow === 6;
  const busy = 0.5 + 0.5 * Math.sin(d / 23 + 1.3);
  let n = rnd() < (wk ? 0.45 : 0.12) ? 0 : Math.round(R(1, wk ? 6 : 14) * (0.4 + busy));
  if (rnd() < 0.015) n += RI(20, 41);
  ghDays.push([localDate(t), n]);
}
ghDays[ghDays.length - 1][1] = 7;
for (let k = 2; k <= 9; k++) if (ghDays[ghDays.length - k][1] === 0) ghDays[ghDays.length - k][1] = RI(2, 9);
// this year's commits per repo: a long tail that adds up to ~90% of commits_year (the rest went
// to repos past the top 25), so "N more repos" always has commits in it
const commitsYear0 = Math.round(ghDays.slice(-365).reduce((a, d) => a + d[1], 0) * 0.81);
const repoW = REPOS.map((_, k) => Math.pow(0.84, k) * R(0.85, 1.15));
const repoWSum = repoW.reduce((a, b) => a + b, 0);
const repoCommits = REPOS.map(([n, lang], k) => [`demo-user/${n}`, Math.max(3, Math.round((0.9 * commitsYear0 * repoW[k]) / repoWSum)), lang]).sort((a, b) => b[1] - a[1]);
const recent0 = [
  { type: "PushEvent", repo: "demo-user/atlas-api", at: T0 - 1712, text: "pushed 3 commits to atlas-api main" },
  { type: "PullRequestEvent", repo: "demo-user/billing-migration", at: T0 - 5150, text: "merged PR #214 in billing-migration" },
  { type: "CreateEvent", repo: "demo-user/atlas-api", at: T0 - 9033, text: "created branch fix/webhook-retry in atlas-api" },
  { type: "IssuesEvent", repo: "demo-user/docs-site", at: T0 - 15822, text: "opened issue #88 in docs-site" },
  { type: "WatchEvent", repo: "acme-labs/chart-kit", at: T0 - 40211, text: "starred acme-labs/chart-kit" },
];
const PUSH_AT = T0 + 20.4, GH_LINE = Math.min(N - 1, Math.ceil((PUSH_AT + 9 - T0) / STEP));
function github(t, pushed) {
  const days = ghDays.map((d) => d.slice());
  const repos = repoCommits.map((r) => r.slice());
  let recent = recent0.map((e) => ({ ...e }));
  if (pushed) {
    days[days.length - 1][1] += 2;
    repos.find((r) => r[0] === "demo-user/atlas-api")[1] += 2;
    recent = [{ type: "PushEvent", repo: "demo-user/atlas-api", at: PUSH_AT, text: "pushed 2 commits to atlas-api main" }, ...recent].slice(0, 5);
  }
  repos.sort((a, b) => b[1] - a[1]);
  let streak = 0; for (let i = days.length - 1; i >= 0 && days[i][1] > 0; i--) streak++;
  const best = days.reduce((m, d) => (d[1] > m[1] ? d : m), days[0]);
  const total = days.slice(-365).reduce((a, d) => a + d[1], 0);
  return {
    login: "demo-user", fetched_at: Math.round(t), total_year: total, days, today: days[days.length - 1][1],
    week: days.slice(-7).reduce((a, d) => a + d[1], 0), streak, best: best.slice(), repos,
    commits_year: Math.round(total * 0.81), prs_year: 143, issues_year: 61, recent, latest: recent[0],
  };
}

// ---------- analytics (14 days, every 10 s) ----------
const DAYS = [];
for (let d = 13; d >= 0; d--) {
  const t = T0 - d * 86400, dow = localDow(t), wk = dow === 0 || dow === 6;
  const f = (wk ? 0.35 : 1) * R(0.6, 1.35);
  DAYS.push({ t, date: localDate(t), f, wk });
}
const MODELS = [["claude-opus-5-5", 0.56], ["claude-sonnet-5-5", 0.24], ["claude-fable-5-1", 0.12], ["claude-haiku-5-5", 0.08]];
const hourShape = (d, upto) => { const h = Array.from({ length: 24 }, (_, k) => (k >= 9 && k <= 23 && k <= upto ? (0.4 + hn(d, 300 + k)) * (k >= 13 && k <= 17 ? 1.5 : 1) : k < upto && k < 2 ? 0.15 * hn(d, 330 + k) : 0)); const s = h.reduce((a, b) => a + b, 0) || 1; return h.map((v) => v / s); };
const TYPES = ["Explore", "general-purpose", "builder", "reviewer", "tester", "Plan", "researcher", "designer"];
const DAY_DRAWS = [];
function analyticsAt(t) {
  const today = tokensAt(t).today;
  const days = DAYS.map((D, k) => {
    const last = k === DAYS.length - 1;
    const out = last ? today.out : Math.round(1.9e6 * D.f);
    const calls = last ? today.calls : Math.round(out / 880);
    const cache_read = last ? today.cache_read : Math.round(out * R(88, 104));
    const shape = hourShape(k, last ? localHour(t) : 23);
    const by_model = {}; let rest = out;
    MODELS.forEach(([m, sh], j) => { const v = j === MODELS.length - 1 ? rest : Math.round(out * sh * (0.8 + 0.4 * hn(k, 90 + j))); if (v > 0 && !(D.wk && m === "claude-fable-5-1")) by_model[m] = v; rest -= v; });
    if (rest > 0) by_model["claude-opus-5-5"] += rest;
    const spawns = Math.round(R(6, 38) * D.f);
    const day = {
      date: D.date, out, cache_read, cache_write: last ? today.cache_write : Math.round(out * R(2.6, 3.4)),
      input: last ? today.input : calls * 10, calls, by_model, prompts: Math.round(R(18, 64) * D.f) + 1, spawns,
      general_purpose: Math.round(spawns * R(0.08, 0.22)), fails: last ? 1 : hn(k, 99) > 0.86 ? 1 : 0,   // today's one is data-pipeline's fail event ask_waits: RI(0, 5),
      out_main: Math.round(out * 0.54), cache_read_main: Math.round(cache_read * 0.47), hours: shape.map((v) => Math.round(v * out)),
    };
    // The draws above run on every rebuild (keeping the random stream, and so every other block, as it
    // was), but a day's drawn figures are the first build's: a rebuild every 10 s must not rewrite history.
    const first = (DAY_DRAWS[k] ||= { cache_read: day.cache_read, cache_write: day.cache_write, prompts: day.prompts, spawns: day.spawns, general_purpose: day.general_purpose });
    for (const key of last ? ["prompts", "spawns", "general_purpose"] : Object.keys(first)) day[key] = first[key];
    day.cache_read_main = Math.round(day.cache_read * 0.47);
    return day;
  });
  const rows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hm = rows.map(() => new Array(24).fill(0));
  DAYS.forEach((D, k) => { const r = (localDow(D.t) + 6) % 7; days[k].hours.forEach((v, h) => (hm[r][h] += v)); });
  const sum = (key) => days.reduce((a, d) => a + d[key], 0);
  const spawnsD14 = Object.fromEntries(TYPES.map((ty, j) => [ty, Math.max(1, Math.round((sum("spawns") * [0.27, 0.18, 0.15, 0.13, 0.11, 0.07, 0.06, 0.03][j])))]));
  const spawnsToday = Object.fromEntries(TYPES.slice(0, 6).map((ty, j) => [ty, Math.max(1, Math.round(days[13].spawns * [0.3, 0.2, 0.16, 0.14, 0.12, 0.08][j]))]));
  const tokOf = (n, scale) => ({ out: Math.round(n * 5200 * scale), cache_read: Math.round(n * 410000 * scale), calls: Math.round(n * 31 * scale) });
  const byCR = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1].cache_read - a[1].cache_read));
  const agent_tokens = {
    d14: byCR({ main: { out: Math.round(sum("out_main")), cache_read: Math.round(sum("cache_read_main")), calls: Math.round(sum("calls") * 0.5) }, ...Object.fromEntries(Object.entries(spawnsD14).map(([k, n]) => [k, tokOf(n, 1)])) }),
    today: byCR({ main: { out: days[13].out_main, cache_read: days[13].cache_read_main, calls: Math.round(days[13].calls * 0.5) }, ...Object.fromEntries(Object.entries(spawnsToday).map(([k, n]) => [k, tokOf(n, 1)])) }),
  };
  const gp14 = sum("general_purpose"), gpT = days[13].general_purpose;
  return {
    built_at: Math.round((T0 - 3.2) * 1000) / 1000, derived_at: Math.round(t * 10) / 10, window_days: 14, ready: true, first_build_s: 6.8,
    days, hour_matrix: { rows, out: hm },
    spawns: { d14: spawnsD14, today: spawnsToday },
    general_purpose: { d14: gp14, today: gpT, share_d14: r1((100 * gp14) / Math.max(1, sum("spawns"))),
      by_session_d14: [["atlas-api", Math.ceil(gp14 * 0.42)], ["data-pipeline", Math.ceil(gp14 * 0.27)], ["billing-migration", Math.ceil(gp14 * 0.18)], ["design-system", Math.max(1, Math.floor(gp14 * 0.13))]],
      by_session_today: gpT ? [["atlas-api", gpT]] : [] },
    agent_tokens,
    tools: {
      main: [["Bash", 1842], ["Read", 1327], ["Edit", 904], ["Grep", 611], ["Agent", 236], ["Write", 198], ["TodoWrite", 152], ["WebFetch", 64], ["Glob", 51], ["AskUserQuestion", 31]],
      sub: [["Read", 9214], ["Bash", 7302], ["Grep", 4410], ["Glob", 1904], ["Edit", 1288], ["WebSearch", 640], ["WebFetch", 512], ["Write", 433], ["mcp__docs__search_documentation", 201], ["TodoWrite", 188]],
    },
    cache_hit_pct: { d14: 96.1, today: 96.6 },
    prompts: { d14: sum("prompts"), today: days[13].prompts },
    concurrency: { max: 4, median: 2.0, buckets: 412, bucket_s: 600 },
    ask_wait: { count: 37, median_s: 128.4, p90_s: 1840.2, max_s: 6120.7 },
    fails: { d14: sum("fails"), today: days[13].fails },
  };
}

// ---------- the lines ----------
const lines = [];
const sent = {};
let lastHist = -1;
for (let i = 0; i < N; i++) {
  const t = lineT(i), x = sysAt(t, i);
  const L = {
    v: 1, t,
    feed: { pid: 73412, cpu_s: Math.round((0.151 + 0.0083 * i) * 1000) / 1000, child_cpu_s: Math.round((0.041 + 0.0037 * i) * 1000) / 1000,
      rss: 22888448 + 4096 * 233 * Math.floor(i / 20), up_s: r1(0.4 + i * STEP), tick_ms: Math.round((i % 20 === 0 ? 38 + 30 * hn(i, 5) : 1.1 + 7 * hn(i, 6)) * 100) / 100, period_ms: 250 },
    sys: x,
  };
  const claude = {};
  const sticky = (key, val, into) => { const enc = JSON.stringify(val); if (sent[key] !== enc) { sent[key] = enc; into[key.split(".").pop()] = val; } };
  sticky("weather", weather, L);
  if (i === 0 || i === GH_LINE) L.github = github(t, i >= GH_LINE);
  sticky("claude.limits", limitsAt(t), claude);
  claude.sessions = sessionsAt(t);
  claude.sessions_other = 0;
  claude.agents_running = agentsAt(t);
  sticky("claude.tokens", tokensAt(t), claude);
  sticky("claude.events", eventsAt(t), claude);
  // keep the feed's key order: limits, sessions, sessions_other, agents_running, tokens, events
  L.claude = Object.fromEntries(["limits", "sessions", "sessions_other", "agents_running", "tokens", "events"].filter((k) => k in claude).map((k) => [k, claude[k]]));
  if (i % 40 === 0) L.analytics = analyticsAt(t);
  const { h, n } = histAt(t);
  if (n > lastHist) { lastHist = n; L.hist = h; }
  lines.push(Object.fromEntries(["v", "t", "feed", "sys", "weather", "github", "claude", "analytics", "hist"].filter((k) => k in L).map((k) => [k, L[k]])));
}

const header = `// SYNTHETIC demo feed: ${N} lines at 250 ms, every value invented by demo/make-fixture.mjs (seed ${SEED}).\n` +
  `// No machine, account or session was captured. Regenerate: npm run fixture (node demo/make-fixture.mjs).\n`;
const text = header + "window.KILN_FIXTURE = " + JSON.stringify({ lines }) + ";\n";
writeFileSync(OUT, text);
console.log(`wrote ${OUT}: ${lines.length} lines, ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`);
