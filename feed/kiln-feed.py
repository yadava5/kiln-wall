#!/usr/bin/env python3
"""kiln-feed — ONE cheap live feed of this machine and its Claude Code usage.

    kiln-feed.py --once [--pretty]     one JSON snapshot on stdout (~1.1 s)
    kiln-feed.py --stream [--hz 1]     one JSON object per line, flushed, forever
    kiln-feed.py --analytics [--pretty]  refresh the 14-day analytics, print that block

Data layer only; the dashboards (terminal, wallpaper) render it. Stdlib only.
Samplers come from kiln-sample.py, which must sit beside this file.

ENVIRONMENT (all optional; nothing personal is built in)
  KILN_LAT, KILN_LON  decimal degrees for the weather block. Weather is OFF
                      (null) unless BOTH are set: no default location.
  KILN_PLACE          the weather's place label (default: "<lat>, <lon>").
  KILN_GITHUB         set to 0 to turn the github block off (null).
  GH_TOKEN / GITHUB_TOKEN  a GitHub token for the github block. Without one,
                      `gh auth token` is asked once (gh from KILN_GH, else PATH,
                      else /opt/homebrew/bin or /usr/local/bin). The login is
                      the token's own user (GraphQL viewer), never configured.
  KILN_GH             path to the gh CLI.
  KILN_CTX_WINDOW     assumed context window in tokens for non-haiku models
                      (default 1000000; haiku is 200000). See CTX WINDOW below.
Paths are derived from $HOME: Claude Code's ~/.claude (projects/, sessions/)
is read, and the feed's caches live in ~/.claude/cache/kiln-*.
Two inputs come from optional local hooks and are simply empty without them:
~/.claude/cache/ratelimits.d/ (plan-limit records written by a statusline
script) and ~/.claude/cache/chime.jsonl plus ask-chime-<sid>.json (turn-end,
failure and dialog records written by Stop/Notification hooks). Without them
the limits block reads null and states come from the transcripts alone.

--stream EXITS when: stdin reaches EOF (only when stdin is a pipe, socket or
tty; /dev/null or a file is ignored, so a host that spawns it with no stdin
does not kill it at once), SIGTERM/SIGHUP/SIGINT, a write fails (SIGPIPE: the
reader went away), or its parent dies (getppid() changes, e.g. to launchd's 1).
The analytics cache is saved on the way out.

COST (see kiln-sample.py for each sampler's measured price). Every tick:
CPU, per-core, memory, swap (Mach/sysctl via ctypes) and GPU + disk I/O
(IOKit in-process): all ~0 ms, no fork. Battery: IOKit's power-source API in
process (0.03 ms), re-read when powerd posts a change (notify_check, every
tick) and every 2 s regardless. Forks on their own slow phases: ps 5 s (and
at once, at most once a second, when a sessions/*.json names a live pid ps
has not listed yet), netstat 1 s. A listed session whose pid has died is
dropped on the next tick (kill(pid, 0)), not at the next ps. chime.jsonl is
stat'ed every tick. Transcripts are read by a worker thread that
remembers each file's byte offset: live sessions' files every 2 s, a stat
sweep of every transcript every 5 min. A backlog over 64 MB (the first build,
or catching up after the feed was off) runs in a niced `--analytics` child, so
the long-lived process keeps a small heap.

MEASURED 2026-11-04, --stream --hz 1, 6 live sessions, 60 s: own CPU 0.67% of
one core (ps TIME delta), forked children 0.53% (getrusage), RSS 27 MB flat;
tick median 4.6 ms, p95 40 ms (the tick that forks ps). Lines average 17.7 KB,
most of it the analytics block. First analytics build: 663 files, 4.5 GB,
8.7 s, peak RSS 80 MB (in the child). Refresh with nothing new: 0.08 s. The
"feed" block of every snapshot reports the live figures, so a regression
shows there before it shows here.

────────────────────────────────────────────────────────────────────────────
SNAPSHOT SCHEMA  (v 1). Times are epoch seconds; sizes are bytes; pct is 0-100.
null means "not measured / not knowable", never zero.

  v                 1
  t                 snapshot time
  feed              self-cost of this process
    pid, cpu_s (own user+sys CPU so far), child_cpu_s (CPU of its forks so
    far), rss (own resident bytes, from the last ps), tick_ms (compute time
    of this snapshot), up_s
  sys
    cpu, user, sys  whole-machine CPU % over the last tick (user includes nice)
    cores           [% per core], same interval (>= ~1 s baseline)
    load            [1, 5, 15] load averages
    gpu             IOAccelerator "Device Utilization %", or null
    gpu_detail      {renderer, tiler, vram_used, vram_alloc} or null
    mem             {total, used (Activity Monitor's "Memory Used": app +
                    wired + compressed), app (App Memory: anonymous minus
                    purgeable), wired, active, compressed, cached
                    (inactive+speculative, reclaimable), free}
    swap            bytes of swap in use
    net             {rx_bps, tx_bps} bytes/s, all non-loopback interfaces
    disk            {free, total} of / and {read_bps, write_bps} summed over
                    every block storage driver
    batt            {pct, charging, ac, mins_left (null = no estimate),
                    state (pmset's word)} or null on a Mac with no battery;
                    read from the same IOKit source pmset prints
    top_cpu         [[name, cpu%] x5]   from ps, refreshed every 5 s
    top_mem         [[name, rss_bytes] x5]
  claude
    limits
      five_hour, seven_day:
        pct         % used; 0 with stale=true when the window has rolled over
                    (its reset passed and no session has reported a new one);
                    null if no session ever reported this window
        resets_at   epoch, null when stale
        stale       bool
        last_reset_at  (only when stale) the reset epoch that passed
        pace        pct / fraction-of-window-elapsed. 100 = on track to land
                    exactly at 100% at reset; >100 = burning faster than the
                    window allows. 0 when stale; null when pct is null or the
                    window is too young (< 30 min of 5 h, < 12 h of the week).
        burn_per_h  % per hour over the recent history, else null.
                    five_hour: the last 60 min (needs >= 20 min of readings).
                    seven_day: the last 6 h (needs >= 1 h): readings are whole
                    percents, so one hour of a week mostly read 0.0.
        projected   pct at reset. five_hour: at burn_per_h. seven_day: at the
                    window's own average so far (an hour's burn stretched over
                    days of sleep read 479% once). Null while too young.
        runout_at   epoch when 100% is hit at that same rate, null if not
                    before reset; now if already at 100%
      read_at       newest written_at across the statusline's records (when a
                    session last rewrote one; NOT the age of the figure)
      history       [[t, five_pct, seven_pct], ...] last 24 h, one point per
                    15 min, value as of that time. seven: rolled-over window
                    = 0, null = unknown. five: null unless a five-hour window
                    was live at that time (never, on a plan with no five-hour window).
                    From kiln-limits-history.jsonl, cleaned as below.
      week_points   [[t, pct], ...] every weekly reading of the current week,
                    after the same cleaning; first [t, pct, "prev"] = the
                    previous week's last reading
      CLEANING      rows repeated by two feeds appending the same moment are
                    dropped, and within one window (same reset) a reading is
                    never below an earlier one: usage only climbs, so a dip is
                    a stale session's payload (14 -> 13 -> 14 read on
                    2026-11-05). The file keeps the raw rows.
    sessions        live main sessions, newest first:
      sid, name, cwd, pid, kind ("interactive" | "bg": a daemon-hosted
      background session, attached with `claude attach`), up_s, cpu, rss,
      state ("waiting" | "working" | "background" | "failed" | "idle"),
      since (epoch the state began), agents_running (count), model (last
      main-thread model id, null until read), ctx_tokens (last main-thread
      request's input+cache_read+cache_write), ctx_window (assumed, see
      below), ctx_pct, out_15m (output tokens in exactly the last 900 s, by
      each response's own timestamp, the session plus its subagents),
      out_per_min ([60 floats], the same per minute, oldest first), ask (null
      unless waiting: {kind "question" | "permission", tool, text (the first
      question, or the tool's description / command / path,
      whitespace-collapsed, <= 400 chars; "" if the tool_use was not found),
      n (questions asked), since (epoch the dialog opened, from the
      ask-chime lock), agent (subagent id when a subagent asked, else null),
      agent_type (that subagent's type, else null)}. Found by the lock's
      tool_use id: in the transcript chime.jsonl names for that id (the main
      one, or subagents/agent-<id>.jsonl), else the main transcript, else a
      subagent transcript written in the last 10 min; last 512 KB of each.
      With no id: the newest main-thread tool_use), turn_open (bool),
      last_activity (epoch),
      cc_status (Claude Code's own sessions/*.json status; can lag for bg
      sessions, so it is reported, not used)
    sessions_other  count of live claude pids with a sessions/*.json whose
                    kind is neither interactive nor bg (none seen 2026-11-04)
    agents_running  [{id, type, sid, session, desc, started, age_s, idle_s}]
    tokens
      out_per_min   [60 floats] output tokens per minute, oldest first; the
                    last element is the current, partial minute
      today         {out, cache_read, cache_write, input, calls} local day,
                    every transcript incl. subagents; calls = API responses
      partial       true while the first transcript index is still building
    events          last 40, newest last: {t, kind, sid, name, detail}
      kind: done (thread finished, Glass chime) | fail (StopFailure) |
            ask (question/permission dialog opened) | remind | answered |
            agent_start | agent_done
  analytics         see ANALYTICS below. In --stream it is recomputed every
                    10 s from the incrementally maintained index, and the key
                    is PRESENT ONLY on lines where it changed (always on the
                    first line): keep the last one received.
  hist              {t[], cpu[], gpu[], mem[], rx[], tx[], rd[], wr[], cores[][],
                    out_15m[], span_s}: up to 120 samples at 1 s, only on lines
                    where a sample landed. Saved to ~/.claude/cache/kiln-hist.json
                    every 10 s and on exit, reloaded on start with the real
                    timestamps (samples under 10 min old), so a restart leaves a
                    gap in t, not a reset. span_s = seconds the samples really
                    cover: the sum of steps between neighbours, a step over 5 s
                    (a gap) counting 0. Label a window from span_s, not "2 min".

WEATHER (null when offline for 2 h; see class Weather; Open-Meteo's
15-minute "current" values, fetched just after each quarter hour)
  place, fetched_at, observed_at (epoch), temp_c, feels_c, humidity (%),
  code (WMO), kind: clear|partly|cloudy|fog|drizzle|rain|snow|storm,
  text ("light rain"), cloud (%), precip_mm, rain_mm, snow_cm (last 15 min),
  wind_kmh, wind_dir (degrees, FROM), is_day, sunrise, sunset (epoch, today)

ANALYTICS (14 local days incl. today; cache ~/.claude/cache/kiln-analytics.json)
  built_at          last full sweep of the transcript tree
  derived_at        when this block was computed
  ready             false while the first build is running
  progress          [files_done, files_total] while not ready
  days              [{date, out, cache_read, cache_write, input, calls,
                    by_model {model: out}, prompts, spawns, general_purpose,
                    fails, ask_waits, out_main, cache_read_main (main threads
                    only; subagents are the rest), hours [24 floats, output by
                    local hour]}] oldest first
  agent_tokens      {d14, today: {type: {out, cache_read, calls}}} subagent
                    usage by agent type (attributionAgent, else the agent's
                    meta.json agentType), plus "main" for main threads; sorted
                    by cache_read, the volume that drives cost
  hour_matrix       {rows: Mon..Sun, out: [[24 floats] x 7]} output tokens by
                    local weekday x hour
  spawns            {d14: {type: n}, today: {type: n}} main-thread Agent/Task
                    tool_use subagent_type (absent = general-purpose)
  general_purpose   {d14, today, share_d14 (% of spawns), by_session_d14,
                    by_session_today: [[session name, n]] most first}
  tools             {main: [[name, n] x10], sub: [[name, n] x10]}
  cache_hit_pct     {d14, today} cache_read / (cache_read+cache_write+input)
  prompts           {d14, today} human prompts: main-thread user entries whose
                    content is a plain string not starting with "<", minus
                    isMeta / isCompactSummary entries
  concurrency       {max, median, buckets, bucket_s: 600} distinct main
                    sessions with a main-thread API response in each 10-min
                    bucket, over buckets with at least one
  ask_wait          {count, median_s, p90_s, max_s} AskUserQuestion tool_use
                    to its tool_result, main thread
  fails             {d14, today} fail-chime lines in chime.jsonl

────────────────────────────────────────────────────────────────────────────
RULES THAT ARE NOT OBVIOUS

TOKENS ARE COUNTED ONCE PER API RESPONSE. Claude Code writes one transcript
line per content block (thinking, text, each tool_use), and EVERY one of those
lines carries the whole response's `usage`. Measured 2026-11-04: 20 of 20
multi-block responses in a sample repeated it. Summing usage per line counts
a response two or three times; kiln-sample's token_minutes() and
agent_index() did exactly that until 2026-11-04 (2.93x on that day's
transcripts) and now share this rule through kiln-sample's _usage_delta().
Here usage is keyed by message id and only the increase over the last line
of the same id is added.

A LIVE MAIN SESSION is a pid named in ~/.claude/sessions/<pid>.json that is
alive, whose ps comm contains "claude", and whose process started no later
than the file's startedAt + 120 s (a recycled pid is a newer process). This
deliberately INCLUDES `claude bg-spare` processes: a spare is a pre-warmed
process the daemon hands a new background session to, and once claimed it IS
that session and writes the json. It excludes `claude daemon`, `bg-pty-host`
(the spare's pty), `claude attach <id>` and a bare `claude` that only launched
a bg session: those are clients or plumbing and write no sessions json.

SESSION STATE, first match wins:
  waiting     ~/.claude/cache/ask-chime-<sid>.json exists and its pid is alive
              (ask-chime.py holds it while a dialog is open); since = its since
  failed      the latest stop/failure line for the sid in chime.jsonl is
              fail-chime and no main-thread entry is newer; since = its ts
  working     the main turn is open (the last main-thread user/assistant entry
              is newer than the last turn end: system turn_duration,
              stop_hook_summary or compact_boundary, a "[Request interrupted
              by user" entry, or a chime.jsonl stop/failure line) AND (an
              entry within 10 min, or
              the claude process >= 5% CPU, or a child/grandchild >= 5% CPU,
              e.g. a long foreground test run). since = first entry of the turn
  background  turn closed, and a subagent of this session is running, or the
              latest chime stop was "silent" with non-agent task ids pending
              (bash/monitor) less than 15 min ago; since = turn end
  idle        anything else; an open turn with no entry for 10 min and no CPU
              (e.g. a crash mid-turn) lands here too
User entries that are not a model turn do not open one: isMeta and
isCompactSummary entries, and content starting "<local-command", "<command-"
or "<bash-" (a local /exit or /compact, a `!` shell line). Counting them left
three finished sessions "mid-turn" on 2026-11-04.
The process's own CPU is NOT used on its own: subagents run inside the main
claude process, so a session whose turn ended with agents running burns CPU
while being "background", not "working".

A SUBAGENT IS RUNNING when its subagents/agent-<id>.meta.json lacks
"finished": true, its session is live, and its transcript was written in the
last 30 min (or 3 h if chime.jsonl's latest stop still lists it pending). Of
1,841 meta files on 2026-11-04, 1,102 unfinished ones were more than a day old
(sessions killed mid-agent, older Claude Code), hence the time bound.

CTX WINDOW is not in the transcript (the statusline gets it from its payload
and does not persist it). Main sessions on a 1M-context model exceed 200k
tokens, so the window is $KILN_CTX_WINDOW (default 1,000,000) except for haiku
(200,000). ctx_tokens is exact; ctx_pct inherits that assumption.

LIMIT BURN comes from ~/.claude/cache/kiln-limits-history.jsonl, one row
[t, five_pct, five_reset, seven_pct, seven_reset] appended only when the
merged value changes (cap ~2000 rows), read as a step function: the value at
(now - 60 min) is the last row at or before it. Rows exist only while some
kiln-feed runs; a change that happened while none ran is dated when first
seen, which can overstate a burn after a gap.
"""
import calendar
import datetime
import fcntl
import glob
import importlib.util
import json
import os
import re
import resource
import select
import signal
import stat
import sys
import threading
import time

