#!/usr/bin/env node
// stills.mjs: one 1512x982 @2x still per look from the synthetic fixture, plus the page errors seen.
//
//   node demo/stills.mjs [out dir] [--still 130] [--only glass-dark,horizon]
//   npm run stills
//
// Each look loads designs/<design>/index.html?fixture&still=<n>[&appearance=...], which replays n
// fixture lines at 250 ms in real time and then holds still; the shot is taken after that.
// Renders run one at a time through designs/_shared/chrome-bg.sh (chrome-headless-shell at
// background QoS); playwright-core is $PLAYWRIGHT_CORE (a path to its index.mjs) or the repo's
// devDependency. Exits 1 if any look logged a page or console error.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOKS } from "./looks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || "playwright-core");
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const flagVals = new Set(["--still", "--only"].map((n) => args[args.indexOf(n) + 1]).filter(Boolean));
const outArg = args.find((a) => !a.startsWith("--") && !flagVals.has(a));
const OUT = resolve(outArg || join(ROOT, ".release-notes/stills"));
const STILL = +opt("--still", 130);
const only = opt("--only", "");
const looks = only ? LOOKS.filter((l) => only.split(",").includes(l.id)) : LOOKS;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: join(ROOT, "designs/_shared/chrome-bg.sh"), args: ["--allow-file-access-from-files"] });
let bad = 0;
try {
  for (const look of looks) {
    const ctx = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
    const q = ["fixture", `still=${STILL}`, look.query].filter(Boolean).join("&");
    await page.goto(`file://${join(ROOT, "designs", look.design, "index.html")}?${q}`);
    await page.waitForFunction(() => window.Kiln && window.Kiln.stats && window.Kiln.stats.updates > 0, null, { timeout: 20000 });
    // the replay stops after STILL lines; give it that long, then a second for the last tweens
    await page.waitForFunction((n) => window.Kiln.stats.updates >= n, STILL, { timeout: STILL * 250 + 30000, polling: 1000 });
    await page.waitForTimeout(1500);
    const file = join(OUT, `${look.id}.png`);
    await page.screenshot({ path: file });
    console.log(`${look.id.padEnd(13)} errors ${errs.length}${errs[0] ? "  " + errs[0] : ""}  -> ${file}`);
    bad += errs.length ? 1 : 0;
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exitCode = bad ? 1 : 0;
