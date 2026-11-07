# Writing a KilnWall design

KilnWall shows one design folder as the desktop wallpaper. It runs the data feed
(`feed/kiln-feed.py --stream`) as a child process and hands the page one JSON line every
period. The user picks the period from **100 to 1000 ms in 100 ms steps** (global hotkeys
⌃⌥= and ⌃⌥-, or the menu-bar item's Refresh menu). The period changes live: no reload, no
restart.

This guide is the contract a design has to meet: the folder layout, the `Kiln` runtime API,
the feed schema, the performance budget and the dev tools.

## The folder contract

```
~/.config/kiln-wall/
  settings.json          {"design": "glass", "period_ms": 300, ...}  (the app writes it)
  designs/
    _shared/             kiln-runtime.js (REQUIRED), homescreen.js, dock/, fixture.js (dev only),
                         chrome-bg.sh, dev-shot.sh, dev-dom.sh, dev-audit.mjs, dev/
    bento/  flightdeck/  glass/  horizon/  ledger/  missionmap/  patchbay/
```

- Folders whose names start with `_` are not designs.
- A design folder holds `index.html` and its own assets, plus `design.json`:
  `{"name": "Glass Control Room", "order": 1}`.
- `index.html` loads `../_shared/kiln-runtime.js` before its own scripts.
- Presets live in a `config.js` at the top of the folder. Editing any file in the designs
  folder live-reloads the wallpaper, so never write scratch output there.
- The `designs/` folder in this repository is a copy of that tree; install it with
  `cp -R designs/ ~/.config/kiln-wall/designs/`.

## The rules that keep it live

1. **Every figure on screen comes from `Kiln.state` at runtime.** No baked data files. If
   the feed does not carry a figure, do not show it, and do not fake it.
2. **"Now" is `state.t`** (epoch seconds of the line), never `Date.now()`. Countdowns,
   ages ("43 m"), clocks and "x min ago" all derive from it, so they tick at the period.
3. **Values move, they don't jump.** Use `Kiln.num()` for figures and `Kiln.tween*` for bars,
   needles, arcs and chart heads.
4. **Charts scroll.** Rolling series (CPU, network, tokens per minute) append the new point
   each update. Use `Kiln.track()` for client-side history; it is seeded from the feed's
   `hist` block, so a reload is never empty.
5. **Structure follows data.** Sessions, agents and events appear and disappear as they
   start and finish. Animate entry and exit briefly (≤ 400 ms) with no layout jump. Key
   lists by `sid` or agent id.
6. **Show the period** somewhere quiet but legible: "300 ms" next to a live dot. When the
   user changes it, highlight it for 1.5 s.
   - The dot beats on `Kiln.onBeat`, never on `Kiln.on`: at most about once a second at any
     period. Pulsing on every line strobes at 100 ms.
   - The beat is opacity only, a soft rise and fall of about 0.5 → 1 → 0.5 over ~600 ms.
   - Dim the dot under `html.kiln-stale`, which the runtime sets when lines stop.
7. **Nothing moves sideways when a number changes.**
   - Every changing figure uses tabular figures (`font-variant-numeric: tabular-nums`, or
     a face whose tnum feature is on), SVG `<text>` included.
   - A changing figure sits in a box whose width does not depend on its text: size it for
     the widest value it can show, right-aligned for numbers, or anchor the figure at the
     edge its neighbours hang from.
   - No flex or inline flow where a figure's width pushes a sibling, and no centred text
     whose length changes beside something fixed.
   - `_shared/dev-audit.mjs` must report **MOVED (0)** and no RESIZED box caused by text.
     List reorders (sessions re-sorting) are the one allowed exception, and must animate.
8. **Weather is real.** Implement every `weather.kind`: clear, partly, cloudy, fog,
   drizzle, rain, snow, storm. Use `is_day`, `sunrise`, `sunset`, `wind_kmh`, `rain_mm` and
   `snow_cm`. Add a dev override `?weather=snow` to check each one. The weather block is
   null when the feed has no location configured; a design must look finished without it.
9. **Pause:** the runtime stops loops when the wallpaper is covered. Do not start your own
   timers or `requestAnimationFrame` loops.
10. **The home screen.** The Dock can sit on any side, auto-hide, and change length as apps
    open and quit. Never hard-code it: read `Kiln.dock` / `Kiln.onDock`. No text may sit
    inside its span. Strips beside it size themselves from `Kiln.dock`, dropping whole
    low-priority items when it grows and restoring them when it shrinks, and re-lay out
    only in `onDock`. Check with `?home`.
11. **Type:** self-hosted fonts in the design folder, each with its licence file (e.g.
    `fonts/OFL.txt`). Monospace is for machine strings only, never the default face. Use
    tabular figures.

## Appearance, units and the sky

- **Not every design has a light and a dark look.** Glass, Bento and Ledger have two; the
  menu offers Auto / Light / Dark. "auto" keeps the design's own rule (the sun, or its
  preset); "light"/"dark" force its day or night look, both equally finished. Switching is
  live (`Kiln.onPrefs`): repaint canvases and cached art, leave nothing stale. Precedence:
  dev `?theme=` > forced appearance > preset theme > the sun.