_HERE = os.path.dirname(os.path.realpath(__file__))
_sp = importlib.util.spec_from_file_location(
    "kiln_sample", os.path.join(_HERE, "kiln-sample.py"))
S = importlib.util.module_from_spec(_sp)
_sp.loader.exec_module(S)

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, ".claude")
CACHE = os.path.join(CLAUDE, "cache")
PROJ = os.path.join(CLAUDE, "projects")
SESS = os.path.join(CLAUDE, "sessions")
RL_DIR = os.path.join(CACHE, "ratelimits.d")
CHIME_LOG = os.path.join(CACHE, "chime.jsonl")
HIST_PATH = os.path.join(CACHE, "kiln-limits-history.jsonl")
AN_PATH = os.path.join(CACHE, "kiln-analytics.json")
MAIN_GLOB = os.path.join(PROJ, "*", "*.jsonl")
AGENT_GLOB = os.path.join(PROJ, "*", "*", "subagents", "agent-*.jsonl")

try:
    CTX_WINDOW = int(os.environ.get("KILN_CTX_WINDOW") or 1000000)
except ValueError:
    CTX_WINDOW = 1000000

DAYS = 14
SIDEV_S = 1000.0    # per-response output kept this long (out_15m needs 900 s)
HOT_S = 2.0          # live sessions' transcripts
SWEEP_S = 300.0      # stat sweep of every transcript
SAVE_S = 300.0       # analytics cache write
# Read size per step. MEASURED on the first build (663 files, 4.5 GB): 4 MB
# chunks peaked at 218 MB RSS and held 134 MB afterwards; 1 MB chunks peaked at
# 72 MB, same 8 s. The allocator keeps what the big buffers fragmented.
CHUNK = 1 << 20
# A backlog bigger than this (first build, or catching up after the feed was
# off for a while) is handed to a short-lived `--analytics` child in --stream,
# so the long-lived process never carries that high-water mark.
DELEGATE_BYTES = 64 << 20
W5, W7 = 18000, 604800
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
AGENT_ID = re.compile(r"a[0-9a-f]{16}")
_TS_RE = re.compile(rb'"timestamp":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z?"')
_PBG_RE = re.compile(rb'"pendingBackgroundAgentCount":(\d+)')
_PROMPT = b'"message":{"role":"user","content":"'


# ── small helpers ────────────────────────────────────────────────────────────

def iso_t(s):
    """'2026-11-04T23:28:36.266Z' (UTC) -> epoch float; 0.0 if unparseable.
    Hand-parsed: fromisoformat rejects the Z suffix on /usr/bin/python3 (3.9)."""
    if isinstance(s, bytes):
        s = s.decode("ascii", "replace")
    try:
        t = calendar.timegm((int(s[0:4]), int(s[5:7]), int(s[8:10]),
                             int(s[11:13]), int(s[14:16]), int(s[17:19]), 0, 0, 0))
    except (ValueError, TypeError, IndexError):
        return 0.0
    frac = s[19:].rstrip("Z")
    if frac.startswith("."):
        try:
            t += float("0" + frac)
        except ValueError:
            pass
    return float(t)


def line_ts(ln):
    m = _TS_RE.search(ln)
    return iso_t(m.group(1)) if m else 0.0


def window_dates(now=None):
    """The DAYS local dates ending today, oldest first, and the epoch of the
    first one's local midnight."""
    today = datetime.date.fromtimestamp(now or time.time())
    dates = [today - datetime.timedelta(days=k) for k in range(DAYS - 1, -1, -1)]
    cut = time.mktime((dates[0].year, dates[0].month, dates[0].day, 0, 0, 0, 0, 0, -1))
    return [d.isoformat() for d in dates], cut


def proj(cwd):
    parts = [x for x in (cwd or "").split("/") if x]
    return parts[-1] if parts else "?"


def alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False


def r1(x):
    return round(x, 1) if isinstance(x, float) else x


def _empty_day():
    # om/rm: main-thread output and cache read (sub = total - main).
    # ag: {subagent type: [out, cache_read, calls]}. gps: {sid: general-purpose
    # spawns}, so the feedback can name the session the share came from.
    return {"out": 0, "cr": 0, "cw": 0, "inp": 0, "calls": 0, "models": {},
            "hours": [0] * 24, "prompts": 0, "spawns": {}, "tmain": {}, "tsub": {},
            "waits": [], "conc": {}, "om": 0, "rm": 0, "ag": {}, "gps": {}}


def _bump(d, k, n=1):
    d[k] = d.get(k, 0) + n


def _pctile(v, q):
    if not v:
        return None
    v = sorted(v)
    i = (len(v) - 1) * q
    lo = int(i)
    hi = min(lo + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (i - lo), 1)


# ── the transcript ledger ────────────────────────────────────────────────────

