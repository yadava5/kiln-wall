#!/usr/bin/env node
// errcount-all.mjs: designs/_shared/dev/errcount.mjs over every look, one render at a time.
//   node demo/errcount-all.mjs [feed]      (default: the synthetic designs/_shared/fixture.js)
//   npm run errcount
// Exits 1 if any look logged a page or console error.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOKS } from "./looks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const feed = resolve(process.argv[2] || join(ROOT, "designs/_shared/fixture.js"));
let bad = 0;
for (const look of LOOKS) {
  const r = spawnSync(process.execPath, [join(ROOT, "designs/_shared/dev/errcount.mjs"), join(ROOT, "designs", look.design), feed, look.query ? "?" + look.query : ""], { encoding: "utf8" });
  const line = (r.stdout || "").split("\n")[0] || (r.stderr || "").trim().split("\n").pop();
  console.log(`${look.id.padEnd(13)} ${line}`);
  if (r.status !== 0) bad++;
}
process.exitCode = bad ? 1 : 0;