- One-look designs (Flight Deck, Horizon, Mission Map, Patchbay, and any new design unless
  it is planned with two) ignore `Kiln.appearance`. Don't invent a light variant, and don't
  add cards to a design that never had them just to make a second look legible.
- **Temperature.** The feed is Celsius. Print every temperature through `Kiln.fmt.temp` /
  `tempValue`, never your own conversion; the unit is the user's menu choice. Slots must
  fit both units without moving.
- **Wind follows the temperature unit.** Print `wind_kmh` only through `Kiln.fmt.wind`:
  mph under °F, km/h under °C.
- Dev: `?appearance=light|dark|auto&unit=C|F`. Prefs code runs at mount and in `onPrefs`
  only, never per line.
- **Weather and sky are never fabricated.** Appearance changes the interface (panels, ink,
  chart colours). It never changes what a sky, weather window or landscape depicts: that
  always shows the real time of day (the sun from `weather.sunrise`/`sunset` and `state.t`,
  or `is_day`) and the real `weather.kind`. Text over a sky picks its ink from the sky
  actually drawn, so a light theme over a night sky stays legible. `?weather=` and `?day=`
  are dev overrides only.
- **No veils on the sky.** Never darken, tint, vignette or scrim the sky to help text.
  Legibility comes from ink picked from the sky, a tight glyph halo (≤ 3 px), or a real,
  crisp-edged card in a design whose language already has cards.

## The `Kiln` API

`designs/_shared/kiln-runtime.js` is the one runtime every design loads; its header
documents each call in detail.

```
Kiln.on((state, prev) => {...})   after every line
Kiln.state / Kiln.period / Kiln.onPeriod(ms => {...})
Kiln.onBeat(state => {...})       the live dot's pulse, at most ~1/s
Kiln.stale                        true (and html.kiln-stale) once lines stop
Kiln.num(el, {fmt}).set(v)        live tweened number; writes text only when it changes
Kiln.tween(a, b, v => ..., ms?) / Kiln.tweenKey(key, a, b, fn, ms?)
Kiln.glide / Kiln.tweenMs         whether text may glide at this period; the tween length
Kiln.loop((t, dt) => ..., {fps: 30})   continuous effects, auto-paused
Kiln.track(key, state => value, seconds); Kiln.series(key) -> [{t, v}]
Kiln.fmt.tokens/int/bytes/rate/pct/clock/span/until/ago/date
Kiln.fmt.temp(c, {unit, digits}) / Kiln.fmt.tempValue(c)   Celsius in, the user's unit out
Kiln.fmt.wind(kmh, {unit, digits})  "10 mph" under F, "16 km/h" under C; unit:false -> "10",
                                  unit:"only" -> "mph"
Kiln.appearance ("auto"|"light"|"dark") / Kiln.tempUnit ("F"|"C") / Kiln.onPrefs(p => {...})
Kiln.dock -> {side: "left"|"bottom"|"right", y0, y1, x0, x1, thickness, autohide, exact} | null
Kiln.onDock(dock => {...})        once at once, then on every change
Kiln.reduced                      prefers-reduced-motion: tweens snap, loops do not run
Kiln.stats                        {frames, updates, t0}, for self-checks
```