class Ledger:
    """Incremental index over every transcript touched in the last DAYS days.

    One per-file record holds the byte offset already folded in, plus the
    state that must survive between reads: the last message id and the usage
    already counted for it (the dedupe above), the last model and context
    size, the turn markers of a main transcript, and AskUserQuestion calls
    still waiting for their answer. Aggregates are per local day, so the
    window slides by dropping whole days.
    """
    VERSION = 3          # 3: main/sub and per-agent-type tokens, gp per session

    def __init__(self):
        self.lk = threading.RLock()
        self.st = self._empty()
        self.ready = False
        self.progress = [0, 0]
        self.dirty = False
        self.saved = 0.0
        self.live = []                 # [(sid, main_path)], set by Feed
        self.read_bytes = 0
        self.stop = False
        self.child = None
        self.hot_s = HOT_S             # --stream sets this to its period

    @staticmethod
    def _empty():
        # sidev: {sid: [[t, out], ...]} each response of the last ~16 min with
        # its own timestamp, so out_15m covers exactly 900 s (whole minute
        # buckets covered 15-16 min). sidev_from: responses are kept one by one
        # from this time on; before it only the minute buckets hold them (the
        # cache came from an older feed, which kept no sidev). Saved with the
        # cache, so a cache that was itself written soon after an upgrade does
        # not pass for complete.
        return {"v": Ledger.VERSION, "files": {}, "days": {}, "minutes": {},
                "sidmin": {}, "sidev": {}, "sidev_from": 0.0, "names": {}, "built_at": 0,
                "swept_at": 0, "first_build_s": None}

    def load(self):
        try:
            with open(AN_PATH) as f:
                d = json.load(f)
        except (OSError, ValueError):
            return False
        if not isinstance(d, dict) or d.get("v") != self.VERSION or "files" not in d:
            return False
        base = self._empty()
        base.update(d)
        self.st = base
        self.ready = bool(base.get("swept_at"))
        if not isinstance(d.get("sidev_from"), (int, float)) or "sidev" not in d:
            base["sidev"], base["sidev_from"] = {}, time.time()
        return True

    def save(self):
        with self.lk:
            blob = json.dumps(self.st, separators=(",", ":"))
            self.dirty = False
        tmp = "%s.%d.tmp" % (AN_PATH, os.getpid())
        try:
            with open(tmp, "w") as f:
                f.write(blob)
            os.replace(tmp, AN_PATH)
            self.saved = time.time()
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass

    # -- reading -------------------------------------------------------------

    @staticmethod
    def _newrec(path):
        parts = path.split(os.sep)
        if parts[-2] == "subagents":
            return {"off": 0, "mt": 0, "k": "a", "sid": parts[-3]}
        return {"off": 0, "mt": 0, "k": "m", "sid": parts[-1][:-6]}

    def _read(self, path, rec, st, cut, dates):
        if st.st_size < rec["off"]:              # truncated / rewritten
            with self.lk:
                rec.clear()
                rec.update(self._newrec(path))
        off = rec["off"]
        if st.st_size == off:
            rec["mt"] = st.st_mtime
            return
        if rec["k"] == "a" and "at" not in rec:
            # The agent's type, for lines that predate `attributionAgent`.
            try:
                with open(path[:-6] + ".meta.json") as f:
                    rec["at"] = json.load(f).get("agentType") or "?"
            except (OSError, ValueError):
                rec["at"] = "?"
        try:
            f = open(path, "rb")
        except OSError:
            return
        with f:
            f.seek(off)
            buf = b""
            while not self.stop:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                buf = buf + chunk if buf else chunk
                # Stop at the last COMPLETE line: a transcript being appended to
                # can be read mid-line, and skipping past it loses that line.
                n = buf.rfind(b"\n") + 1
                if n:
                    with self.lk:
                        self._fold(rec, buf[:n], cut, dates)
                        rec["off"] = off + n
                    off += n
                    self.read_bytes += n
                    buf = buf[n:]
        rec["mt"] = st.st_mtime
        self.dirty = True

    def _day(self, t, cut):
        if t < cut:
            return None, 0
        lt = time.localtime(t)
        key = "%04d-%02d-%02d" % lt[:3]
        d = self.st["days"].get(key)
        if d is None:
            d = self.st["days"][key] = _empty_day()
        return d, lt.tm_hour

    def _fold(self, rec, data, cut, dates):
        main = rec["k"] == "m"
        sid = rec["sid"]
        now = time.time()
        for ln in data.split(b"\n"):
            if not ln:
                continue
            if b'"usage"' in ln and b'"type":"assistant"' in ln:
                try:
                    d = json.loads(ln)
                except ValueError:
                    continue
                if d.get("type") == "assistant":
                    self._assistant(rec, d, main and not d.get("isSidechain"), sid, cut, now)
                    continue
                # else: a user line whose tool result merely QUOTES those
                # strings (an Agent result carries "usage"); handled below.
            if not main or b'"isSidechain":false' not in ln[:300]:
                continue
            head = ln[:400]
            if b'"type":"user"' in head:
                t = line_ts(ln)
                if not t:
                    continue
                i = ln.find(_PROMPT)
                lead = ln[i + len(_PROMPT):i + len(_PROMPT) + 16] if i >= 0 else b""
                meta = b'"isMeta":true' in ln or b'"isCompactSummary":true' in ln
                # A local slash command (/exit, /compact's own echo), a `!`
                # shell line, a caveat or a compaction summary is written as a
                # user entry but is not a model turn. Counting them left three
                # finished sessions "mid-turn" on 2026-11-04.
                if not meta and not lead.startswith((b"<local-command", b"<command-", b"<bash-")):
                    self._activity(rec, t)
                if b"[Request interrupted by user" in ln:
                    rec["te"] = max(rec.get("te", 0), t)
                day, _ = self._day(t, cut)
                if (i >= 0 and lead[:1] not in (b"<", b'"') and not meta
                        and day is not None):
                    day["prompts"] += 1
                auq = rec.get("auq")
                if auq and b'"tool_result"' in ln:
                    for tid in list(auq):
                        if tid.encode() in ln:
                            t0 = auq.pop(tid)
                            if day is not None and t >= t0:
                                day["waits"].append(round(t - t0, 1))
            elif b'"type":"system"' in head and (b'"subtype":"turn_duration"' in head
                                                 or b'"subtype":"stop_hook_summary"' in head
                                                 or b'"subtype":"compact_boundary"' in head):
                t = line_ts(ln)
                if t:
                    rec["te"] = max(rec.get("te", 0), t)
                    m = _PBG_RE.search(ln)
                    if m:
                        rec["pbg"] = int(m.group(1))
        auq = rec.get("auq")
        if auq:                                   # never answered: forget after a day
            for tid in [k for k, v in auq.items() if now - v > 86400]:
                del auq[tid]

    def _activity(self, rec, t):
        if t >= rec.get("ta", 0):
            if rec.get("ta", 0) <= rec.get("te", 0):
                rec["tt"] = t                     # first entry of a new turn
            rec["ta"] = t

    def _assistant(self, rec, d, main, sid, cut, now):
        m = d.get("message")
        if not isinstance(m, dict):
            return
        t = iso_t(d.get("timestamp") or "")
        if not t:
            return
        model = m.get("model") or ""
        day, hour = self._day(t, cut)
        if main:
            self._activity(rec, t)
        u = m.get("usage")
        if isinstance(u, dict) and not model.startswith("<"):
            # `<synthetic>` is a message Claude Code made locally, no model.
            o = u.get("output_tokens") or 0
            cr = u.get("cache_read_input_tokens") or 0
            cw = u.get("cache_creation_input_tokens") or 0
            ip = u.get("input_tokens") or 0
            mid = m.get("id") or d.get("requestId") or ""
            if mid and mid == rec.get("mid"):
                do, dr = max(0, o - rec["mo"]), max(0, cr - rec["mr"])
                dw, di = max(0, cw - rec["mw"]), max(0, ip - rec["mi"])
                rec["mo"], rec["mr"] = max(o, rec["mo"]), max(cr, rec["mr"])
                rec["mw"], rec["mi"] = max(cw, rec["mw"]), max(ip, rec["mi"])
                call = 0
            else:
                rec["mid"], rec["mo"], rec["mr"], rec["mw"], rec["mi"] = mid, o, cr, cw, ip
                do, dr, dw, di, call = o, cr, cw, ip, 1
            rec["model"] = model
            rec["ctx"] = ip + cr + cw
            if day is not None:
                day["out"] += do
                day["cr"] += dr
                day["cw"] += dw
                day["inp"] += di
                day["calls"] += call
                _bump(day["models"], model, do)
                day["hours"][hour] += do
                if main:
                    day["om"] += do
                    day["rm"] += dr
                else:
                    a = day["ag"].setdefault(d.get("attributionAgent") or rec.get("at") or "?",
                                             [0, 0, 0])
                    a[0] += do
                    a[1] += dr
                    a[2] += call
                if main and call:
                    b = str(int((t - time.mktime(time.localtime(t)[:3] + (0, 0, 0, 0, 0, -1))) // 600))
                    lst = day["conc"].setdefault(b, [])
                    if sid not in lst:
                        lst.append(sid)
            if do and t >= now - 7200:
                k = str(int(t // 60))
                _bump(self.st["minutes"], k, do)
                _bump(self.st["sidmin"].setdefault(sid, {}), k, do)
                if t >= now - SIDEV_S and t >= self.st["sidev_from"]:
                    self.st["sidev"].setdefault(sid, []).append([round(t, 3), do])
        content = m.get("content")
        if not isinstance(content, list):
            return
        for c in content:
            if not isinstance(c, dict) or c.get("type") != "tool_use":
                continue
            name = c.get("name") or "?"
            if day is not None:
                _bump(day["tmain"] if main else day["tsub"], name)
            if not main:
                continue
            if name in ("Agent", "Task") and day is not None:
                inp = c.get("input") or {}
                typ = inp.get("subagent_type") or "general-purpose"
                _bump(day["spawns"], typ)
                if typ == "general-purpose":
                    _bump(day["gps"], sid)
            elif name == "AskUserQuestion" and c.get("id"):
                rec.setdefault("auq", {})[c["id"]] = t

    # -- passes --------------------------------------------------------------

    def _scan(self, paths, count=False):
        dates, cut = window_dates()
        files = self.st["files"]
        for p in paths:
            if self.stop:
                return
            if count:
                self.progress[0] += 1
            try:
                st = os.stat(p)
            except OSError:
                continue
            rec = files.get(p)
            if rec is None:
                if st.st_mtime < cut:
                    continue
                rec = self._newrec(p)
                with self.lk:
                    files[p] = rec
            elif st.st_size == rec["off"]:
                continue
            self._read(p, rec, st, cut, dates)

    HOT_FULL_S, WARM_S = 5.0, 60.0

    def hot(self):
        """Live sessions' main transcript and every subagent transcript.

        At a 100 ms period a busy session's hundreds of finished subagent
        transcripts would be listed and stat'ed ten times a second. So the
        full set is scanned every HOT_FULL_S, and in between only the main
        transcripts plus the subagent files that grew in the last WARM_S."""
        now = time.monotonic()
        full = now - getattr(self, "_hot_full", -1e18) >= self.HOT_FULL_S
        warm = getattr(self, "_warm", None)
        if warm is None:
            warm = self._warm = {}
        paths = []
        for sid, mp in list(self.live):
            if not mp:
                continue
            paths.append(mp)
            if not full:
                continue
            sub = os.path.join(mp[:-6], "subagents")
            try:
                paths += [os.path.join(sub, n) for n in os.listdir(sub)
                          if n.startswith("agent-") and n.endswith(".jsonl")]
            except OSError:
                pass
        if full:
            self._hot_full = now
        else:
            paths += [p for p, t in warm.items() if now - t < self.WARM_S and p not in paths]
        files = self.st["files"]
        before = {p: (files.get(p) or {}).get("off") for p in paths}
        self._scan(paths)
        for p in paths:
            rec = files.get(p)
            if rec is not None and rec.get("off") != before[p]:
                warm[p] = now
        for p in [p for p, t in warm.items() if now - t >= self.WARM_S]:
            del warm[p]
        self._prune()

    def backlog(self, paths):
        """Bytes a sweep over `paths` would have to read."""
        _, cut = window_dates()
        files = self.st["files"]
        n = 0
        for p in paths:
            try:
                st = os.stat(p)
            except OSError:
                continue
            rec = files.get(p)
            if rec is None:
                n += st.st_size if st.st_mtime >= cut else 0
            else:
                n += max(0, st.st_size - rec["off"])
        return n

    def delegate(self):
        """Run the big read in a child `--analytics`, then adopt its cache."""
        import subprocess
        try:
            self.child = subprocess.Popen(
                ["/usr/bin/nice", "-n", "10", sys.executable,
                 os.path.realpath(__file__), "--analytics"],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)
            self.child.wait(timeout=900)
        except Exception:
            return
        finally:
            self.child = None
        with self.lk:
            self.load()

    def sweep(self, paths=None):
        t0 = time.time()
        first = not self.ready
        if paths is None:
            paths = glob.glob(MAIN_GLOB) + glob.glob(AGENT_GLOB)
        self.progress = [0, len(paths)]
        self._scan(paths, count=True)
        if self.stop:
            return
        seen = set(paths)
        _, cut = window_dates()
        with self.lk:
            files = self.st["files"]
            for p in [p for p, r in files.items() if p not in seen or r.get("mt", 0) < cut]:
                del files[p]
            self._prune()
            self.st["swept_at"] = self.st["built_at"] = time.time()
            if first:
                self.st["first_build_s"] = round(time.time() - t0, 2)
        self.ready = True
        self.dirty = True

    def _prune(self):
        dates, _ = window_dates()
        keep = set(dates)
        lo = str(int(time.time() // 60) - 120)
        with self.lk:
            for k in [k for k in self.st["days"] if k not in keep]:
                del self.st["days"][k]
            mins = self.st["minutes"]
            for k in [k for k in mins if int(k) < int(lo)]:
                del mins[k]
            for sid in list(self.st["sidmin"]):
                sm = self.st["sidmin"][sid]
                for k in [k for k in sm if int(k) < int(lo)]:
                    del sm[k]
                if not sm:
                    del self.st["sidmin"][sid]
            ev = self.st["sidev"]
            old = time.time() - SIDEV_S
            for sid in list(ev):
                if ev[sid] and ev[sid][0][0] >= old:
                    continue                      # appended in time order: nothing aged out
                ev[sid] = [e for e in ev[sid] if e[0] >= old]
                if not ev[sid]:
                    del ev[sid]

    def worker(self):
        last_sweep = self.st.get("swept_at") or 0
        while not self.stop:
            try:
                if time.time() - last_sweep >= SWEEP_S or not self.ready:
                    paths = glob.glob(MAIN_GLOB) + glob.glob(AGENT_GLOB)
                    if self.backlog(paths) > DELEGATE_BYTES:
                        self.delegate()
                    if self.stop:
                        return
                    self.hot()
                    self.sweep(paths)
                    last_sweep = time.time()
                else:
                    self.hot()
                if self.dirty and time.time() - self.saved >= SAVE_S:
                    self.save()
            except Exception as e:                   # never let the feed die
                sys.stderr.write("kiln-feed: ledger: %r\n" % (e,))
            # Re-read each pass, so a period change takes effect within one wait.
            end = time.monotonic() + max(0.1, self.hot_s)
            while time.monotonic() < end:
                if self.stop:
                    return
                time.sleep(min(0.05, max(0.0, end - time.monotonic())))

    # -- views (cheap; called under the lock) -------------------------------

    def tokens(self, now):
        with self.lk:
            m = self.st["minutes"]
            nm = int(now // 60)
            series = [float(m.get(str(k), 0)) for k in range(nm - 59, nm + 1)]
            d = self.st["days"].get(datetime.date.fromtimestamp(now).isoformat()) or _empty_day()
            return {"out_per_min": series,
                    "today": {"out": d["out"], "cache_read": d["cr"], "cache_write": d["cw"],
                              "input": d["inp"], "calls": d["calls"]},
                    "partial": not self.ready}

    def main_rec(self, path):
        with self.lk:
            r = self.st["files"].get(path)
            return dict(r) if r else None

    def out_since(self, sid, t):
        """Output tokens of one session (plus its subagents) with a timestamp
        >= t, counted per response. Summing whole minute buckets from
        int(t // 60) covered 15-16 min for a 15-min figure."""
        with self.lk:
            n = sum(v for tt, v in self.st["sidev"].get(sid, ()) if tt >= t)
            since = self.st["sidev_from"]
            if since > t:
                # Before per-response recording began (a cache from an older
                # feed): the minute buckets, the edge minutes pro-rated.
                sm = self.st["sidmin"].get(sid) or {}
                for k in range(int(t // 60), int(since // 60) + 1):
                    v = sm.get(str(k))
                    if v:
                        lo, hi = max(t, k * 60.0), min(since, k * 60.0 + 60)
                        if hi > lo:
                            n += v * (hi - lo) / 60.0
            return int(round(n))

    def sid_series(self, sid, now):
        """[60 floats] output per minute of one session plus its subagents."""
        with self.lk:
            sm = self.st["sidmin"].get(sid) or {}
            nm = int(now // 60)
            return [float(sm.get(str(k), 0)) for k in range(nm - 59, nm + 1)]

    def analytics(self, now, fails_by_day):
        dates, _ = window_dates(now)
        today = dates[-1]
        with self.lk:
            days = self.st["days"]
            mx = [[0] * 24 for _ in range(7)]
            sp14, sptd, tm, ts_ = {}, {}, {}, {}
            ag14, agtd, gp14, gptd = {}, {}, {}, {}
            names = self.st["names"]
            waits, conc, out = [], [], []
            tot = {"out": 0, "cr": 0, "cw": 0, "inp": 0, "prompts": 0}
            for ds in dates:
                r = days.get(ds) or _empty_day()
                wd = datetime.date.fromisoformat(ds).weekday()
                for h in range(24):
                    mx[wd][h] += r["hours"][h]
                for k, v in r["spawns"].items():
                    _bump(sp14, k, v)
                    if ds == today:
                        _bump(sptd, k, v)
                for typ, (o, cr, n) in list(r["ag"].items()) + [
                        ("main", (r["om"], r["rm"],
                                  r["calls"] - sum(v[2] for v in r["ag"].values())))]:
                    for acc in (ag14, agtd) if ds == today else (ag14,):
                        a = acc.setdefault(typ, {"out": 0, "cache_read": 0, "calls": 0})
                        a["out"] += o
                        a["cache_read"] += cr
                        a["calls"] += n
                for sid, n in r["gps"].items():
                    nm = names.get(sid) or sid[:8]
                    _bump(gp14, nm, n)
                    if ds == today:
                        _bump(gptd, nm, n)
                for k, v in r["tmain"].items():
                    _bump(tm, k, v)
                for k, v in r["tsub"].items():
                    _bump(ts_, k, v)
                waits += r["waits"]
                conc += [len(v) for v in r["conc"].values() if v]
                for k in tot:
                    tot[k] += r[k]
                out.append({"date": ds, "out": r["out"], "cache_read": r["cr"],
                            "cache_write": r["cw"], "input": r["inp"], "calls": r["calls"],
                            "by_model": dict(sorted(r["models"].items(), key=lambda x: -x[1])),
                            "prompts": r["prompts"], "spawns": sum(r["spawns"].values()),
                            "general_purpose": r["spawns"].get("general-purpose", 0),
                            "fails": fails_by_day.get(ds, 0), "ask_waits": len(r["waits"]),
                            "out_main": r["om"], "cache_read_main": r["rm"],
                            "hours": list(r["hours"])})
            td = days.get(today) or _empty_day()
            built = self.st.get("built_at") or None

        def hit(cr, cw, ip):
            return round(100.0 * cr / (cr + cw + ip), 1) if cr + cw + ip else None
        n_sp = sum(sp14.values())
        gp = sp14.get("general-purpose", 0)
        a = {"built_at": built, "derived_at": round(now, 1), "window_days": DAYS,
             "ready": self.ready, "first_build_s": self.st.get("first_build_s"),
             "days": out,
             "hour_matrix": {"rows": WEEKDAYS, "out": mx},
             "spawns": {"d14": dict(sorted(sp14.items(), key=lambda x: -x[1])),
                        "today": dict(sorted(sptd.items(), key=lambda x: -x[1]))},
             "general_purpose": {"d14": gp, "today": sptd.get("general-purpose", 0),
                                 "share_d14": round(100.0 * gp / n_sp, 1) if n_sp else None,
                                 "by_session_d14": sorted(gp14.items(), key=lambda x: -x[1]),
                                 "by_session_today": sorted(gptd.items(), key=lambda x: -x[1])},
             "agent_tokens": {"d14": dict(sorted(ag14.items(), key=lambda x: -x[1]["cache_read"])),
                              "today": dict(sorted(agtd.items(), key=lambda x: -x[1]["cache_read"]))},
             "tools": {"main": sorted(tm.items(), key=lambda x: -x[1])[:10],
                       "sub": sorted(ts_.items(), key=lambda x: -x[1])[:10]},
             "cache_hit_pct": {"d14": hit(tot["cr"], tot["cw"], tot["inp"]),
                               "today": hit(td["cr"], td["cw"], td["inp"])},
             "prompts": {"d14": tot["prompts"], "today": td["prompts"]},
             "concurrency": {"max": max(conc) if conc else 0,
                             "median": _pctile(conc, 0.5), "buckets": len(conc),
                             "bucket_s": 600},
             "ask_wait": {"count": len(waits), "median_s": _pctile(waits, 0.5),
                          "p90_s": _pctile(waits, 0.9),
                          "max_s": max(waits) if waits else None},
             "fails": {"d14": sum(fails_by_day.get(d, 0) for d in dates),
                       "today": fails_by_day.get(today, 0)}}
        if not self.ready:
            a["progress"] = list(self.progress)
        return a


# ── chime.jsonl: turn ends, failures, dialogs ───────────────────────────────

class Chime:
    """Tails chime.jsonl by byte offset. Keeps the latest stop/failure line per
    session (for state), the events, and fail-chime counts per local day."""

    def __init__(self):
        self.off = None
        self.last_stop = {}     # sid -> {"ts", "verdict", "pending"}
        self.events = []
        self.fails = {}
        self.cwd = {}
        # tool_use id -> (subagent id or None, transcript basename, tool): where
        # ask-chime.py found the dialog's tool_use (its "agent"/"in" fields).
        self.ask_src = {}

    def poll(self):
        try:
            size = os.path.getsize(CHIME_LOG)
        except OSError:
            return
        if self.off is None or size < self.off:
            self.off = max(0, size - (4 << 20)) if self.off is None else 0
            first = True
        else:
            first = False
        if size == self.off:
            return
        try:
            with open(CHIME_LOG, "rb") as f:
                f.seek(self.off)
                if first and self.off:
                    f.readline()
                    self.off = f.tell()
                data = f.read()
        except OSError:
            return
        n = data.rfind(b"\n") + 1
        self.off += n
        for ln in data[:n].split(b"\n"):
            try:
                r = json.loads(ln)
            except ValueError:
                continue
            if isinstance(r, dict):
                self._one(r)
        del self.events[:-200]

    def _one(self, r):
        ts, sid, v, ev = r.get("ts") or 0, r.get("sid") or "", r.get("verdict"), r.get("event")
        if r.get("cwd") and sid:
            self.cwd[sid] = r["cwd"]
        if ev in ("stop", "failure"):
            self.last_stop[sid] = {"ts": ts, "verdict": v, "pending": r.get("pending") or []}
        if ev == "ask" and r.get("id") and r.get("in"):
            old = self.ask_src.pop(r["id"], None)
            if old and old[0] and not r.get("agent"):
                r = dict(r, agent=old[0], **{"in": old[1]})   # keep the subagent's file
            self.ask_src[r["id"]] = (r.get("agent"), r["in"], r.get("tool"))
            while len(self.ask_src) > 64:
                del self.ask_src[next(iter(self.ask_src))]
        kind = detail = None
        if v == "chime":
            kind, detail = "done", r.get("why") or ""
        elif v == "fail-chime":
            kind, detail = "fail", r.get("error") or ""
            ds = datetime.date.fromtimestamp(ts).isoformat()
            self.fails[ds] = self.fails.get(ds, 0) + 1
        elif v == "ask-chime":
            kind = "ask"
            detail = " ".join(x for x in (r.get("src"), r.get("tool") or r.get("type")) if x)
        elif v == "remind":
            kind, detail = "remind", "reminder %s" % r.get("n")
        elif v == "answered":
            kind, detail = "answered", "after %ss" % r.get("after_s")
        elif ev == "stop":
            # A turn that ended without a chime (the user was at the keyboard): 311 of 370
            # turn ends on 2026-11-05. Dropping them left "Recent activity" at 11 pm
            # through an evening of work.
            kind, detail = "done", ""
        if kind == "done":
            # One line per stretch of work: a session's turn ends within 10 min of
            # each other coalesce into the newest, carrying how many there were.
            for i in range(len(self.events) - 1, max(-1, len(self.events) - 16), -1):
                e = self.events[i]
                if e["sid"] == sid and e["kind"] == "done" and ts - e["t"] < 600:
                    del self.events[i]
                    n = e.get("n", 1) + 1
                    self.events.append({"t": ts, "kind": kind, "sid": sid,
                                        "detail": detail or e["detail"], "n": n})
                    return
        if kind:
            self.events.append({"t": ts, "kind": kind, "sid": sid, "detail": detail})


# ── subagents of live sessions ───────────────────────────────────────────────

class Agents:
    """meta.json beside each subagent transcript states its type, its
    description and, once done, "finished": true. Re-read only when its mtime
    moves; the transcript's birth time is the start, its mtime the last write."""

    FULL_S = 5.0    # a full listing at least this often, whatever the dir says

    def __init__(self):
        self.a = {}
        self.events = []
        self.dirs = {}  # subagents dir -> (dir mtime, time of last full listing)

    def _quick(self, sid, sub):
        """Only the unfinished agents of one session: a finished agent's meta
        never changes again, and a new agent changes the directory's mtime
        (caught by the full pass). Saves ~750 stats a tick on a busy session."""
        for a in self.a.values():
            if a["sid"] != sid or a["finished"]:
                continue
            mpath = os.path.join(sub, "agent-%s.meta.json" % a["id"])
            try:
                if os.stat(mpath).st_mtime != a["mmt"]:
                    return False            # meta changed (finished?): full pass
                a["last"] = os.stat(mpath[:-10] + ".jsonl").st_mtime
            except OSError:
                pass
        return True

    def poll(self, live, now):
        for sid, mp in live:
            if not mp:
                continue
            sub = os.path.join(mp[:-6], "subagents")
            try:
                dmt = os.stat(sub).st_mtime
            except OSError:
                continue
            seen = self.dirs.get(sub)
            if seen and seen[0] == dmt and now - seen[1] < self.FULL_S and self._quick(sid, sub):
                continue
            try:
                names = os.listdir(sub)
            except OSError:
                continue
            self.dirs[sub] = (dmt, now)
            for n in names:
                if not (n.startswith("agent-") and n.endswith(".meta.json")):
                    continue
                aid = n[6:-10]
                mpath = os.path.join(sub, n)
                try:
                    mst = os.stat(mpath)
                except OSError:
                    continue
                a = self.a.get(aid)
                jp = mpath[:-10] + ".jsonl"
                if a is not None and a["mmt"] == mst.st_mtime:
                    if not a["finished"]:
                        try:
                            a["last"] = os.stat(jp).st_mtime
                        except OSError:
                            pass
                    continue
                try:
                    with open(mpath) as f:
                        meta = json.load(f)
                except (OSError, ValueError):
                    continue
                try:
                    jst = os.stat(jp)
                    start = getattr(jst, "st_birthtime", jst.st_mtime)
                    last = jst.st_mtime
                except OSError:
                    start = getattr(mst, "st_birthtime", mst.st_mtime)
                    last = mst.st_mtime
                fin = bool(meta.get("finished"))
                new = a is None
                was = a["finished"] if a else None
                self.a[aid] = a = {"id": aid, "sid": sid, "type": meta.get("agentType") or "?",
                                   "desc": meta.get("description") or "", "start": start,
                                   "last": last, "finished": fin, "mmt": mst.st_mtime}
                det = "%s: %s" % (a["type"], a["desc"])
                if new and now - start < 86400:
                    self.events.append({"t": start, "kind": "agent_start", "sid": sid,
                                        "detail": det, "id": aid})
                if fin and (was is False or (new and now - last < 86400)):
                    self.events.append({"t": last, "kind": "agent_done", "sid": sid,
                                        "detail": det, "id": aid})
        if len(self.events) > 200:      # trim the OLDEST, not the first scanned
            self.events.sort(key=lambda e: e["t"])
            del self.events[:-200]

    def running(self, live_sids, pending, now):
        out = []
        for a in self.a.values():
            if a["finished"] or a["sid"] not in live_sids:
                continue
            idle = now - a["last"]
            if idle < 1800 or (a["id"] in pending.get(a["sid"], ()) and idle < 10800):
                out.append(a)
        out.sort(key=lambda a: a["start"])
        return out


# ── plan-limit history ───────────────────────────────────────────────────────

class History:
    CAP = 2000

    def __init__(self):
        self.rows = self._load()           # raw, as in the file
        self._clean_of = None
        self._clean = []

    @staticmethod
    def _parse(lines):
        rows = []
        for ln in lines:
            try:
                r = json.loads(ln)
            except ValueError:
                continue
            if isinstance(r, list) and len(r) == 5:
                rows.append(r)
        return rows

    @classmethod
    def _load(cls):
        try:
            with open(HIST_PATH) as f:
                return cls._parse(f)
        except OSError:
            return []

    @property
    def clean(self):
        """The rows as readers should see them (see CLEANING): no repeats, and
        within one window (same reset) never below an earlier reading."""
        if self._clean_of is not self.rows:        # observe() swaps in a new list
            hi, out = {}, []
            for r in sorted(self.rows, key=lambda r: r[0]):
                r = list(r)
                for i in (1, 3):
                    if r[i] is None or r[i + 1] is None:
                        continue
                    k = (i, r[i + 1])
                    if r[i] < hi.get(k, r[i]):
                        r[i] = hi[k]
                    hi[k] = r[i]
                if out and out[-1][1:] == r[1:]:
                    continue
                if out and out[-1][0] == r[0]:
                    out[-1] = r                 # same second: the later row stands
                    continue
                out.append(r)
            self._clean, self._clean_of = out, self.rows
        return self._clean

    def observe(self, L, now):
        f, w = L["five_hour"], L["seven_day"]
        key = [f["pct"], f["resets_at"], w["pct"], w["resets_at"]]
        if self.rows and self.rows[-1][1:] == key:
            return
        row = [int(now)] + key
        try:
            # Two feeds (the wallpaper's and a terminal's) can see the same
            # change in the same second; without the lock both appended it.
            with open(HIST_PATH, "a+") as fh:
                fcntl.flock(fh, fcntl.LOCK_EX)
                fh.seek(0)
                rows = self._parse(fh)          # another feed may have appended
                if rows and rows[-1][1:] == key:
                    self.rows = rows
                    return
                rows.append(row)
                if len(rows) > self.CAP + 400:
                    rows = rows[-self.CAP:]
                    tmp = "%s.%d.tmp" % (HIST_PATH, os.getpid())
                    with open(tmp, "w") as out:
                        out.write("".join(json.dumps(r) + "\n" for r in rows))
                    os.replace(tmp, HIST_PATH)
                else:
                    fh.seek(0, os.SEEK_END)
                    fh.write(json.dumps(row) + "\n")
                self.rows = rows
        except OSError:
            if not (self.rows and self.rows[-1][1:] == key):
                self.rows = self.rows + [row]

    def burn(self, idx, reset, pct, now, look=3600, min_span=1200):
        """% per second over the recent readings of THIS window, or None."""
        rows = [(r[0], r[idx]) for r in self.clean
                if r[idx + 1] == reset and r[idx] is not None and r[0] <= now]
        if not rows:
            return None, 0
        base = None
        for t, p in rows:
            if t <= now - look:
                base = (now - look, p)      # step value as of the look-back
        if base is None:
            base = rows[0]
        span = now - base[0]
        if span < min_span:
            return None, span
        return (pct - base[1]) / span, span

    def series(self, now, hours=24, step=900):
        pts = []
        rows = self.clean
        j = -1
        t = now - hours * 3600 + step
        while t <= now + 1:
            while j + 1 < len(rows) and rows[j + 1][0] <= t:
                j += 1
            if j >= 0:
                r = rows[j]
                # five: only while a five-hour window is live at t (a reset
                # still ahead). A rolled-over or never-reported window is
                # null, not 0 (a plan with no five-hour window never reports one).
                five = r[1] if (r[1] is not None and r[2] and r[2] > t) else None
                week = None if r[3] is None else (0 if (r[4] and r[4] <= t) else r[3])
                pts.append([int(t), five, week])
            t += step
        return pts


# ── machine sampler ──────────────────────────────────────────────────────────

class Sys:
    # Measured 2026-11-04 (5 calls each): swap, disk free, memory, pressure, GPU
    # (IOKit) and disk I/O cost under 0.1 ms, so they run every tick (0 = always).
    # net (1.3 ms CPU, 14 ms wall) and ps (2.5/28) fork, so they keep their own
    # slower phases whatever the stream period is. Battery (2026-11-05): no
    # longer pmset (6.3 ms child CPU, so it ran every 30 s and lagged 7-23 s);
    # IOKit in process, 0.03 ms, on powerd's change notification and every 2 s.
    PHASES = {"ps": 5.0, "net": 1.0, "batt": 2.0, "swap": 0.0, "disk": 0.0,
              "gpu_fork": 3.0}
    PS_MIN_S = 1.0       # an on-demand ps (a new session) at most this often

    def __init__(self):
        self.last = {}
        self.prev = None
        self.core_ref = []
        self.cpu = self.user = self.sys = 0.0
        self.cores = []
        self.gpu = None
        self.gpu_ok = S.gpu_iokit() is not None
        self.mem = None
        self.app = 0
        self.pressure = None
        self.free = 0
        self.swap = 0
        self.disk = (0, 0)
        self.net = (0.0, 0.0)
        self._net = None
        self.dio = (0.0, 0.0)
        self._dio = None
        self.batt = None
        self.procs = []
        self.ps_at = 0.0

    def _due(self, name, now, force):
        if force or now - self.last.get(name, -1e18) >= self.PHASES[name]:
            self.last[name] = now
            return True
        return False

    def tick(self, force=False):
        now = time.time()
        mono = time.monotonic()
        t = S.cpu_ticks()
        if t and self.prev:
            d = [b - a for a, b in zip(self.prev, t)]
            tot = sum(d)
            if tot:
                self.cpu = 100.0 * (tot - d[2]) / tot
                self.user = 100.0 * (d[0] + d[3]) / tot
                self.sys = 100.0 * d[1] / tot
        if t:
            self.prev = t
        # Per-core needs a baseline of about a second: each core accrues only
        # 100 ticks a second, so a shorter difference rounds to steps of 10%+.
        c = S.per_core_ticks()
        if c:
            self.core_ref.append((mono, c))
            self.core_ref = [(m, v) for m, v in self.core_ref if mono - m <= 3.0]
            ref = next((v for m, v in self.core_ref if mono - m >= 0.8), None)
            if ref is None and len(self.core_ref) > 1:
                ref = self.core_ref[0][1]
            if ref and len(ref) == len(c):
                out = []
                for a, b in zip(ref, c):
                    d = [y - x for x, y in zip(a, b)]
                    tt = sum(d)
                    out.append(100.0 * (tt - d[2]) / tt if tt else 0.0)
                self.cores = out
        v = S.vm_stats()
        self.mem = S.memory(v)
        self.app = S.app_memory(v) if v else 0
        self.pressure = S.mem_pressure()
        self.free = v.free_count * S.PAGE if v else 0
        if self.gpu_ok:
            g = S.gpu_iokit()
            if g:
                self.gpu = g
        elif self._due("gpu_fork", now, force):
            self.gpu = S.gpu()
        io = S.disk_io_bytes()
        if io:
            if self._dio:
                dt = max(1e-3, mono - self._dio[0])
                self.dio = (max(0.0, (io[0] - self._dio[1]) / dt),
                            max(0.0, (io[1] - self._dio[2]) / dt))
            self._dio = (mono, io[0], io[1])
        if self._due("swap", now, force):
            self.swap = S.swap_bytes()
        if self._due("disk", now, force):
            self.disk = S.disk_free()
        if self._due("net", now, force):
            rx, tx = S.net_bytes()
            if self._net:
                dt = max(1e-3, mono - self._net[0])
                self.net = (max(0.0, (rx - self._net[1]) / dt),
                            max(0.0, (tx - self._net[2]) / dt))
            self._net = (mono, rx, tx)
        if self._due("batt", now, force or S.battery_changed()):
            self.batt = S.battery_fast()
        if self._due("ps", now, force):
            self.procs = S.process_table()
            self.ps_at = now

    def ps_now(self):
        """Run ps out of phase (a session just started), at most once per
        PS_MIN_S. True if the table was refreshed."""
        now = time.time()
        if now - self.ps_at < self.PS_MIN_S:
            return False
        self.procs = S.process_table()
        self.ps_at = self.last["ps"] = now
        return True

    def block(self):
        used, total, wired, active, comp, cached = self.mem or (0, 0, 0, 0, 0, 0)
        g = self.gpu
        procs = self.procs
        name = lambda c: os.path.basename(c) or c
        return {
            "cpu": round(self.cpu, 1), "user": round(self.user, 1), "sys": round(self.sys, 1),
            "cores": [round(x, 1) for x in self.cores],
            "load": [round(x, 2) for x in os.getloadavg()],
            "gpu": g[0] if g else None,
            "gpu_detail": ({"renderer": g[1], "tiler": g[2], "vram_used": g[3],
                            "vram_alloc": g[4]} if g else None),
            "mem": {"total": total, "used": used, "app": self.app, "wired": wired, "active": active,
                    "compressed": comp, "cached": cached, "free": self.free,
                    "pressure": self.pressure},
            "swap": int(self.swap),
            "net": {"rx_bps": round(self.net[0]), "tx_bps": round(self.net[1])},
            "disk": {"free": self.disk[0], "total": self.disk[1],
                     "read_bps": round(self.dio[0]), "write_bps": round(self.dio[1])},
            "batt": self.batt,
            "top_cpu": [[name(p[5]), p[3]] for p in sorted(procs, key=lambda p: -p[3])[:5]],
            "top_mem": [[name(p[5]), p[4]] for p in sorted(procs, key=lambda p: -p[4])[:5]],
        }


# ── the feed ─────────────────────────────────────────────────────────────────

class Weather:
    """Real local weather from Open-Meteo (free, no key; only lat/lon is sent).

    Fetched just after each quarter hour (see AFTER_Q) on a daemon thread, so a tick never waits on
    the network; cached in ~/.claude/cache/kiln-weather.json so --once and a
    fresh --stream start with the last reading. Served while under 2 h old,
    else null (offline). There is no default place: with KILN_LAT and KILN_LON
    unset the block is null and nothing is fetched or cached. KILN_PLACE labels
    it. A cached reading for other coordinates is ignored."""
    PATH = os.path.join(CACHE, "kiln-weather.json")
    EVERY, MAX_AGE = 900.0, 7200.0
    # WMO weather codes -> one coarse kind a scene can draw.
    KIND = {0: "clear", 1: "clear", 2: "partly", 3: "cloudy", 45: "fog", 48: "fog",
            51: "drizzle", 53: "drizzle", 55: "drizzle", 56: "drizzle", 57: "drizzle",
            61: "rain", 63: "rain", 65: "rain", 66: "rain", 67: "rain",
            71: "snow", 73: "snow", 75: "snow", 77: "snow",
            80: "rain", 81: "rain", 82: "rain", 85: "snow", 86: "snow",
            95: "storm", 96: "storm", 99: "storm"}
    TEXT = {0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog",
            48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
            56: "freezing drizzle", 57: "freezing drizzle", 61: "light rain", 63: "rain",
            65: "heavy rain", 66: "freezing rain", 67: "freezing rain", 71: "light snow",
            73: "snow", 75: "heavy snow", 77: "snow grains", 80: "showers", 81: "showers",
            82: "violent showers", 85: "snow showers", 86: "snow showers",
            95: "thunderstorm", 96: "thunderstorm, hail", 99: "thunderstorm, hail"}

    def __init__(self):
        self.data, self.busy, self.tried = None, False, 0.0
        try:
            self.lat = float(os.environ["KILN_LAT"])
            self.lon = float(os.environ["KILN_LON"])
        except (KeyError, ValueError):
            self.lat = self.lon = None      # weather off: no default location
            return
        self.place = os.environ.get("KILN_PLACE") or "%.2f, %.2f" % (self.lat, self.lon)
        try:
            with open(self.PATH) as fh:
                d = json.load(fh)
            # only a reading taken for these coordinates (another place's would leak)
            if (isinstance(d, dict) and d.get("lat") is not None and d.get("lon") is not None
                    and abs(d["lat"] - self.lat) < 0.01 and abs(d["lon"] - self.lon) < 0.01):
                self.data = dict(d, place=self.place)
        except (OSError, ValueError, TypeError):
            pass

    def _fetch(self):
        import urllib.request
        url = ("https://api.open-meteo.com/v1/forecast?latitude=%.3f&longitude=%.3f"
               "&current=temperature_2m,apparent_temperature,weather_code,cloud_cover,"
               "precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m,"
               "relative_humidity_2m,is_day&daily=sunrise,sunset&timezone=auto"
               "&forecast_days=1" % (self.lat, self.lon))
        try:
            with urllib.request.urlopen(url, timeout=8) as r:
                raw = json.load(r)
            cur, day = raw["current"], raw.get("daily") or {}
            off = raw.get("utc_offset_seconds", 0)

            def ep(s):  # local ISO "2026-11-04T07:10" -> epoch
                d = datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M")
                return calendar.timegm(d.timetuple()) - off
            code = int(cur.get("weather_code") or 0)
            self.data = {
                "place": self.place, "lat": self.lat, "lon": self.lon,
                "fetched_at": round(time.time()),
                "observed_at": ep(cur["time"]),
                "temp_c": cur.get("temperature_2m"), "feels_c": cur.get("apparent_temperature"),
                "code": code, "kind": self.KIND.get(code, "cloudy"),
                "text": self.TEXT.get(code, "unknown"),
                "cloud": cur.get("cloud_cover"), "humidity": cur.get("relative_humidity_2m"),
                "precip_mm": cur.get("precipitation"), "rain_mm": cur.get("rain"),
                "snow_cm": cur.get("snowfall"),
                "wind_kmh": cur.get("wind_speed_10m"), "wind_dir": cur.get("wind_direction_10m"),
                "is_day": bool(cur.get("is_day")),
                "sunrise": ep(day["sunrise"][0]) if day.get("sunrise") else None,
                "sunset": ep(day["sunset"][0]) if day.get("sunset") else None,
            }
            tmp = self.PATH + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(self.data, fh)
            os.replace(tmp, self.PATH)
        except Exception:  # offline, DNS, schema change: keep the last reading
            pass
        finally:
            self.busy = False

    # Open-Meteo's "current" block is 15-minute data labelled with the quarter
    # hour it starts ("16:00" until 16:15), available as the quarter begins
    # (checked 2026-11-05 16:09: time "16:00"). A fetch every 15 min from
    # whenever the feed started could land at :14 and serve the :00 reading
    # until :29 (audit: a reading ~29 min old). So fetch AFTER_Q after each
    # quarter; if the reply is still the previous quarter, retry every RETRY s
    # (at most TRIES times a quarter). A failure (offline) backs off FAIL_S.
    AFTER_Q, RETRY, TRIES, FAIL_S = 45.0, 60.0, 5, 120.0

    def _due(self, now):
        if self.busy:
            return False
        d = self.data
        if not d:
            return now - self.tried > self.FAIL_S
        q = now - now % 900                       # this quarter hour (epoch)
        if (d.get("observed_at") or 0) >= q:
            return False                          # already this quarter's reading
        if now - d.get("fetched_at", 0) > self.EVERY + self.AFTER_Q:
            return now - self.tried > self.FAIL_S   # backstop: a quarter missed
        if now < q + self.AFTER_Q:
            return False
        if getattr(self, "q_of", None) != q:
            self.q_of, self.q_tries = q, 0
        if self.q_tries >= self.TRIES:
            return False
        if now - self.tried < (self.RETRY if self.q_tries else 0):
            return False
        self.q_tries += 1
        return True

    def get(self, now, wait=False):
        if self.lat is None:
            return None
        if self._due(now):
            self.busy, self.tried = True, now
            if wait:
                self._fetch()
            else:
                threading.Thread(target=self._fetch, daemon=True).start()
        if self.data and now - self.data.get("fetched_at", 0) < self.MAX_AGE:
            return self.data
        return None


class GitHub:
    """The token owner's contribution calendar plus their latest public/private activity.
    Off (null) with KILN_GITHUB=0, or when no token can be found.

    Two cheap polls on a daemon thread, never on a tick:
    - events: REST /users/<login>/events with If-None-Match every 60 s (or the
      X-Poll-Interval GitHub asks for). A 304 costs no rate limit. A new event
      id makes the calendar due at once, so a push shows up within a minute
      of GitHub listing it.
    - calendar: GraphQL contributionCalendar every 5 min regardless (1 point
      of the 5000/h budget), because commits pushed by others' merges and
      private contributions do not always surface as events.
    The token comes from `gh auth token` once and stays in memory only; the
    cache (~/.claude/cache/kiln-github.json) holds counts, never the token.
    Served while under 6 h old, else null."""
    PATH = os.path.join(CACHE, "kiln-github.json")
    CAL_EVERY, EV_EVERY, MAX_AGE = 300.0, 60.0, 21600.0
    Q = ("query{viewer{login contributionsCollection{contributionCalendar{"
         "totalContributions weeks{contributionDays{date contributionCount}}} "
         "totalCommitContributions totalPullRequestContributions totalIssueContributions "
         "commitContributionsByRepository(maxRepositories:25){repository{nameWithOwner "
         "primaryLanguage{name}} contributions{totalCount}}}}}")

    def __init__(self):
        self.token, self.etag, self.ev_every = None, None, self.EV_EVERY
        self.busy, self.cal_at, self.ev_at, self.tried = False, 0.0, 0.0, 0.0
        self.data = None
        try:
            with open(self.PATH) as fh:
                self.data = json.load(fh)
        except (OSError, ValueError):
            pass

    def _gh_token(self):
        tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if tok:
            return tok.strip()
        import shutil
        cands = (os.environ.get("KILN_GH"), shutil.which("gh"),
                 "/opt/homebrew/bin/gh", "/usr/local/bin/gh")
        for gh in cands:
            if gh and os.path.exists(gh):
                try:
                    import subprocess
                    out = subprocess.run([gh, "auth", "token"], capture_output=True,
                                         text=True, timeout=8)
                    tok = out.stdout.strip()
                    return tok or None
                except (OSError, subprocess.SubprocessError):
                    return None
        return None

    def _req(self, url, body=None, etag=None):
        import urllib.request
        import urllib.error
        if not self.token:
            self.token = self._gh_token()
            if not self.token:
                return None, None, {}
        h = {"Authorization": "bearer " + self.token, "User-Agent": "kiln-feed",
             "Accept": "application/vnd.github+json"}
        if etag:
            h["If-None-Match"] = etag
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                return r.status, json.load(r), dict(r.headers)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                self.token = None          # re-read gh's token next time
            return e.code, None, dict(e.headers or {})

    @staticmethod
    def _event(e):
        t, repo, p = e.get("type", ""), (e.get("repo") or {}).get("name", ""), e.get("payload") or {}
        short = repo.split("/", 1)[-1]
        if t == "PushEvent":
            n = p.get("size") or len(p.get("commits") or []) or 1
            br = (p.get("ref") or "").rsplit("/", 1)[-1]
            text = "pushed %d commit%s to %s%s" % (n, "" if n == 1 else "s", short,
                                                     (" " + br) if br else "")
        elif t == "PullRequestEvent":
            pr = p.get("pull_request") or {}
            act = "merged" if p.get("action") == "closed" and pr.get("merged") else p.get("action", "")
            text = "%s PR #%s in %s" % (act, p.get("number") or pr.get("number", "?"), short)
        elif t == "IssuesEvent":
            text = "%s issue #%s in %s" % (p.get("action", ""), (p.get("issue") or {}).get("number", "?"), short)
        elif t == "CreateEvent":
            text = "created %s %s in %s" % (p.get("ref_type", ""), p.get("ref") or "", short)
        elif t == "PullRequestReviewEvent":
            text = "reviewed a PR in %s" % short
        elif t == "IssueCommentEvent":
            text = "commented in %s" % short
        elif t == "WatchEvent":
            text = "starred %s" % repo
        else:
            text = "%s in %s" % (t.replace("Event", "").lower(), short)
        return {"type": t, "repo": repo, "at": iso_t(e.get("created_at")), "text": text}

    def _calendar(self, now):
        st, js, _ = self._req("https://api.github.com/graphql", {"query": self.Q})
        if st != 200 or not js or "data" not in js:
            return False
        v = js["data"]["viewer"]
        cc = v["contributionsCollection"]
        cal = cc["contributionCalendar"]
        repos = [[r["repository"]["nameWithOwner"], r["contributions"]["totalCount"],
                  (r["repository"].get("primaryLanguage") or {}).get("name")]
                 for r in cc.get("commitContributionsByRepository") or []]
        days = [[d["date"], d["contributionCount"]] for w in cal["weeks"]
                for d in w["contributionDays"]]
        streak, i = 0, len(days) - 1
        if i >= 0 and days[i][1] == 0:
            i -= 1                          # today not started yet: count to yesterday
        while i >= 0 and days[i][1] > 0:
            streak, i = streak + 1, i - 1
        best = max(days, key=lambda d: d[1]) if days else None
        d = dict(self.data or {})
        d.update({"login": v["login"], "fetched_at": round(now), "total_year": cal["totalContributions"],
                  "days": days, "today": days[-1][1] if days else 0,
                  "week": sum(c for _, c in days[-7:]), "streak": streak, "best": best,
                  # this year's commits per repo, top 25: [name, commits, language]
                  "repos": repos, "commits_year": cc.get("totalCommitContributions"),
                  "prs_year": cc.get("totalPullRequestContributions"),
                  "issues_year": cc.get("totalIssueContributions")})
        self.data = d
        return True

    def _events(self, now):
        login = (self.data or {}).get("login")
        if not login:
            return False
        st, js, hd = self._req("https://api.github.com/users/%s/events?per_page=10" % login,
                               etag=self.etag)
        try:
            self.ev_every = max(self.EV_EVERY, float(hd.get("X-Poll-Interval") or 0))
        except ValueError:
            pass
        if st == 304 or st != 200 or not isinstance(js, list):
            return False
        self.etag = hd.get("ETag") or hd.get("Etag")
        # GitHub's list is not strictly newest-first across event types.
        ev = sorted((self._event(e) for e in js), key=lambda e: -(e["at"] or 0))[:5]
        newest = max((e.get("id") or "" for e in js), key=lambda i: int(i) if i.isdigit() else 0,
                     default=None)
        changed = newest != (self.data or {}).get("event_id")
        d = dict(self.data or {})
        d.update({"recent": ev, "latest": ev[0] if ev else None, "event_id": newest})
        self.data = d
        return changed

    def _poll(self, now):
        try:
            got = False
            if not (self.data or {}).get("login") or now - self.cal_at >= self.CAL_EVERY:
                got = self._calendar(now)
                self.cal_at = now
            if now - self.ev_at >= self.ev_every:
                self.ev_at = now
                if self._events(now) and not got:
                    self._calendar(now)         # a new event: refresh the squares now
                    self.cal_at = now
            if self.data:
                tmp = self.PATH + ".tmp"
                with open(tmp, "w") as fh:
                    json.dump(self.data, fh)
                os.replace(tmp, self.PATH)
        except Exception:  # offline, schema change: keep the last reading
            pass
        finally:
            self.busy = False

    def get(self, now, wait=False):
        if os.environ.get("KILN_GITHUB") == "0":
            return None
        due = (now - self.cal_at >= self.CAL_EVERY) or (now - self.ev_at >= self.ev_every)
        if due and not self.busy and now - self.tried > 20:
            self.busy, self.tried = True, now
            if wait:
                self._poll(now)
            else:
                threading.Thread(target=self._poll, args=(now,), daemon=True).start()
        if self.data and now - self.data.get("fetched_at", 0) < self.MAX_AGE:
            return {k: v for k, v in self.data.items() if k != "event_id"}
        return None


class Feed:
    def __init__(self):
        self.t0 = time.time()
        self.sys = Sys()
        self.ledger = Ledger()
        self.chime = Chime()
        self.agents = Agents()
        self.hist = History()
        self.weather = Weather()
        self.github = GitHub()
        self.sj = {}               # sessions json path -> (mtime, parsed)
        self.mains = {}            # sid -> transcript path ("" = not found yet)
        self.miss = {}             # sid -> last failed lookup
        self.names = {}
        self.last = {}
        self.cache = {}
        self.asks = {}             # sid -> (key, ask) while waiting
        self.locks = {}            # sid -> the ask-chime lock while waiting
        self.thread = None

    # -- live sessions -------------------------------------------------------

    def _main_path(self, sid, now):
        p = self.mains.get(sid)
        if p and os.path.exists(p):
            return p
        if now - self.miss.get(sid, 0) < 30:
            return None
        hits = glob.glob(os.path.join(PROJ, "*", sid + ".jsonl"))
        if hits:
            self.mains[sid] = hits[0]
            return hits[0]
        self.miss[sid] = now
        return None

    def _live(self, now, again=True):
        """[(json, ps_row)] for live sessions; see A LIVE MAIN SESSION.

        ps runs every 5 s, so on its own a new session appeared 1.4-4.8 s
        late and an ended one lingered up to 5.5 s (audit, 2026-11-05). Now
        a sessions json naming a LIVE pid that ps has not listed runs ps at
        once (at most once a second), and a listed pid that has died is
        dropped now: kill(pid, 0) per session per tick costs nothing."""
        ptab = {p[0]: p for p in self.sys.procs}
        seen = set()
        live, other = [], 0
        unlisted = False
        for path in glob.glob(os.path.join(SESS, "*.json")):
            seen.add(path)
            try:
                mt = os.stat(path).st_mtime
            except OSError:
                continue
            c = self.sj.get(path)
            if c is None or c[0] != mt:
                try:
                    with open(path) as f:
                        c = (mt, json.load(f))
                except (OSError, ValueError):
                    continue
                self.sj[path] = c
            d = c[1]
            pid = d.get("pid")
            row = ptab.get(pid)
            if not row:
                if alive(pid):
                    unlisted = True                       # started since the last ps
                continue
            if "claude" not in row[5] or not alive(pid):
                continue
            started = (d.get("startedAt") or 0) / 1000.0
            if started and (self.sys.ps_at - row[2]) > started + 120:
                continue                                  # a recycled pid
            if d.get("kind") not in ("interactive", "bg"):
                other += 1
                continue
            live.append((d, row))
        for p in [p for p in self.sj if p not in seen]:
            del self.sj[p]
        if unlisted and again and self.sys.ps_now():
            return self._live(now, again=False)
        return live, other

    SHELLS = ("zsh", "bash", "fish", "sh", "login", "tmux")

    def _attached(self, pid, ptab):
        """True if a daemon-hosted ("bg") session is open in a terminal. A plain
        `claude` typed in a shell hands its session to the daemon. The daemon starts
        a bg-pty-host that runs the session, and the shell's `claude` stays as the
        terminal client. The two start in the same second (measured 2026-11-05:
        a session's pid 82193 under host 82179; client 82145
        under -zsh, all 01-00:39:05). ps gives no argv here, so `claude attach`
        clients started later are not matched."""
        row = ptab.get(pid)
        host = ptab.get(row[1]) if row else None
        if not host or "claude" not in host[5]:
            return False
        for p in self.sys.procs:
            if p[0] in (pid, host[0]) or "claude" not in p[5]:
                continue
            parent = ptab.get(p[1])
            if not parent or os.path.basename(parent[5]).lstrip("-") not in self.SHELLS:
                continue
            if abs(p[2] - host[2]) <= 3:
                return True
        return False

    def sessions(self, now):
        live, other = self._live(now)
        ptab = {p[0]: p for p in self.sys.procs}
        kids = {}
        for p in self.sys.procs:
            kids.setdefault(p[1], []).append(p)
        # A "bg" process with no transcript is the daemon's pre-warmed spare,
        # not a session yet (it showed up as an unnamed "96585099" on 2026-11-05).
        keep = []
        for d, row in live:
            sid = d.get("sessionId") or ""
            nm = d.get("name")
            if d.get("kind") == "bg" and (not nm or nm == sid[:8]) and not self._main_path(sid, now):
                continue
            keep.append((d, row))
        live = keep
        pairs = []
        for d, row in live:
            sid = d.get("sessionId") or ""
            if d.get("name"):
                self.names[sid] = d["name"]
            pairs.append((sid, self._main_path(sid, now)))
        self.ledger.live = pairs
        self.agents.poll(pairs, now)
        pending = {}
        for sid, ls in self.chime.last_stop.items():
            pending[sid] = set(ls.get("pending") or ())
        live_sids = {sid for sid, _ in pairs}
        running = self.agents.running(live_sids, pending, now)
        per = {}
        for a in running:
            per[a["sid"]] = per.get(a["sid"], 0) + 1
        out = []
        for (d, row), (sid, mp) in zip(live, pairs):
            pid, cpu, rss = row[0], row[3], row[4]
            rec = self.ledger.main_rec(mp) if mp else None
            try:
                mt = os.stat(mp).st_mtime if mp else 0
            except OSError:
                mt = 0
            state, since, open_ = self._state(sid, pid, cpu, rec, mt, per.get(sid, 0),
                                              kids, now)
            model = rec.get("model") if rec else None
            ctx = rec.get("ctx") if rec else None
            win = 200000 if model and "haiku" in model else CTX_WINDOW
            started = (d.get("startedAt") or 0) / 1000.0
            out.append({
                "sid": sid, "name": d.get("name") or sid[:8], "cwd": d.get("cwd") or "",
                # kind: "interactive" = open in a terminal (including a bg-hosted
                # session whose terminal client is attached); "bg" = no window.
                "pid": pid,
                "kind": "interactive" if d.get("kind") == "bg" and self._attached(pid, ptab)
                        else d.get("kind"),
                "hosted": d.get("kind"),
                "up_s": int(now - started) if started else None,
                "cpu": cpu, "rss": rss, "state": state,
                "since": round(since, 1) if since else None,
                "agents_running": per.get(sid, 0), "model": model,
                "ctx_tokens": ctx, "ctx_window": win if ctx is not None else None,
                "ctx_pct": round(100.0 * ctx / win, 1) if ctx is not None else None,
                "out_15m": self.ledger.out_since(sid, now - 900),
                "out_per_min": self.ledger.sid_series(sid, now),
                "ask": self._ask(sid, mp) if state == "waiting" and mp else None,
                "turn_open": open_,
                "last_activity": round(rec.get("ta"), 1) if rec and rec.get("ta") else None,
                "cc_status": d.get("status"),
            })
        out.sort(key=lambda s: s["up_s"] if s["up_s"] is not None else 1e12)
        agents = [{"id": a["id"], "type": a["type"], "sid": a["sid"],
                   "session": self.names.get(a["sid"], a["sid"][:8]), "desc": a["desc"],
                   "started": round(a["start"], 1), "age_s": int(now - a["start"]),
                   "idle_s": int(now - a["last"])} for a in running]
        return out, other, agents

    @staticmethod
    def _describe(u):
        """A tool_use block -> the ask's {kind, tool, text[, n]}."""
        inp = u.get("input") or {}
        if u.get("name") == "AskUserQuestion":
            qs = inp.get("questions") or [{}]
            text = (qs[0] or {}).get("question") or ""
            found = {"kind": "question", "tool": "AskUserQuestion", "text": text,
                     "n": len(qs)}
        else:
            text = (inp.get("description") or inp.get("command") or inp.get("file_path")
                    or inp.get("url") or inp.get("prompt") or "")
            found = {"kind": "permission", "tool": u.get("name") or "?", "text": str(text)}
        found["text"] = " ".join(found["text"].split())[:400]
        return found

    @classmethod
    def _find_use(cls, path, tid):
        """The ask described from one transcript's last 512 KB: the tool_use
        whose id is `tid`, or (tid None) the newest main-thread tool_use."""
        try:
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - (512 << 10)))
                data = f.read()
        except OSError:
            return None
        key = tid.encode() if tid else None
        for ln in reversed(data.split(b"\n")):
            if b'"tool_use"' not in ln or b'"type":"assistant"' not in ln[:400]:
                continue
            if key and key not in ln:
                continue
            try:
                d = json.loads(ln)
            except ValueError:
                continue
            if not key and d.get("isSidechain"):
                continue
            uses = [x for x in (d.get("message") or {}).get("content") or ()
                    if isinstance(x, dict) and x.get("type") == "tool_use"
                    and (not tid or x.get("id") == tid)]
            if uses:
                return cls._describe(uses[-1])
        return None

    def _ask(self, sid, mp):
        """What a waiting session is asking, read only while it waits.

        Until 2026-11-05 this read only the main transcript, so a SUBAGENT's
        permission dialog (its tool_use is in subagents/agent-<id>.jsonl) came
        out as null, or as the main thread's own last tool. The lock that
        ask-chime.py holds carries the dialog's tool_use id and its chime.jsonl
        line names the transcript ("agent", "in"), so look there first, then
        the main transcript, then subagent transcripts written in the last
        10 min. A found tool_use never changes: cached by id. Not found yet:
        retried at most once a second while sizes move."""
        held = self.locks.get(sid) or {}
        tid = held.get("id") if isinstance(held.get("id"), str) else None
        since = held.get("since")
        src = self.chime.ask_src.get(tid) if tid else None
        sub = os.path.join(mp[:-6], "subagents")
        cands = []
        if src and src[1]:
            cands.append(mp if src[1] == os.path.basename(mp) else os.path.join(sub, src[1]))
        if mp not in cands:
            cands.append(mp)
        c = self.asks.get(sid)
        now = time.monotonic()
        first = now
        if c and c[0][0] == tid and c[0][1] == (src or None):
            if c[1] is not None and (tid or c[0][2] == self._size(mp)):
                return self._ask_out(c[1], since)
            # not found: retry each second for 15 s, then every 15 s
            first = c[0][4]
            if tid and now - c[0][3] < (1.0 if now - first < 15 else 15.0):
                return self._ask_out(c[1], since, tid, src)
        found = None
        if tid:
            for p in cands:
                found = self._find_use(p, tid)
                if found:
                    found["_in"] = p
                    break
            if not found:
                try:
                    recent = sorted(((os.stat(os.path.join(sub, n)).st_mtime, n)
                                     for n in os.listdir(sub) if n.endswith(".jsonl")),
                                    reverse=True)
                except OSError:
                    recent = []
                wall = time.time()
                for mt, n in recent[:12]:
                    p = os.path.join(sub, n)
                    if wall - mt > 600 or p in cands:
                        continue
                    found = self._find_use(p, tid)
                    if found:
                        found["_in"] = p
                        break
        else:
            found = self._find_use(mp, None)
        if len(self.asks) > 32:
            self.asks.clear()
        self.asks[sid] = ((tid, src or None, self._size(mp), now, first), found)
        return self._ask_out(found, since, tid, src)

    @staticmethod
    def _size(p):
        try:
            return os.path.getsize(p)
        except OSError:
            return -1

    def _ask_out(self, found, since, tid=None, src=None):
        if found is None:
            if not tid:
                return None
            # The lock names a dialog whose tool_use is not on disk (yet):
            # still an ask, with what chime.jsonl knows.
            found = {"kind": "permission", "tool": (src or (None, None, None))[2] or "?",
                     "text": "", "_in": None}
            if src and src[0]:
                found["_agent"] = src[0]
        out = {k: v for k, v in found.items() if not k.startswith("_")}
        p = found.get("_in") or ""
        b = os.path.basename(p)
        aid = found.get("_agent") or (b[6:-6] if b.startswith("agent-") and b.endswith(".jsonl")
                                      else None)
        out["since"] = round(since, 1) if isinstance(since, (int, float)) else None
        out["agent"] = aid
        a = self.agents.a.get(aid) if aid else None
        out["agent_type"] = a["type"] if a else None
        return out

    def _state(self, sid, pid, cpu, rec, mt, nagents, kids, now):
        lock = os.path.join(CACHE, "ask-chime-%s.json" % sid)
        self.locks.pop(sid, None)
        if os.path.exists(lock):
            try:
                with open(lock) as f:
                    held = json.load(f)
                if isinstance(held, dict) and alive(held.get("pid")):
                    self.locks[sid] = held
                    return "waiting", held.get("since") or now, True
            except (OSError, ValueError):
                pass
        rec = rec or {}
        ta, te, tt = rec.get("ta", 0), rec.get("te", 0), rec.get("tt", 0)
        ls = self.chime.last_stop.get(sid)
        if ls:
            te = max(te, ls["ts"])
        open_ = ta > te + 0.5 if rec else (now - mt < 20)
        if ls and ls["verdict"] == "fail-chime" and ta <= ls["ts"] + 5:
            return "failed", ls["ts"], False
        if open_:
            busy_kid = False
            for k in kids.get(pid, ()):
                if k[3] >= 5 or any(g[3] >= 5 for g in kids.get(k[0], ())):
                    busy_kid = True
                    break
            # CPU counts only for a turn with an entry in the last 6 h: a session whose
            # turn was cut off a day ago reads as "working for 1 d" the moment its process
            # is respawned and burns start-up CPU (seen 2026-11-05).
            recent = now - max(ta, mt) < 6 * 3600
            if now - max(ta, mt) < 600 or (recent and (cpu >= 5 or busy_kid)):
                return "working", tt or ta or mt, True
            return "idle", ta, True
        pend_other = bool(ls and ls["verdict"] == "silent" and now - ls["ts"] < 900
                          and any(not AGENT_ID.fullmatch(x) for x in ls["pending"]))
        if nagents or pend_other:
            return "background", te or None, False
        return "idle", te or ta or None, False

    # -- limits ---------------------------------------------------------------

    def limits(self, now):
        L = S.rate_limits(RL_DIR, now)
        self.hist.observe(L, now)
        for key, W, idx in (("five_hour", W5, 1), ("seven_day", W7, 3)):
            w = L[key]
            pct, reset = w["pct"], w["resets_at"]
            w.update(pace=None, burn_per_h=None, projected=None, runout_at=None)
            if pct is None:
                continue
            if w["stale"]:
                w["pace"] = 0
                continue
            # The statusline records whole percents. Against a week, an hour
            # moves 0 or 1 of them, so a 60-min rate read 0.0 %/h while the
            # pace was 3x (2026-11-06). The week's burn looks back 6 h (needs
            # 1 h of readings); the 5-hour window keeps its last hour.
            rate, _span = (self.hist.burn(idx, reset, pct, now) if key == "five_hour"
                           else self.hist.burn(idx, reset, pct, now, look=6 * 3600, min_span=3600))
            if rate is not None:
                w["burn_per_h"] = round(rate * 3600, 2)
            if pct >= 100:
                w["runout_at"] = int(now)
            # Too early in a window, every ratio is noise: 40 min into a new
            # week, 2% read as pace 200 and "479% at reset" (2026-11-04).
            # No forecast until 30 min of the 5 h window / 12 h of the week.
            elapsed = W - (reset - now)
            if elapsed < (1800 if key == "five_hour" else 43200):
                continue
            w["pace"] = round(pct / min(1.0, elapsed / W) )
            if key == "five_hour":
                # Short window: the last hour's burn is the right predictor.
                if rate is None:
                    continue
                per_s = rate
            else:
                # The week includes nights and days off, so extrapolating the
                # last hour across days is wrong; use the window's own average.
                per_s = pct / elapsed
            w["projected"] = round(pct + per_s * max(0, reset - now), 1)
            if pct < 100 and per_s > 0:
                tr = now + (100 - pct) / per_s
                w["runout_at"] = int(tr) if tr < reset else None
        L["history"] = self.hist.series(now)
        # Every recorded weekly reading of the CURRENT week as [t, pct], plus
        # the previous week's last reading as [t, pct, "prev"]: rows are written
        # only on change, so a whole week is ~100 points. History starts when
        # kiln-feed first ran (2026-11-04 18:27); earlier weeks are not known.
        wr = L["seven_day"].get("resets_at")
        pts, prev = [], None
        for r in self.hist.clean:
            if r[3] is None:
                continue
            if r[4] == wr:
                pts.append([r[0], r[3]])
            elif r[4] and wr and r[4] <= wr - 6 * 86400:
                prev = [r[0], r[3], "prev"]
        L["week_points"] = ([prev] if prev else []) + pts
        return L

    # -- events ---------------------------------------------------------------

    def events(self):
        # Newest by TIME from each source. Agents.events is in scan order (session by
        # session on the first pass), so its tail by position held another session's
        # 20:42 events and none of this evening's 86 (measured 2026-11-05).
        by_t = lambda e: e["t"]
        ev = sorted(self.chime.events, key=by_t)[-60:] + sorted(self.agents.events, key=by_t)[-60:]
        ev.sort(key=by_t)
        out = []
        for e in ev[-40:]:
            sid = e.get("sid") or ""
            nm = self.names.get(sid) or self.ledger.st["names"].get(sid)
            if not nm:
                nm = proj(self.chime.cwd.get(sid, "")) if sid in self.chime.cwd else sid[:8]
            o = {"t": round(e["t"], 1), "kind": e["kind"], "sid": sid, "name": nm,
                 "detail": e.get("detail") or ""}
            if e.get("id"):
                o["id"] = e["id"]
            if e.get("n", 1) > 1:
                o["n"] = e["n"]      # turns coalesced into this "done"
            out.append(o)
        return out

    # -- assembly -------------------------------------------------------------

    def _every(self, name, period, now):
        if now - self.last.get(name, -1e18) >= period:
            self.last[name] = now
            return True
        return False

    def snapshot(self, force=False):
        c0 = time.perf_counter()
        now = time.time()
        self.sys.tick(force)
        # Every tick: poll() is one stat while the file has not grown. At 2 s
        # an ask/done event reached the page up to 1.4 s after it was logged.
        self.chime.poll()
        sess, other, agents = self.sessions(now)
        with self.ledger.lk:
            self.ledger.st["names"].update(self.names)
        if force or self._every("limits", 1.0, now) or "limits" not in self.cache:
            self.cache["limits"] = self.limits(now)
        if force or self._every("analytics", 10.0, now) or "analytics" not in self.cache:
            self.cache["analytics"] = self.ledger.analytics(now, self.chime.fails)
        ru = resource.getrusage(resource.RUSAGE_SELF)
        rc = resource.getrusage(resource.RUSAGE_CHILDREN)
        me = next((p for p in self.sys.procs if p[0] == os.getpid()), None)
        snap = {
            "v": 1, "t": round(now, 3),
            "feed": {"pid": os.getpid(), "cpu_s": round(ru.ru_utime + ru.ru_stime, 3),
                     "child_cpu_s": round(rc.ru_utime + rc.ru_stime, 3),
                     "rss": me[4] if me else None, "up_s": round(now - self.t0, 1),
                     "tick_ms": None},
            "sys": self.sys.block(),
            # --once waits for a fetch only when there is no cached reading at all.
            "weather": self.weather.get(now, wait=force and self.weather.data is None),
            "github": self.github.get(now, wait=force),
            "claude": {"limits": self.cache["limits"], "sessions": sess,
                       "sessions_other": other, "agents_running": agents,
                       "tokens": self.ledger.tokens(now), "events": self.events()},
            "analytics": self.cache["analytics"],
        }
        self._history(snap, now)
        snap["feed"]["tick_ms"] = round((time.perf_counter() - c0) * 1000, 2)
        return snap

    HIST_N = 120    # two minutes at one sample a second
    HIST_KEYS = ("t", "cpu", "gpu", "mem", "rx", "tx", "rd", "wr", "cores", "out_15m")
    HIST_PATH = os.path.join(CACHE, "kiln-hist.json")
    HIST_SAVE_S, HIST_MAX_AGE, HIST_GAP_S = 10.0, 600.0, 5.0

    def _hist_load(self, now):
        """The samples the last feed saved (see hist in the schema): kept with
        their real times, so a restart shows a gap rather than a reset."""
        try:
            with open(self.HIST_PATH) as fh:
                d = json.load(fh)
            ts = d["t"]
            if not all(isinstance(d.get(k), list) and len(d[k]) == len(ts)
                       for k in self.HIST_KEYS):
                return None
        except (OSError, ValueError, KeyError, TypeError):
            return None
        keep = [i for i, t in enumerate(ts)
                if isinstance(t, (int, float)) and now - self.HIST_MAX_AGE <= t < now]
        return {k: [d[k][i] for i in keep][-self.HIST_N:] for k in self.HIST_KEYS}

    def hist_save(self):
        h = self.cache.get("hist")
        if not h or not h["t"]:
            return
        tmp = "%s.%d.tmp" % (self.HIST_PATH, os.getpid())
        try:
            with open(tmp, "w") as fh:
                json.dump({k: h[k] for k in self.HIST_KEYS}, fh, separators=(",", ":"))
            os.replace(tmp, self.HIST_PATH)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass

    @classmethod
    def _span(cls, ts):
        """Seconds the samples really cover: steps between neighbours, a step
        longer than HIST_GAP_S (the feed was off) counting nothing."""
        return round(sum(b - a for a, b in zip(ts, ts[1:]) if 0 < b - a <= cls.HIST_GAP_S), 1)

    def _history(self, snap, now):
        """`hist`: the last two minutes of the fast machine figures at one
        sample a second, so a page that (re)loads draws full sparklines at
        once instead of growing them from nothing. Added to a line only when
        a new sample landed (about once a second); the page keeps the last.
        Persisted (hist_save) every HIST_SAVE_S and on exit: the host stops
        the feed after a long cover, and the sparklines used to restart empty."""
        if now - self.last.get("hist", 0) < 1.0:
            return
        self.last["hist"] = now
        h = self.cache.get("hist")
        if h is None:
            h = self._hist_load(now) or {k: [] for k in self.HIST_KEYS}
            self.cache["hist"] = h
            self.last["hist_save"] = now
        s = snap["sys"]
        sess = snap["claude"]["sessions"]
        row = {"t": round(now, 1), "cpu": s["cpu"], "gpu": s["gpu"], "mem": s["mem"]["used"],
               "rx": s["net"]["rx_bps"], "tx": s["net"]["tx_bps"],
               "rd": s["disk"]["read_bps"], "wr": s["disk"]["write_bps"], "cores": s["cores"],
               "out_15m": sum((x.get("out_15m") or 0) for x in sess)}
        for k, v in row.items():
            h[k].append(v)
            del h[k][:-self.HIST_N]
        h["span_s"] = self._span(h["t"])
        snap["hist"] = h
        if now - self.last.get("hist_save", 0) >= self.HIST_SAVE_S:
            self.last["hist_save"] = now
            self.hist_save()

    def start_worker(self):
        self.thread = threading.Thread(target=self.ledger.worker, daemon=True)
        self.thread.start()

    def shutdown(self):
        self.ledger.stop = True
        ch = self.ledger.child
        if ch is not None and ch.poll() is None:
            ch.terminate()                # leave nothing running
        self.hist_save()
        if self.thread:
            self.thread.join(timeout=3)
        if self.ledger.dirty and self.ledger.ready:
            self.ledger.save()


# ── modes ────────────────────────────────────────────────────────────────────

def _dump(obj, pretty):
    if pretty:
        return json.dumps(obj, indent=1)
    return json.dumps(obj, separators=(",", ":"))


def run_once(pretty):
    f = Feed()
    t0 = time.monotonic()
    f.sys.tick(force=True)
    f.ledger.load()
    f.chime.poll()
    f.sessions(time.time())               # names the live transcripts
    f.ledger.hot()
    f.ledger.sweep()
    if f.ledger.dirty:
        f.ledger.save()
    wait = 1.0 - (time.monotonic() - t0)
    if wait > 0:
        time.sleep(wait)                  # rates need a second baseline
    print(_dump(f.snapshot(force=True), pretty))


def run_analytics(pretty):
    f = Feed()
    t0 = time.monotonic()
    had = f.ledger.load()
    f.chime.poll()
    f.ledger.sweep()
    f.ledger.save()
    dt = time.monotonic() - t0
    sys.stderr.write("kiln-feed: analytics %s in %.2f s, %d files indexed, %.1f MB read\n"
                     % ("refreshed" if had else "built from scratch", dt,
                        len(f.ledger.st["files"]), f.ledger.read_bytes / 1e6))
    print(_dump(f.ledger.analytics(time.time(), f.chime.fails), pretty))


class _Stop(Exception):
    pass


PERIOD_MIN_MS, PERIOD_MAX_MS = 100, 1000
# --stream sends these only on lines where they changed (and on the first line).
STICKY = (("weather",), ("claude", "events"), ("claude", "limits"), ("claude", "tokens"))


def _period_ms(v):
    return int(min(PERIOD_MAX_MS, max(PERIOD_MIN_MS, round(float(v)))))


def run_stream(period_ms):
    """One JSON line per period. stdin, when it is a pipe, takes commands, one
    per line: `period <ms>` (clamped to 100..1000) changes the period at once,
    with no restart and no lost state. EOF on stdin ends the stream."""
    period = period_ms / 1000.0
    ppid0 = os.getppid()
    try:
        mode = os.fstat(0).st_mode
        watch = stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode) or os.isatty(0)
    except OSError:
        watch = False

    def bye(*_):
        raise _Stop()
    for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(s, bye)
    f = Feed()
    f.ledger.load()
    f.ledger.hot_s = period
    f.chime.poll()
    f.sys.tick(force=True)
    f.sessions(time.time())
    f.start_worker()
    inbuf = b""

    def command(line):
        nonlocal period
        parts = line.decode("utf-8", "replace").split()
        if len(parts) == 2 and parts[0] == "period":
            try:
                period = _period_ms(parts[1]) / 1000.0
            except ValueError:
                return
            f.ledger.hot_s = period
    # The first line waits one period: CPU and rates are differences, and a
    # line emitted milliseconds after the baseline would read as noise.
    nxt = time.monotonic()
    first = True
    last_an = last_gh = None
    sticky = {}
    try:
        while True:
            if first:
                first = False
                time.sleep(min(1.0, period))
                if os.getppid() != ppid0:
                    break
                nxt = time.monotonic()
            snap = f.snapshot()
            snap["feed"]["period_ms"] = round(period * 1000)
            # The analytics block is ~16 of a line's ~18 KB and changes at
            # most every 10 s, so --stream sends it only when it changed
            # (and on the first line). Consumers keep the last one they got.
            # The github block (371 calendar days, ~8 KB) changes at most every
            # minute; same rule.
            an = json.dumps(snap.get("analytics"), sort_keys=True, separators=(",", ":"))
            if an == last_an:
                snap.pop("analytics", None)
            last_an = an
            gh = json.dumps(snap.get("github"), sort_keys=True, separators=(",", ":"))
            if gh == last_gh:
                snap.pop("github", None)
            last_gh = gh
            # Same rule for blocks that rarely change but were resent every line:
            # measured on a 158-line capture, claude.events (5.7 KB of an 11 KB
            # line) changed 0 times, weather 0, tokens 2, limits 35. A page keeps
            # the last of each (kiln-runtime.js STICKY); the first line has all.
            for path in STICKY:
                parent = snap
                for p in path[:-1]:
                    parent = parent.get(p) or {}
                if path[-1] not in parent:
                    continue
                enc = json.dumps(parent[path[-1]], sort_keys=True, separators=(",", ":"))
                if sticky.get(path) == enc:
                    del parent[path[-1]]
                else:
                    sticky[path] = enc
            line = json.dumps(snap, separators=(",", ":")) + "\n"
            try:
                sys.stdout.write(line)
                sys.stdout.flush()
            except (BrokenPipeError, OSError):
                try:
                    os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
                except OSError:
                    pass
                break
            if os.getppid() != ppid0:
                break
            nxt += period
            now = time.monotonic()
            if nxt < now - period:
                nxt = now
            timeout = max(0.0, nxt - now)
            if watch:
                r, _, _ = select.select([0], [], [], timeout)
                if r:
                    data = os.read(0, 4096)
                    if not data:
                        break
                    inbuf += data
                    old = period
                    while b"\n" in inbuf:
                        line, inbuf = inbuf.split(b"\n", 1)
                        command(line)
                    inbuf = inbuf[-256:]
                    if period != old:
                        nxt = time.monotonic()      # next line now, at the new rate
                        continue
                    # A command arrived mid-wait: sleep out the rest of the period.
                    rest = nxt - time.monotonic()
                    if rest > 0:
                        time.sleep(rest)
            else:
                time.sleep(timeout)
            if os.getppid() != ppid0:
                break
    except _Stop:
        pass
    finally:
        try:
            f.shutdown()
        except _Stop:
            pass


def main():
    a = sys.argv[1:]
    pretty = "--pretty" in a
    if "--stream" in a:
        ms = 1000
        try:
            if "--period-ms" in a:
                ms = _period_ms(a[a.index("--period-ms") + 1])
            elif "--hz" in a:              # older callers
                ms = _period_ms(1000.0 / float(a[a.index("--hz") + 1]))
        except (ValueError, IndexError, ZeroDivisionError):
            pass
        run_stream(ms)
    elif "--analytics" in a:
        run_analytics(pretty)
    elif "--once" in a:
        run_once(pretty)
    else:
        sys.stderr.write(__doc__.split("\n\n")[0] + "\n\n" + __doc__.split("\n\n")[1] + "\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
