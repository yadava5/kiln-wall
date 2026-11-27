# The shared feed

`kiln-feed.py --serve` runs the feed once for every app that reads it. KilnWall subscribes to it
when it is there and runs its own `--stream` child when it is not, so nothing changes for anyone
who does not install it. `scripts/install-agent.sh` installs it as a per-user LaunchAgent.

## Why

Two apps read this feed on the author's machine: KilnWall, and a notch app that shows Claude
sessions waiting or finished. Each ran its own copy. The copies computed the same session state
twice, a fraction of a second apart, so the two apps could disagree for a moment, and both
polled: a session change reached an app only on that copy's next period, plus up to one more
period for a transcript to be read.

## Design

- **One process, one socket.** `--serve` listens on
  `~/Library/Application Support/kiln-feed/feed.sock` (or `$KILN_FEED_SOCK`): 0600, in a 0700
  folder whose `flock` it holds for its life. A second `--serve` exits at once; a socket left by
  a crash is replaced; the socket is removed on exit.
- **Subscribers say what they want.** One text command per line: `hello <name>`,
  `want <blocks>|all|none`, `period <ms>`, `status`. They get the same JSON lines as `--stream`,
  holding only the blocks they asked for, with the sticky rule (a block is sent only when it
  changed) kept per subscriber. KilnWall sends `want all` and its period; the notch app sends
  `want claude` and 1000 ms. Each subscriber has its own period; two of them settle into one
  phase, so the feed does one tick for both.
- **Costly blocks only on request.** The claude block is computed whenever anyone is
  subscribed. Weather and GitHub are not polled, the 14-day analytics is not derived, and the
  machine is not sampled (except `ps`, which tells live sessions) unless a subscriber wants
  them. KilnWall's covered pause is now a subscription: within its 120 s grace it stays
  subscribed at 1000 ms, holding the lines, exactly as before; past the grace it unsubscribes,
  and those blocks stop.
- **Pushed, not polled.** kqueue watches `~/.claude/sessions` and each live session's json, the
  cache folder (where the ask-chime lock of a waiting session comes and goes), `chime.jsonl`,
  each live main transcript and each `claude` pid's exit. On a change the feed recomputes the
  claude block after 10 ms and pushes a line to each subscriber whose sessions it changes: a
  state, name, question or agent count, or a new event. A reply streaming into a transcript
  changes none of those, so it pushes nothing; the cache folder changes several times a second
  (the statusline writes there), and costs one `stat` per live session each time.
- **Fallbacks.** No socket: KilnWall runs its own `--stream` child as before, and tries the
  socket again every 30 s, moving to it without a gap in lines. The socket closing while
  subscribed: the socket again, else the child, after the usual backoff. `--snapshot` and
  `--measure` keep a child of their own. `KILN_FEED_SHARED=0` turns the socket off.
- **Storage.** Nothing new is written per event. The feed writes the caches it always wrote
  (analytics every 5 min, the sparkline history every 10 s while someone draws it). The agent
  logs nothing to disk.
- **Started as a module.** The agent loads `kiln-feed.py` as a module rather than running it as
  the script: Python never caches the bytecode of the script it runs, and compiling 3,000 lines
  at every start left about 10 MB with the process (28.8 MB RSS as the script, 18.4 MB as a
  module, same subscriber, measured 2026-11-27).

## Measured

M1 Pro, macOS 26, 2026-11-27, `/usr/bin/python3` 3.9.

**Latency, session change to subscriber.** A scratch `HOME` with one fake session (a `claude`
process, its sessions json, transcript, `chime.jsonl` and ask-chime lock, written the way
Claude Code and its hooks write them); ten rounds of eight changes, each 0.6 to 1.6 s after the
last, timed from the write to the first line that shows it. Before: the notch app's copy (the
`--stream` loop, 1000 ms) and KilnWall's child (`--stream`, 500 ms); after: `--serve` with the
same subscriptions.