The host drives the page through `window.kiln`: `update(line)`, `config({design, period_ms,
appearance, temp_unit, dock})`, `pause()` and `resume()`.

### The Dock

- Page points, top-left origin. `x0..x1 × y0..y1` is the area the Dock covers when shown,
  also while it auto-hides. A left Dock has `x0 = 0`, `x1 = thickness` and `y0..y1` its
  tile span, centred below the menu bar; each running app that is not pinned adds about
  40 pt, 20 at each end.
- `exact: true` means the app read it from the Dock through Accessibility; `false` means
  it was estimated from the Dock's preferences and the running apps. `null` means no Dock
  on this display, or no value yet: keep a sensible default layout for it.
- The app re-reads it on app launch and quit, screen changes and every 5 s, and sends it
  only when it changed. Re-lay out in `onDock` only, never per line; animate any move with
  `transform`.
- Dev: `?dock=y0,y1[,thickness]` sets a left Dock with that span; with `?home` the overlay's
  Dock follows `Kiln.dock` and the area it covers is outlined.

## The feed line (what `state` holds)

All times are epoch seconds, sizes are bytes, percentages are 0–100, and `null` means "not
measured / not knowable", never zero. `feed/kiln-feed.py`'s docstring is the full reference.

**Sticky blocks.** `analytics`, `github`, `hist`, `weather`, `claude.events`,
`claude.limits` and `claude.tokens` are sent only on lines where they changed (and on the
first line). The runtime keeps the last of each, so `Kiln.state` is always complete, and an
unchanged block keeps its object identity between lines: `if (s.github === prev?.github)`
is a free skip.

- `t`, `v`
- `feed{pid, period_ms, tick_ms, cpu_s, child_cpu_s, rss, up_s}`: the feed's own cost.
- `sys{cpu, user, sys, cores[10], load[3], gpu, gpu_detail{renderer, tiler, vram_used,
  vram_alloc}, mem{total, used, app, wired, active, compressed, cached, free, pressure:
  normal|warn|critical}, swap, net{rx_bps, tx_bps}, disk{free, total, read_bps, write_bps},
  batt{pct, charging, ac, mins_left, state}, top_cpu[[name, %]×5], top_mem[[name, bytes]×5]}`
  - `mem.used` is Activity Monitor's "Memory Used": `app` + wired + compressed.
  - `batt` is null on a Mac with no battery.
- `weather{place, lat, lon, fetched_at, observed_at, temp_c, feels_c, code, kind, text,
  cloud, humidity, precip_mm, rain_mm, snow_cm, wind_kmh, wind_dir, is_day, sunrise,
  sunset}`: Open-Meteo's 15-minute reading. **Null** unless the feed has `KILN_LAT` and
  `KILN_LON`, and null when offline for 2 h.
- `github{login, fetched_at, total_year, days[[date, count]×~368], today, week, streak,
  best[date, n], recent[{type, repo, at, text}], latest, repos[[name, commits, lang]×≤25],
  commits_year, prs_year, issues_year}`: the token owner's contribution calendar (every
  5 min) and events (every 60 s). Null without a GitHub token.
- `claude.limits{five_hour, seven_day, read_at, history, week_points}`
  - each window: `{pct, resets_at, stale, burn_per_h, pace, projected, runout_at}`
    (`last_reset_at` when stale).
  - `pace`/`projected` are null until 12 h after the weekly reset. Say so; never draw a
    pace line before then.
  - Show a five-hour figure only when `five_hour.pct` is non-null and `five_hour.stale` is
    false. Otherwise show nothing at all: no footnote, no 0%.
  - `history[[t, five, seven]]`: the last 24 h at 15 min. `five` is null unless a
    five-hour window was live at that time.
  - `week_points[[t, pct]]`: every weekly reading of the current week, in order. A first
    `[t, pct, "prev"]` entry is the previous week's last reading. The series never dips
    within a week.
