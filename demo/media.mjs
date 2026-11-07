#!/usr/bin/env node
// media.mjs: deterministic frame capture of each KilnWall look, then mp4 + animated webp loop.
//   node demo/media.mjs <look,look,...|all> [--frames N] [--no-encode]
// Writes docs/media/<look>-loop.webp and .release-notes/video/<look>.mp4 (release assets, not
// committed). Needs ffmpeg, ImageMagick (magick) and libwebp's img2webp on PATH.
// Time is Playwright's fake clock (page.clock): Date, timers, rAF and performance.now are all fake,
// so the runtime's replay (setTimeout per 250 ms line) and tweens (performance.now) step exactly.
// CSS animations/transitions run on the compositor's real clock, so each step they are paused and
// seeked to the fake time (document.getAnimations()).
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || "playwright-core");
const { LOOKS } = await import("./looks.mjs");
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const which = args[0] || "all";
const looks = which === "all" ? LOOKS : LOOKS.filter((l) => which.split(",").includes(l.id));
const FPS = 30;
const START_LINE = 96;                       // video starts at fixture line 96 (24 s in)
const VFRAMES = +opt("--frames", 330);       // 11 s at 30 fps -> lines 96..140
const LOOP_FROM = 60, LOOP_STEP = 3;         // loop: from 2 s into the video (line 104), 10 fps
const LOOP_N = 70, XF = 4;                   // 7 s loop + 0.4 s crossfade into the start
const FR = join(ROOT, ".release-notes/frames");
const VD = join(FR, "v"), LD = join(FR, "l");
const MEDIA = join(ROOT, "docs/media"), VIDEO = join(ROOT, ".release-notes/video");
for (const d of [VD, LD, MEDIA, VIDEO]) mkdirSync(d, { recursive: true });
const pad = (n) => String(n).padStart(4, "0");
const run = (cmd, a) => {
  const r = spawnSync(cmd, a, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || "").slice(-800)}`);
  return r;
};

const browser = await chromium.launch({ executablePath: join(ROOT, "designs/_shared/chrome-bg.sh"), args: ["--allow-file-access-from-files"] });
try {
  for (const look of looks) {
    const t0 = Date.now();
    if (!args.includes("--encode-only")) {
    const ctx = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
    // install() leaves time flowing with the wall clock; pause it before load so nothing runs on its own
    await page.clock.install({ time: 1793822999 * 1000 });
    await page.clock.pauseAt(1793823000 * 1000);
    const q = ["fixture", look.query].filter(Boolean).join("&");
    await page.goto(`file://${join(ROOT, "designs", look.design, "index.html")}?${q}`);
    await page.waitForFunction(() => window.Kiln && window.Kiln.stats && window.Kiln.stats.updates > 0, null, { timeout: 30000, polling: 200 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      window.__drive = () => {
        const now = performance.now();
        for (const a of document.getAnimations()) {
          if (a.__t0 === undefined) { a.__t0 = now; a.pause(); }
          const t = now - a.__t0;
          const end = a.effect && a.effect.getComputedTiming().endTime;
          if (Number.isFinite(end) && t >= end) a.finish(); else a.currentTime = t;
        }
      };
    });
    // fast-forward to just before the start line, in 250 ms steps so tweens and animations settle
    for (let i = 1; i < START_LINE; i++) { await page.clock.runFor(250); await page.evaluate(() => window.__drive()); }
    await page.clock.runFor(200);
    const fonts = await page.evaluate(() => [...document.fonts].map((f) => `${f.family}:${f.status}`).join(" "));
    const upd0 = await page.evaluate(() => window.Kiln.stats.updates);
    let prev = 0;
    for (let k = 0; k < VFRAMES; k++) {
      const target = Math.round((k * 1000) / FPS);
      if (target > prev) await page.clock.runFor(target - prev);
      prev = target;
      await page.evaluate(() => window.__drive());
      await page.screenshot({ path: join(VD, `f${pad(k)}.png`) });
    }
    const upd1 = await page.evaluate(() => window.Kiln.stats.updates);
    await ctx.close();
    console.log(`${look.id.padEnd(13)} captured ${VFRAMES} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s, updates ${upd0}->${upd1}, errors ${errs.length}${errs[0] ? " " + errs[0] : ""}`);
    console.log(`  fonts: ${fonts}`);
    }
    if (args.includes("--no-encode")) continue;

    // mp4: 1512x982, 30 fps, H.264 yuv420p, CRF 23, faststart, BT.709-tagged
    const mp4 = join(VIDEO, `${look.id}.mp4`);
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(VD, "f%04d.png"),
      "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "23",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", mp4]);

    // loop frames: 10 fps, 1000 px wide, the first XF crossfaded from the frames after the loop's end
    const src = (j) => join(VD, `f${pad(LOOP_FROM + LOOP_STEP * j)}.png`);
    const list = [];
    for (let k = 0; k < LOOP_N; k++) {
      const out = join(LD, `l${pad(k)}.png`);
      if (k < XF) {
        const a = Math.round(((k + 1) / (XF + 1)) * 100);   // weight of the loop's own start frame
        // magick DEST SRC -compose blend args=X: X% of SRC over (100-X)% of DEST
        run("magick", [src(LOOP_N + k), src(k), "-compose", "blend", "-define", `compose:args=${a}`, "-composite",
          "-filter", "Lanczos", "-resize", "1000x649!", out]);
      } else {
        run("magick", [src(k), "-filter", "Lanczos", "-resize", "1000x649!", out]);
      }
      list.push(out);
    }
    const q2 = opt("--q", "80");
    const webp = join(MEDIA, `${look.id}-loop.webp`);
    const argfile = join(FR, "img2webp.args");
    writeFileSync(argfile, ["-loop 0 -min_size", `-lossy -q ${q2} -m 6 -d 100`, ...list].join("\n") + `\n-o ${webp}\n`);
    run("img2webp", [argfile]);
    console.log(`  mp4 ${(statSync(mp4).size / 1e6).toFixed(2)} MB, loop ${(statSync(webp).size / 1e6).toFixed(2)} MB (q ${q2})`);
  }
} finally {
  await browser.close();
}