| change | before, 1000 ms | after, `want claude`, 1000 ms | before, 500 ms | after, `want all`, 500 ms |
|---|---|---|---|---|
| question or permission opens (lock) | 534 ms | 12 ms | 357 | 19 |
| it is answered (lock gone) | 677 | 12 | 243 | 16 |
| a prompt starts a turn (transcript) | 1109 | 13 | 673 | 15 |
| turn ends (chime.jsonl) | 541 | 12 | 276 | 15 |
| turn ends (transcript only, no hooks) | 1242 | 13 | 631 | 17 |
| session exits | 726 | 12 | 254 | 20 |
| session starts | 670 | 50 | 448 | 73 |
| **all 80: median / p90 / max** | **746 / 1329 / 1744** | **13 / 45 / 930** | **360 / 772 / 906** | **18 / 74 / 101** |

Medians per change. The one slow new reading (930 ms) is a session start: a new pid needs a
`ps`, which the feed runs at most once a second.

**At the agent's low priority.** The LaunchAgent runs at background QoS (`ProcessType`
Background). Measured the same way under `taskpolicy -b`, the first try had a p90 of 198 ms:
a `ps` fork takes 182 ms there (49 ms normally) and the loop waited on it, and the 10 ms settle
was a timeout the kernel may coalesce. So in `--serve` the periodic `ps` runs on a thread and the
settle is a `NOTE_CRITICAL` kqueue timer. Then, at background QoS, every state change above came
in at a median of 14 to 17 ms and at most 20 ms (70 changes); a session start, which needs a
fresh `ps`, at a median of 219 ms (10 starts, max 591 ms).

**CPU and memory, steady state.** Real `HOME`, two live sessions, 60 s after a 15 s warm-up.
CPU is each process's own and its forks' (`ps`, `netstat`), from its own `getrusage`.

| | processes | CPU (own + forks) | RSS |
|---|---|---|---|
| desktop visible, before: KilnWall's child (500 ms) + the notch app's copy | 2 | 4.28% (2.35 + 1.93) | 42.5 MB |
| desktop visible, shared feed (all at 500 ms + claude at 1000 ms) | 1 | 1.97% (0.97 + 1.00) | 25.4 MB |
| desktop covered, before: the notch app's copy only | 1 | 1.0 to 2.3% (3 runs) | 17.4 to 17.7 MB |
| desktop covered, shared feed (claude at 1000 ms) | 1 | 0.9 to 2.3% (4 runs) | 17.7 to 19.4 MB |

With the desktop visible, the shared feed costs half the CPU and 40% less memory than the two
copies. With it covered (most of a working day), KilnWall's child was already stopped, so one
process ran before as now and the two cost the same within the noise: runs taken alternately,
minutes apart, spread from 0.9 to 2.3%, mostly the `ps` fork's cost moving with the machine's
load. What else goes: each return to the desktop past the 120 s grace used to start a new child,
about 0.15 CPU-seconds and 0.6 s before its first line (measured three times); now KilnWall
subscribes, and its first line comes at once, or 0.5 s later when machine rates need a fresh
baseline.

## Install

```sh
scripts/install-agent.sh              # writes ~/Library/LaunchAgents/<bundle id>.feed.plist, starts it
python3 ~/.config/kiln-wall/feed/kiln-feed.py --status   # who is subscribed
scripts/install-agent.sh --uninstall  # stops it, removes the plist; KilnWall goes back to its own copy
```

It runs the feed KilnWall would run (`$KILN_FEED_SCRIPT`, else `~/.config/kiln-wall/feed/`,
else `~/.config/kitty/`), with `ProcessType` Background and `KeepAlive`. Environment variables
the feed reads (`KILN_LAT`, `GH_TOKEN`, ...) come from launchd's environment, as KilnWall's do
when it is opened from Finder: `launchctl setenv`, then `launchctl kickstart -k gui/$UID/<label>`.

## Tests

`tests/feed_serve_test.py` runs `--serve` against real subscribers in a scratch `HOME`: nothing
before `want`, blocks and sticky blocks per subscriber, a period per subscriber, a change pushed
within 250 ms (just after a periodic line, so only a push is faster), a streaming reply pushing
nothing, costly blocks off without a subscriber that wants them, a reader that stops reading
holding up nobody, one server per socket, the socket removed on exit and replaced after a crash.
CI runs it on macOS.