- `claude.sessions[{sid, name, cwd, pid, kind, hosted, state, since, model, ctx_tokens,
  ctx_window, ctx_pct, out_15m, out_per_min[60], agents_running, ask, turn_open,
  last_activity, cc_status, up_s, cpu, rss}]`, newest first.
  - `kind` is "interactive" (open in a terminal) or "bg" (hosted by Claude Code's daemon
    with no window). A daemon-hosted session with a terminal attached counts as
    interactive; `hosted` keeps Claude Code's own value.
  - Headline counts are interactive sessions ("2 open"); count background ones apart
    ("+2 in the background").
  - `state` is working | waiting | failed | background | idle. "Running" or "working" only
    means working, waiting or background; an idle session is "open" or "idle".
  - `model`, `ctx_tokens`, `ctx_pct` are null until the session's transcript has been read.
  - `out_15m`: output tokens with a timestamp in exactly the last 900 s.
  - `ask` is null unless `state` is waiting: `{kind: "question"|"permission", tool, text,
    n?, since, agent, agent_type}`. `text` is `""` when the tool call could not be found, so
    print it only when non-empty. `since` is when the dialog opened. `agent`/`agent_type`
    name the subagent that asked, or null for the main thread.
- `claude.sessions_other`: live sessions of any other kind (a count).
- `claude.agents_running[{id, sid, session, type, desc, started, age_s, idle_s}]`
- `claude.tokens{out_per_min[60] (the last minute is in progress), today{out, cache_read,
  cache_write, input, calls}, partial}`
- `claude.events[{t, kind, sid, name, detail, n?, id?}]`: newest last, the last 40.
  - kinds: done, fail, ask, remind, answered, agent_start, agent_done.
  - A session's turn ends within 10 min coalesce into one `done` at the newest time, with
    `n` = how many ("6 turns").
- `analytics{ready, built_at, derived_at, window_days, days[14], hour_matrix{rows, out[7][24]},
  spawns{d14, today}, agent_tokens{d14, today}, general_purpose{d14, today, share_d14,
  by_session_d14, by_session_today}, tools{main, sub}, cache_hit_pct{d14, today},
  prompts{d14, today}, concurrency{max, median, buckets, bucket_s}, ask_wait{count,
  median_s, p90_s, max_s}, fails{d14, today}}`, recomputed every 10 s.
  - `days[]`: `{date, out, cache_read, cache_write, input, calls, by_model{model: out},
    prompts, spawns, general_purpose, fails, ask_waits, out_main, cache_read_main,
    hours[24]}`, oldest first.
- `hist{t[], cpu[], gpu[], mem[], rx[], tx[], rd[], wr[], cores[][], out_15m[], span_s}`:
  up to 2 min at 1 s. A feed restart leaves a gap in `t` rather than resetting it.
  `span_s` is the seconds the samples actually cover, gaps excluded: label a window or a
  peak from it ("last 40 s"), never a hard-coded "2 min".

Tokens land when a response finishes, so token figures step every few seconds while a
session works. That is real: tween each step over the period, don't smooth it away.

## Performance budget

The wallpaper is a WKWebView that runs all day, so its cost matters more than any single
frame. Measure with `KilnWall --measure 40 --design <id> --period-ms <n>`; footprint means
Activity Monitor's figure, graphics included.

- **Steady state at 300 ms:** WebContent ≤ 3% of one core, WebKit GPU ≤ 3%, page memory
  ≤ 150 MB. **At 100 ms:** WebContent ≤ 6%.
