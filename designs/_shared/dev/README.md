# Design verification tools

Every design change passes these before it ships. They run headless through
`../chrome-bg.sh` (chrome-headless-shell; never the Chrome app, never Playwright WebKit).
playwright-core comes from the repo's devDependency (`npm install` at the repo root), or from
`$PLAYWRIGHT_CORE`, a path to its `index.mjs`.

- `geomcheck.mjs <design dir> [feed] [--verbose]` — **tiles never move or resize.**
  Replays a feed, then 90 synthetic transitions (1–6 sessions, 0–11 agents, quiet hour,
  waiting, failed, null context, long names). After every update it records each tile and each
  chart frame. Any move, resize, appearance or disappearance fails.
- `errcount.mjs <design dir> [feed] [query]` — 0 page or console errors over the replay.
  `query` is appended to `index.html`, e.g. `"?appearance=light"` for a design's light look.
- `batch.sh <spec>` / `m.sh` — KilnWall `--measure` under `measure.lock`, with footprints.
  Spec lines: `tag dir design period`. Measure against glass in the same batch. Logs and the lock
  go to `~/.cache/kiln-wall/` (override with `KILN_RUNS`); the app is `$KILNWALL_APP`, default
  `~/Applications/KilnWall.app`. Never write scratch output anywhere under the live designs
  folder: KilnWall reloads the wallpaper on every file change there.

`feed` is either a `.jsonl` recording (one `kiln-feed.py --stream` line per line) or a
`fixture.js`; it defaults to `../fixture.js`, the synthetic demo feed made by
`demo/make-fixture.mjs`. A recording of your own live feed holds your session names and paths:
keep it out of the repository. A feed that never varies cannot test layout; that is why
geomcheck adds its own transitions.
