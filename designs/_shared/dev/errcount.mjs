// errcount.mjs <design dir> [feed] [query]: replay every line of a feed, count page errors.
//   feed   a .jsonl recording (one feed line per line) or a fixture.js
//          (window.KILN_FIXTURE = {lines: [...]}); default ../fixture.js, the synthetic demo feed.
//   query  appended to index.html, e.g. "?appearance=light" to check a design's light look.
// playwright-core: $PLAYWRIGHT_CORE (a path to its index.mjs) if set, else the repo's devDependency.
// Chromium: chrome-bg.sh beside this folder (chrome-headless-shell, background QoS, two at once).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || "playwright-core");
const SHELL = new URL("../chrome-bg.sh", import.meta.url).pathname;
const [dirArg, feedArg, query = ""] = process.argv.slice(2);
if (!dirArg) { console.error("usage: errcount.mjs <design dir> [feed.jsonl|fixture.js] [query]"); process.exit(2); }
const dir = resolve(dirArg);
const feed = feedArg ? resolve(feedArg) : new URL("../fixture.js", import.meta.url).pathname;
const text = readFileSync(feed, "utf8");
const lines = /\.js$/.test(feed)
  ? JSON.parse(text.slice(text.indexOf("{", text.indexOf("KILN_FIXTURE")), text.lastIndexOf("}") + 1)).lines.map((l) => JSON.stringify(l))
  : text.split("\n").filter(Boolean);
const nullCtx = lines.filter((s) => (JSON.parse(s).claude?.sessions || []).some((x) => x.ctx_pct == null)).length;
const b = await chromium.launch({ executablePath: SHELL, args: ["--allow-file-access-from-files"] });
try {
  const p = await (await b.newContext({ viewport: { width: 1512, height: 982 } })).newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  p.on("console", (m) => { if (m.type() === "error" || /error|TypeError/i.test(m.text())) errs.push(m.text().slice(0, 160)); });
  await p.goto("file://" + dir + "/index.html" + query);
  await p.waitForFunction(() => window.kiln && window.kiln.update, null, { timeout: 15000 });
  for (const s of lines) await p.evaluate((x) => window.kiln.update(x), s);
  await p.waitForTimeout(500);
  const cx = await p.evaluate(() => [...document.querySelectorAll("[id^=cx]")].map((e) => e.textContent).slice(0, 3));
  console.log(`lines ${lines.length}, with a null-context session ${nullCtx}, page errors ${errs.length}`, errs[0] || "", "\ncontext cells:", JSON.stringify(cx));
  process.exitCode = errs.length ? 1 : 0;
} finally {
  await b.close();
}