- The cost is frames and per-update work, not data. The recipe:
  1. **Text never animates per frame at fast periods.** `Kiln.glide` is false below
     400 ms; set text directly then (`Kiln.num` does this). Your own tween wrappers must
     check `Kiln.glide`. Never pass `Kiln.period` as a tween length; the runtime clamps
     tweens to `Kiln.tweenMs` (60% of the period, at most 400 ms).
  2. **Bars, needles, arcs, gauges and chart scroll move on the compositor.** Set the new
     `transform` or `opacity` once per update with a CSS transition of `var(--kiln-tween)`.
     Prefer transforms (scaleX for bars, rotate for needles) to SVG attribute changes.
  3. **Charts and canvases redraw once per update, not per frame**, and only the changed
     region where you can.
  4. **Weather loops** may only translate or fade pre-rendered layers, at ≤ 30 fps
     (10–15 fps is enough for drifting cloud and fog).
  5. **GPU memory:** every `will-change`, video-sized canvas and full-screen layer costs
     about 24 MB at 3024×1964. Keep at most 3–4 full-screen layers, size canvases to their
     content, use 1× for soft textures, and drop offscreen copies you no longer draw.
  6. **Per update:** no layout reads after writes (no `getBoundingClientRect` or
     `offsetWidth` in the update path), fixed-size boxes, text written only when the string
     changes.
  7. **Skip sections whose data did not change.** Render the GitHub grid, weather, limits,
     14-day analytics and events only when their sticky block changes; per line, update
     only the fast figures (sys, session rows, the clock, the period).
  8. **Self-check:** in a steady replay at 300 ms, `Kiln.stats` frames per second should be
     close to the update rate (3–4), or 0 when everything moves on the compositor; not 20+.
     Read it in real-time headless Chromium; virtual-time renders barely fire
     `requestAnimationFrame`.
- **No `feTurbulence`, `filter: blur()` or `backdrop-filter` on anything that moves.**
- **One rAF loop: the runtime's.** Weather uses `Kiln.loop`.

## Dev tools

Install the dev dependency once with `npm install` at the repo root (playwright-core), and
fetch a headless shell with `npx playwright-core install chromium-headless-shell`.

- **Renders go through `_shared/chrome-bg.sh`**, never a browser binary directly. It runs
  chrome-headless-shell (no app bundle, no window, no Dock tile) at background QoS on the
  efficiency cores, at most two renders machine-wide. Ad-hoc Playwright scripts pass it as
  `executablePath`.
- Don't render with the Google Chrome app or Playwright's WebKit: both are real apps that
  take focus, flash Dock tiles and put windows in Mission Control. For WebKit itself, use
  the host: `KilnWall --snapshot`.
- **Fixture mode.** `index.html?fixture` replays `_shared/fixture.js`, a synthetic demo
  feed (`npm run fixture` regenerates it from `demo/make-fixture.mjs`, seeded and
  deterministic). `&period=100` sets the replay speed; `&still=<n>` replays n lines and then
  holds still for a screenshot; `&home` draws a Dock and notch on top.
- `_shared/dev-shot.sh <design dir> <out.png> "?fixture&still=8&home"` renders a 1512×982 @2x
  still.
- `_shared/dev-dom.sh <design dir> [query]` dumps the rendered DOM.
- `node _shared/dev-audit.mjs <design dir> <out dir> [--seconds 60] [--period 100]
  [--weather rain]` runs in real time and writes a 2× `frame-NN.png` every 10 s plus
  `audit.txt` (MOVED, RESIZED, PROPORTIONAL digits, console errors). `--video` records a
  `video.webm`.
- `_shared/dev/errcount.mjs <design dir> [feed] [query]` replays a feed and counts page
  errors; `npm run errcount` checks every look.
- `_shared/dev/geomcheck.mjs <design dir> [feed]` replays a feed plus 90 synthetic
  transitions and fails if any tile moves or resizes.
- `npm run stills` renders one still per look into `.release-notes/stills/`.
- A recording of your own live feed (`kiln-feed.py --stream > feed.jsonl`) is a good stress
  input, but it holds your session names, paths and GitHub activity: keep it out of the
  repository. `scripts/scrub-check.sh` checks the tracked tree.
- The real check is the host: `KilnWall --snapshot … --design <id>` and `--measure`, with
  the live feed.
