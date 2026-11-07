"""kiln-sample — the samplers behind kiln-top, with their measured costs.

Split out so the cost of each source is stated next to it and can be re-measured
without reading the renderer.

MEASURED 2026-08-22 on this machine, mean of five calls:

    ctypes host_statistics       CPU ticks          0.0 ms
    ctypes host_statistics64     VM stats           0.0 ms
    ctypes host_processor_info   per-core ticks     0.0 ms
    fork   ps -A -o …,comm       process table     28.3 ms
    fork   ioreg -c IOAccelerator GPU              22.6 ms
    fork   netstat -ib           network           22.2 ms
    fork   pmset -g batt         battery           16.5 ms
    fork   vm_stat               memory             3.4 ms   (REPLACED by ctypes)

That table is why the dashboard can run at 100 ms. The two numbers a person
actually watches move — CPU and memory — cost nothing, so they are sampled every
frame. Everything that needs a fork is sampled on its own slower phase, and the
phases are deliberately co-prime-ish so they rarely land on the same frame.

`powermetrics` is not used: it refuses to run without sudo. GPU utilisation
comes from IOAccelerator's PerformanceStatistics, which needs no privileges.
"""
import calendar
import ctypes
import ctypes.util
import json
import os
import re
import subprocess
import time

_libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
_HOST_CPU_LOAD_INFO = 3
_HOST_VM_INFO64 = 4
_PROCESSOR_CPU_LOAD_INFO = 2

PAGE = os.sysconf("SC_PAGE_SIZE")
NCPU = os.cpu_count() or 1


def _memsize():
    """Total RAM, read ONCE. It cannot change while the process lives, and
    forking sysctl for it every frame was the entire 3.1 ms cost of an
    otherwise free memory sample."""
    try:
        return int(subprocess.run(["/usr/sbin/sysctl", "-n", "hw.memsize"],
                                  capture_output=True, text=True,
                                  timeout=2).stdout.strip())
    except Exception:
        return 0


class _CpuTicks(ctypes.Structure):
    _fields_ = [("t", ctypes.c_uint * 4)]          # user, system, idle, nice


class _VMStat64(ctypes.Structure):
    """vm_statistics64 from <mach/vm_statistics.h>.

    THE FIELD WIDTHS ARE NOT UNIFORM and getting them wrong is silent: a first
    attempt declared every field as uint32 and read compressor_page_count as 0
    while vm_stat reported real compression. natural_t is 32-bit; the counters
    in the middle are 64-bit.
    """
    _fields_ = [
        ("free_count", ctypes.c_uint), ("active_count", ctypes.c_uint),
        ("inactive_count", ctypes.c_uint), ("wire_count", ctypes.c_uint),
        ("zero_fill_count", ctypes.c_uint64), ("reactivations", ctypes.c_uint64),
        ("pageins", ctypes.c_uint64), ("pageouts", ctypes.c_uint64),
        ("faults", ctypes.c_uint64), ("cow_faults", ctypes.c_uint64),
        ("lookups", ctypes.c_uint64), ("hits", ctypes.c_uint64),
        ("purges", ctypes.c_uint64), ("purgeable_count", ctypes.c_uint),
        ("speculative_count", ctypes.c_uint),
        ("decompressions", ctypes.c_uint64), ("compressions", ctypes.c_uint64),
        ("swapins", ctypes.c_uint64), ("swapouts", ctypes.c_uint64),
        ("compressor_page_count", ctypes.c_uint), ("throttled_count", ctypes.c_uint),
        ("external_page_count", ctypes.c_uint), ("internal_page_count", ctypes.c_uint),
        ("total_uncompressed_pages_in_compressor", ctypes.c_uint64),
    ]


def cpu_ticks():
    c = ctypes.c_uint(4)
    i = _CpuTicks()
    if _libc.host_statistics(_libc.mach_host_self(), _HOST_CPU_LOAD_INFO,
                             ctypes.byref(i), ctypes.byref(c)) != 0:
        return None
    return list(i.t)


def per_core_ticks():
    """[(user, system, idle, nice)] per core. Free, same call top uses."""
    count = ctypes.c_uint(0)
    info = ctypes.POINTER(ctypes.c_uint)()
    n = ctypes.c_uint(0)
    if _libc.host_processor_info(_libc.mach_host_self(), _PROCESSOR_CPU_LOAD_INFO,
                                 ctypes.byref(n), ctypes.byref(info),
                                 ctypes.byref(count)) != 0:
        return []
    out = [tuple(info[i * 4 + j] for j in range(4)) for i in range(n.value)]
    _libc.vm_deallocate(_libc.mach_task_self(), info,
                        ctypes.c_size_t(count.value * 4))
    return out


def vm_stats():
    c = ctypes.c_uint(ctypes.sizeof(_VMStat64) // ctypes.sizeof(ctypes.c_uint))
    i = _VMStat64()
    if _libc.host_statistics64(_libc.mach_host_self(), _HOST_VM_INFO64,
                               ctypes.byref(i), ctypes.byref(c)) != 0:
        return None
    return i


def app_memory(v=None):
    """Activity Monitor's "App Memory": anonymous pages minus purgeable ones
    (vm_stat's "Anonymous pages" - "Pages purgeable"), in bytes."""
    v = v if v is not None else vm_stats()
    if v is None:
        return 0
    return max(0, v.internal_page_count - v.purgeable_count) * PAGE


def memory(v=None):
    """Bytes: used, total, wired, active, compressed, cached(inactive+spec).

    `used` is Activity Monitor's "Memory Used": App Memory + Wired + Compressed
    (2026-11-05). It was wired + active + compressed until then, which read
    ~1.4 GB under Activity Monitor: `active` holds file-backed pages and misses
    anonymous pages sitting on the inactive queue. Checked against vm_stat:
    (Anonymous - purgeable) + wired down + occupied by compressor, to the MB."""
    global _MEMTOTAL
    if _MEMTOTAL is None:
        _MEMTOTAL = _memsize()
    total = _MEMTOTAL
    v = v if v is not None else vm_stats()
    if v is None:
        return 0, total, 0, 0, 0, 0
    wired = v.wire_count * PAGE
    active = v.active_count * PAGE
    comp = v.compressor_page_count * PAGE
    cached = (v.inactive_count + v.speculative_count) * PAGE
    # inactive and speculative are reclaimable, which is why they are shown
    # separately; `cached` overlaps App Memory (anonymous inactive pages).
    return app_memory(v) + wired + comp, total, wired, active, comp, cached


_MEMTOTAL = None

_GPU_RE = re.compile(
    r'"(Device Utilization %|Renderer Utilization %|Tiler Utilization %|'
    r'In use system memory|Alloc system memory)"=(\d+)')


def gpu():
    """(util%, renderer%, tiler%, vram_in_use, vram_alloc) or None.

    IOAccelerator's PerformanceStatistics, which needs no privileges —
    powermetrics does and refuses without sudo. One fork, ~23 ms, so this runs
    on a slow phase rather than every frame.
    """
    try:
        out = subprocess.run(["/usr/sbin/ioreg", "-r", "-d", "1", "-w", "0",
                              "-c", "IOAccelerator"], capture_output=True,
                             text=True, timeout=3).stdout
    except Exception:
        return None
    d = {}
    for k, val in _GPU_RE.findall(out):
        d.setdefault(k, int(val))
    if "Device Utilization %" not in d:
        return None
    return (d.get("Device Utilization %", 0), d.get("Renderer Utilization %", 0),
            d.get("Tiler Utilization %", 0), d.get("In use system memory", 0),
            d.get("Alloc system memory", 0))


def processes():
    """[(pid, cpu%, rss, name)] — one fork, ~28 ms, for 'where it goes'."""
    try:
        out = subprocess.run(["/bin/ps", "-A", "-o", "pid=,%cpu=,rss=,comm="],
                             capture_output=True, text=True, timeout=4).stdout
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        f = line.split(None, 3)
        if len(f) < 4:
            continue
        try:
            rows.append((int(f[0]), float(f[1]), int(f[2]) * 1024,
                         os.path.basename(f[3].strip())))
        except ValueError:
            continue
    return rows


def net_bytes():
    try:
        out = subprocess.run(["/usr/sbin/netstat", "-ib"], capture_output=True,
                             text=True, timeout=3).stdout
    except Exception:
        return 0, 0
    rx = tx = 0
    seen = set()
    for line in out.splitlines()[1:]:
        f = line.split()
        if len(f) < 11 or f[0] in seen or f[0].startswith("lo"):
            continue
        try:
            rx += int(f[6]); tx += int(f[9]); seen.add(f[0])
        except (ValueError, IndexError):
            continue
    return rx, tx


def battery():
    try:
        out = subprocess.run(["/usr/bin/pmset", "-g", "batt"],
                             capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return None, ""
    pct = None
    for tok in out.replace(";", " ").split():
        if tok.endswith("%") and tok[:-1].isdigit():
            pct = int(tok[:-1])
    low = out.lower()
    state = ("charging" if "; charging" in low
             else "AC" if "ac attached" in low else "battery")
    return pct, state


def swap_used():
    try:
        s = subprocess.run(["/usr/sbin/sysctl", "-n", "vm.swapusage"],
                           capture_output=True, text=True, timeout=2).stdout
        return float(s.split("used =")[1].split()[0].rstrip("M")) * 1024 * 1024
    except Exception:
        return 0


def disk_free(path="/"):
    try:
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize, st.f_blocks * st.f_frsize
    except Exception:
        return 0, 0


if __name__ == "__main__":
    print("re-measuring sampler costs on this machine\n")
    for label, fn in (("host_statistics CPU", cpu_ticks),
                      ("host_processor_info per-core", per_core_ticks),
                      ("host_statistics64 VM", vm_stats),
                      ("memory (incl. sysctl fork)", memory),
                      ("ioreg GPU", gpu),
                      ("ps process table", processes),
                      ("netstat", net_bytes),
                      ("pmset battery", battery)):
        fn()
        t = time.time()
        for _ in range(5):
            fn()
        print(f"  {label:32} {(time.time()-t)/5*1000:7.1f} ms")
    u, tot, w, a, c, ca = memory()
    print(f"\n  memory: used {u/2**30:.1f}G of {tot/2**30:.1f}G "
          f"(wired {w/2**30:.1f}G, active {a/2**30:.1f}G, "
          f"compressed {c/2**30:.2f}G, cached {ca/2**30:.1f}G)")
    print(f"  cores: {len(per_core_ticks())}   gpu: {gpu()}")


# ── tokens ──────────────────────────────────────────────────────────────────
# Output tokens are the only additive token figure in a transcript, but only
# when each API RESPONSE is counted once. Claude Code writes one transcript
# line per content block (thinking, text, each tool_use) and every one of those
# lines repeats the whole response's `usage`. Summing per line, as this file
# did until 2026-11-04, read 47.1M for the transcripts started that day against
# 16.1M counted once per response: 2.93x. _usage_delta() below is the one rule
# both counters use, the same one kiln-feed's ledger applies: key on
# message.id (requestId as a fallback) and add only the increase over the last
# line of that id. Input and cache counts are not additive at all — they
# restate the whole context every turn.
_tok_offset = {}      # path -> bytes already accounted for
_tok_last = {}        # path -> (message id, output tokens already counted)
_tok_buckets = {}     # epoch_minute -> output tokens


def utc_epoch(iso):
    """'2026-11-04T23:28:36.266Z' (UTC) -> epoch seconds; raises ValueError.

    calendar.timegm, never `mktime(...) - altzone if daylight`: time.daylight
    says the zone HAS a DST rule, not that DST is in effect. After the
    2026-11-01 change back to EST that idiom read every timestamp 3600 s in
    the future, so tokens/min and agent "live" dots showed the hour before."""
    return float(calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")))


def _usage_delta(d, last):
    """(new output tokens, new `last`) for one parsed transcript line.

    `last` is (id, counted) for the newest response seen in that file. A line
    repeating a counted response adds only what grew since; a line of a new
    response adds all of it. Returns (0, last, False) for a line with no usage;
    the third value says whether this line began a new response."""
    m = d.get("message") if d.get("type") == "assistant" else None
    if not isinstance(m, dict):
        return 0, last, False
    u = m.get("usage")
    if not isinstance(u, dict) or (m.get("model") or "").startswith("<"):
        return 0, last, False
    o = u.get("output_tokens") or 0
    mid = m.get("id") or d.get("requestId") or ""
    if mid and last and mid == last[0]:
        return max(0, o - last[1]), (mid, max(o, last[1])), False
    return o, (mid, o), True


def token_minutes(window_s=1800, tail=262144):
    """{epoch_minute: output_tokens} across every transcript touched recently.

    INCREMENTAL. A full scan of every recent transcript measured 188 ms, which
    is not affordable even on a slow phase. Each file's byte offset is
    remembered, so a later call reads only what was APPENDED since the last one
    — steady state is a few kilobytes and effectively free. Buckets accumulate
    across calls and are aged out of the window rather than recomputed.
    """
    import glob
    now = time.time()
    home = os.path.expanduser("~/.claude/projects")
    cutoff = int((now - window_s) // 60)
    for k in [k for k in _tok_buckets if k < cutoff]:
        del _tok_buckets[k]
    for path in glob.glob(home + "/*/*.jsonl") + glob.glob(home + "/*/*/subagents/*.jsonl"):
        try:
            st = os.stat(path)
        except OSError:
            continue
        if now - st.st_mtime > window_s:
            continue
        prev = _tok_offset.get(path)
        if prev is not None and st.st_size <= prev:
            continue                      # nothing new
        try:
            with open(path, "rb") as f:
                if prev is None:
                    # First sight: read a tail and skip its partial line. The
                    # tail GROWS until its first line is older than the window:
                    # a fixed 256 KB covered under half of a busy half hour
                    # (measured 2026-11-04: 0.45M of the 1.08M kiln-feed
                    # counted), which the 2.9x per-line overcount used to hide.
                    n = tail
                    while st.st_size > n:
                        f.seek(-n, os.SEEK_END)
                        f.readline()
                        head = f.readline()
                        i = head.find(b'"timestamp":"')
                        try:
                            t = utc_epoch(head[i + 13:i + 32].decode())
                        except (ValueError, UnicodeDecodeError):
                            t = now
                        if i >= 0 and now - t > window_s:
                            break
                        n *= 4
                    if st.st_size > n:
                        f.seek(-n, os.SEEK_END)
                        f.readline()
                    else:
                        f.seek(0)
                else:
                    f.seek(prev)
                base = f.tell()
                raw = f.read()
        except Exception:
            continue
        # Same partial-line rule as agent_index: a transcript being appended to
        # can be read mid-line, and advancing the offset past it would drop
        # that line's tokens for good.
        cut = raw.rfind(b"\n") + 1
        _tok_offset[path] = base + cut
        buckets = _tok_buckets
        last = _tok_last.get(path)
        for line in raw[:cut].split(b"\n"):
            # Parsed, never regexed: a tool result QUOTING another transcript
            # carries "output_tokens" too, and only a real assistant line counts.
            if b'"usage"' not in line or b'"type":"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            o, last, _ = _usage_delta(d, last)
            ts = d.get("timestamp") or ""
            if not (o and ts):
                continue
            try:
                t = utc_epoch(ts)
            except ValueError:
                continue
            if now - t > window_s:
                continue
            buckets[int(t // 60)] = buckets.get(int(t // 60), 0) + o
        _tok_last[path] = last
    return _tok_buckets


# ── the agent index ──────────────────────────────────────────────────────────
# Every subagent Claude Code has ever run leaves a transcript at
#   ~/.claude/projects/<encoded-cwd>/<session>/subagents/agent-<id>.jsonl
# and each one carries what the dashboard wants: `attributionAgent` is the
# agent TYPE (Explore, Plan, a custom agent's name…), `cwd` and `gitBranch` say which checkout
# it worked in, the first and last `timestamp` bound its run, and every
# assistant line carries `message.usage`.
#
# COST, measured 2026-08-22: 1,345 transcripts, 2.9 GB, 11.3 s to read them
# all. That is a background thread and a cached index, never a frame. After
# the first build each refresh reads only bytes APPENDED since last time — the
# same offset trick token_minutes uses — so steady state is a few kilobytes.
#
# OUTPUT TOKENS ARE COUNTED FROM `message.usage`, NEVER BY REGEX. A regex for
# `"output_tokens":(\d+)` over the raw bytes reports 169.9M against the true
# 80.9M, because a tool result that quotes another transcript carries the
# string too: 80 lines of a single 267-line agent log hold more than one
# occurrence. Cheap and wrong. And `usage` itself is counted once per
# RESPONSE (_usage_delta), not once per line: that 80.9M was itself ~2.9x high.
#
# Input tokens are NOT summed. Each request re-sends the conversation, so a sum
# counts the same cached prefix once per turn; the last value is the context
# the agent actually reached, which is the meaningful figure.

_AI_PATH = os.path.expanduser("~/.claude/cache/kiln-agentindex.json")
_AI_VERSION = 2          # 2: usage counted once per response (2026-11-04)
_AI_GLOB = (os.path.expanduser("~/.claude/projects/*/*/subagents/agent-*.jsonl"),
            os.path.expanduser("~/.claude/projects/*/*.jsonl"))
_ai = {"recs": {}, "loaded": False, "worker": None, "done": 0, "total": 0,
       "dirty": False, "saved": 0.0}


def _ai_parse(data, r):
    """Fold newly appended bytes of one transcript into its record."""
    import json
    for line in data.splitlines():
        if b'"timestamp"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        ts = d.get("timestamp") or ""
        if ts:
            if not r.get("t0"):
                r["t0"] = ts
            r["t1"] = ts
        if not r.get("cwd"):
            r["cwd"] = d.get("cwd") or ""
            r["branch"] = d.get("gitBranch") or ""
            r["slug"] = d.get("slug") or ""
        if d.get("attributionAgent"):
            r["type"] = d["attributionAgent"]
        if d.get("effort"):
            r["effort"] = d["effort"]
        m = d.get("message")
        if not isinstance(m, dict):
            continue
        if m.get("model") and not m["model"].startswith("<"):
            # `<synthetic>` marks a message Claude Code generated locally, with
            # no model behind it. Letting it win makes an agent look like it
            # ran on a model that does not exist.
            r["model"] = m["model"]
        u = m.get("usage")
        if isinstance(u, dict):
            # Once per response, not per line: see _usage_delta. `mid`/`mo`
            # carry the last response across reads of an appended file.
            last = (r["mid"], r["mo"]) if r.get("mid") else None
            o, last, new = _usage_delta(d, last)
            if last:
                r["mid"], r["mo"] = last
            r["out"] = r.get("out", 0) + o
            r["turns"] = r.get("turns", 0) + (1 if new else 0)
            r["ctx"] = (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                        + u.get("cache_creation_input_tokens", 0))
    return r


def _ai_refresh():
    """Bring the index up to date. Runs on a worker thread, never a frame."""
    import glob
    import json
    paths = [q for g in _AI_GLOB for q in glob.glob(g)]
    recs = _ai["recs"]
    _ai["total"] = len(paths)
    _ai["done"] = 0
    changed = 0
    for p in paths:
        _ai["done"] += 1
        try:
            st = os.stat(p)
        except OSError:
            continue
        r = recs.get(p)
        if r is not None and st.st_size == r.get("off") and st.st_mtime == r.get("mt"):
            continue
        if r is None or st.st_size < r.get("off", 0):
            r = {"off": 0}                       # new, or truncated and rewritten
        try:
            with open(p, "rb") as f:
                f.seek(r["off"])
                data = f.read()
        except OSError:
            continue
        # A transcript being appended to can be read mid-line. Stop the offset
        # at the last COMPLETE line so the partial one is re-read next time;
        # advancing past it drops that usage block for good, and the loss is
        # silent — the only symptom is a total that is quietly too low.
        cut = data.rfind(b"\n") + 1
        r["off"] += cut
        data = data[:cut]
        r["mt"] = st.st_mtime
        # Identity comes from the PATH, which is the only place it is stated:
        #   .../projects/<enc-cwd>/<session>.jsonl                  a session
        #   .../projects/<enc-cwd>/<session>/subagents/agent-*.jsonl  one agent
        parts = p.split(os.sep)
        if parts[-2] == "subagents":
            r["kind"] = "agent"
            r["sid"] = parts[-3]
        else:
            r["kind"] = "session"
            r["sid"] = parts[-1][:-6]
        _ai_parse(data, r)
        recs[p] = r
        changed += 1
    for p in [p for p in recs if p not in set(paths)]:
        del recs[p]
    _ai["loaded"] = True
    if changed:
        _ai["dirty"] = True
    now = time.time()
    if _ai["dirty"] and now - _ai["saved"] > 30:
        try:
            tmp = _AI_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"v": _AI_VERSION, "recs": recs}, f, separators=(",", ":"))
            os.replace(tmp, _AI_PATH)
            _ai["dirty"] = False
            _ai["saved"] = now
        except Exception:
            pass


def agent_index():
    """(records, status) — never blocks.

    status is ("ready", n) once the index covers every transcript, and
    ("indexing", done, total) while the first build is still running. The two
    must render differently: a zero that means "not indexed yet" and a zero
    that means "no agent ever ran" look identical otherwise, which is the same
    trap as a sparkline drawing a measured zero as a blank cell.
    """
    import json
    import threading
    if not _ai["loaded"] and _ai["worker"] is None:
        # The cache is versioned: records written before 2026-11-04 summed
        # usage per line and would carry that 2.9x forward forever, because a
        # refresh only folds in APPENDED bytes. An unversioned file is rebuilt.
        try:
            with open(_AI_PATH) as f:
                d = json.load(f)
            _ai["recs"] = d["recs"] if d.get("v") == _AI_VERSION else {}
        except Exception:
            _ai["recs"] = {}
    w = _ai["worker"]
    if w is None or not w.is_alive():
        w = threading.Thread(target=_ai_refresh, daemon=True)
        _ai["worker"] = w
        w.start()
    recs = dict(_ai["recs"])
    if _ai["loaded"]:
        return recs, ("ready", len(recs))
    return recs, ("indexing", _ai["done"], _ai["total"])


# ── added 2026-11-04 for kiln-feed ───────────────────────────────────────────
# kiln-top still calls everything above (whose token counting was corrected
# the same day; see _usage_delta). These exist because
# kiln-feed runs for hours as a wallpaper's child at 1 Hz, where a fork's CPU
# is paid by the CHILD and so never shows in the parent's own %cpu. MEASURED
# 2026-11-04, child CPU per call (getrusage RUSAGE_CHILDREN, mean of five):
#
#     ps -axo …            27.7 ms   (ps is setuid root, which is the cost)
#     ioreg IOAccelerator  19.1 ms
#     ioreg IOBlockStorage 16.0 ms
#     pmset -g batt         6.3 ms
#     netstat -ib           3.6 ms
#
# At 1 Hz the two ioreg forks alone would be ~3.5% of a core. Both read one
# registry property, so they are read through IOKit directly instead: the same
# dictionary ioreg prints, no process. ps cannot be replaced the same way:
# libproc's proc_pidinfo failed for 206 of 573 processes, including Claude
# Code's own binaries, so ps stays and runs on a slow phase.

_IOK = {}


def _iokit():
    if "ok" in _IOK:
        return _IOK if _IOK["ok"] else None
    try:
        iok = ctypes.CDLL("/System/Library/Frameworks/IOKit.framework/IOKit")
        cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    except OSError:
        _IOK["ok"] = False
        return None
    vp, u32, ul = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_ulong
    iok.IOServiceMatching.argtypes = [ctypes.c_char_p]
    iok.IOServiceMatching.restype = vp
    iok.IOServiceGetMatchingServices.argtypes = [u32, vp, ctypes.POINTER(u32)]
    iok.IOServiceGetMatchingServices.restype = ctypes.c_int
    iok.IOIteratorNext.argtypes = [u32]
    iok.IOIteratorNext.restype = u32
    iok.IOObjectRelease.argtypes = [u32]
    iok.IOObjectRelease.restype = ctypes.c_int
    iok.IORegistryEntryCreateCFProperty.argtypes = [u32, vp, vp, u32]
    iok.IORegistryEntryCreateCFProperty.restype = vp
    cf.CFStringCreateWithCString.argtypes = [vp, ctypes.c_char_p, u32]
    cf.CFStringCreateWithCString.restype = vp
    cf.CFDictionaryGetValue.argtypes = [vp, vp]
    cf.CFDictionaryGetValue.restype = vp
    cf.CFNumberGetValue.argtypes = [vp, ctypes.c_int, vp]
    cf.CFNumberGetValue.restype = ctypes.c_bool
    cf.CFGetTypeID.argtypes = [vp]
    cf.CFGetTypeID.restype = ul
    cf.CFDictionaryGetTypeID.restype = ul
    cf.CFNumberGetTypeID.restype = ul
    cf.CFRelease.argtypes = [vp]
    _IOK.update(ok=True, iok=iok, cf=cf, keys={}, svc={},
                dict_t=cf.CFDictionaryGetTypeID(), num_t=cf.CFNumberGetTypeID())
    return _IOK


def _cfstr(k):
    s = _IOK["keys"].get(k)
    if s is None:                          # a handful of constants, kept for life
        s = _IOK["cf"].CFStringCreateWithCString(None, k.encode(), 0x08000100)
        _IOK["keys"][k] = s
    return s


def _services(cls, ttl=60.0):
    """Registry entries of one class, re-enumerated every `ttl` seconds so a
    disk attached after start is eventually counted."""
    iok = _IOK["iok"]
    now = time.time()
    held = _IOK["svc"].get(cls)
    if held and now - held[0] < ttl:
        return held[1]
    if held:
        for o in held[1]:
            iok.IOObjectRelease(o)
    it = ctypes.c_uint32(0)
    found = []
    if iok.IOServiceGetMatchingServices(0, iok.IOServiceMatching(cls.encode()),
                                        ctypes.byref(it)) == 0:
        while True:
            o = iok.IOIteratorNext(it.value)
            if not o:
                break
            found.append(o)
        iok.IOObjectRelease(it.value)
    _IOK["svc"][cls] = (now, found)
    return found


def _registry_numbers(cls, prop, keys):
    """[{key: int}] for each `cls` entry, read from its dictionary `prop`."""
    if not _iokit():
        return None
    iok, cf = _IOK["iok"], _IOK["cf"]
    out = []
    for o in _services(cls):
        d = iok.IORegistryEntryCreateCFProperty(o, _cfstr(prop), None, 0)
        if not d:
            continue
        try:
            if cf.CFGetTypeID(d) != _IOK["dict_t"]:
                continue
            row = {}
            for k in keys:
                n = cf.CFDictionaryGetValue(d, _cfstr(k))
                v = ctypes.c_int64(0)
                if (n and cf.CFGetTypeID(n) == _IOK["num_t"]
                        and cf.CFNumberGetValue(n, 4, ctypes.byref(v))):   # SInt64
                    row[k] = v.value
            out.append(row)
        finally:
            cf.CFRelease(d)
    return out


_GPU_KEYS = ("Device Utilization %", "Renderer Utilization %",
             "Tiler Utilization %", "In use system memory", "Alloc system memory")


def gpu_iokit():
    """Same tuple as gpu(), from IOKit in-process: no fork, ~0.1 ms."""
    rows = _registry_numbers("IOAccelerator", "PerformanceStatistics", _GPU_KEYS)
    for d in rows or ():
        if "Device Utilization %" in d:
            return tuple(d.get(k, 0) for k in _GPU_KEYS)
    return None


def disk_io_bytes():
    """(bytes_read, bytes_written) since boot, summed over every block storage
    driver — the counters iostat reads. None when IOKit is unavailable."""
    rows = _registry_numbers("IOBlockStorageDriver", "Statistics",
                             ("Bytes (Read)", "Bytes (Write)"))
    if rows is None:
        return None
    return (sum(d.get("Bytes (Read)", 0) for d in rows),
            sum(d.get("Bytes (Write)", 0) for d in rows))


class _XswUsage(ctypes.Structure):
    _fields_ = [("total", ctypes.c_uint64), ("avail", ctypes.c_uint64),
                ("used", ctypes.c_uint64), ("pagesize", ctypes.c_uint32),
                ("encrypted", ctypes.c_int32)]


def swap_bytes():
    """Swap in use, via sysctlbyname — swap_used() without its sysctl fork."""
    x = _XswUsage()
    n = ctypes.c_size_t(ctypes.sizeof(x))
    if _libc.sysctlbyname(b"vm.swapusage", ctypes.byref(x), ctypes.byref(n),
                          None, ctypes.c_size_t(0)) != 0:
        return swap_used()
    return x.used


def mem_pressure():
    """The kernel's own memory-pressure verdict, the one Activity Monitor's
    graph colours by: 1 normal, 2 warn, 4 critical. None if unreadable."""
    x = ctypes.c_int(0)
    n = ctypes.c_size_t(ctypes.sizeof(x))
    if _libc.sysctlbyname(b"kern.memorystatus_vm_pressure_level", ctypes.byref(x),
                          ctypes.byref(n), None, ctypes.c_size_t(0)) != 0:
        return None
    return {1: "normal", 2: "warn", 4: "critical"}.get(x.value, str(x.value))


def _etime_s(s):
    """ps etime `[[dd-]hh:]mm:ss` to seconds."""
    d = 0
    if "-" in s:
        dd, s = s.split("-", 1)
        d = int(dd)
    p = [int(x) for x in s.split(":")]
    while len(p) < 3:
        p.insert(0, 0)
    return d * 86400 + p[0] * 3600 + p[1] * 60 + p[2]


def process_table():
    """[(pid, ppid, etime_s, cpu%, rss_bytes, comm)] — one ps fork, ~28 ms of
    child CPU. processes() plus parentage and age, which kiln-feed needs to
    tell a live Claude session from a recycled pid and to see its children."""
    try:
        out = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,etime=,%cpu=,rss=,comm="],
                             capture_output=True, text=True, timeout=4).stdout
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        f = line.split(None, 5)
        if len(f) < 6:
            continue
        try:
            rows.append((int(f[0]), int(f[1]), _etime_s(f[2]), float(f[3]),
                         int(f[4]) * 1024, f[5].strip()))
        except ValueError:
            continue
    return rows


_BATT_RE = re.compile(r"(\d+)%;\s*([^;]+);\s*([^\n]*)")


def battery_detail():
    """{"pct","charging","ac","mins_left","state"} or None on a Mac with no
    battery. mins_left is None while macOS has no estimate."""
    try:
        out = subprocess.run(["/usr/bin/pmset", "-g", "batt"],
                             capture_output=True, text=True, timeout=3).stdout
    except Exception:
        return None
    m = _BATT_RE.search(out)
    if not m:
        return None
    state = m.group(2).strip().lower()
    t = re.search(r"(\d+):(\d+) remaining", m.group(3))
    return {"pct": int(m.group(1)),
            "charging": state in ("charging", "finishing charge"),
            "ac": "AC Power" in out,
            "mins_left": int(t.group(1)) * 60 + int(t.group(2)) if t else None,
            "state": state}


# ── battery without a fork (2026-11-05) ──────────────────────────────────────
# pmset -g batt is a fork (6.3 ms of child CPU), so it ran every 30 s and a
# change reached the wallpaper 7-23 s late, or not at all when it reverted in
# between. pmset itself reads IOKit's power-source API; so does this, in
# process. And powerd posts the notify(3) name below on every power-source
# change, which notify_check() reads from shared memory without a syscall
# into powerd. kiln-feed checks it every tick and re-reads the battery on a
# post (plus every few seconds as a backstop).

_PSRC = {}
_PS_NOTE = b"com.apple.system.powersources"


def _psrc():
    if "ok" in _PSRC:
        return _PSRC if _PSRC["ok"] else None
    if not _iokit():
        _PSRC["ok"] = False
        return None
    iok, cf = _IOK["iok"], _IOK["cf"]
    vp, ul = ctypes.c_void_p, ctypes.c_ulong
    try:
        iok.IOPSCopyPowerSourcesInfo.argtypes = []
        iok.IOPSCopyPowerSourcesInfo.restype = vp
        iok.IOPSCopyPowerSourcesList.argtypes = [vp]
        iok.IOPSCopyPowerSourcesList.restype = vp
        iok.IOPSGetPowerSourceDescription.argtypes = [vp, vp]
        iok.IOPSGetPowerSourceDescription.restype = vp
        cf.CFArrayGetCount.argtypes = [vp]
        cf.CFArrayGetCount.restype = ctypes.c_long
        cf.CFArrayGetValueAtIndex.argtypes = [vp, ctypes.c_long]
        cf.CFArrayGetValueAtIndex.restype = vp
        cf.CFBooleanGetValue.argtypes = [vp]
        cf.CFBooleanGetValue.restype = ctypes.c_bool
        cf.CFStringGetCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
        cf.CFStringGetCString.restype = ctypes.c_bool
        cf.CFBooleanGetTypeID.restype = ul
        cf.CFStringGetTypeID.restype = ul
        _PSRC.update(ok=True, bool_t=cf.CFBooleanGetTypeID(), str_t=cf.CFStringGetTypeID(),
                     buf=ctypes.create_string_buffer(256), token=None)
    except AttributeError:
        _PSRC["ok"] = False
        return None
    tok = ctypes.c_int(0)
    try:
        if _libc.notify_register_check(_PS_NOTE, ctypes.byref(tok)) == 0:
            _PSRC["token"] = tok.value
    except AttributeError:
        pass
    return _PSRC


def _cfget(d, key):
    """One value of a CFDictionary as int / bool / str, or None."""
    cf = _IOK["cf"]
    v = cf.CFDictionaryGetValue(d, _cfstr(key))
    if not v:
        return None
    t = cf.CFGetTypeID(v)
    if t == _IOK["num_t"]:
        n = ctypes.c_int64(0)
        return n.value if cf.CFNumberGetValue(v, 4, ctypes.byref(n)) else None
    if t == _PSRC["bool_t"]:
        return bool(cf.CFBooleanGetValue(v))
    if t == _PSRC["str_t"]:
        b = _PSRC["buf"]
        return b.value.decode("utf-8", "replace") if cf.CFStringGetCString(v, b, 256, 0x08000100) else None
    return None


def battery_changed():
    """True if powerd posted a power-source change since the last call (or if
    the notification is unavailable, so the caller falls back to polling)."""
    ps = _psrc()
    if not ps or ps.get("token") is None:
        return True
    chk = ctypes.c_int(0)
    if _libc.notify_check(ps["token"], ctypes.byref(chk)) != 0:
        return True
    return bool(chk.value)


def battery_fast():
    """battery_detail()'s dict, from IOKit's power-source API in process (the
    data pmset prints): no fork. Same fields and state words as pmset's
    ("charging", "discharging", "charged", "finishing charge", "AC attached;
    not charging"). None on a Mac with no battery; battery_detail() if the API
    cannot be loaded."""
    ps = _psrc()
    if not ps:
        return battery_detail()
    iok, cf = _IOK["iok"], _IOK["cf"]
    blob = iok.IOPSCopyPowerSourcesInfo()
    if not blob:
        return battery_detail()
    try:
        lst = iok.IOPSCopyPowerSourcesList(blob)
        if not lst:
            return None
        try:
            for i in range(cf.CFArrayGetCount(lst)):
                d = iok.IOPSGetPowerSourceDescription(blob, cf.CFArrayGetValueAtIndex(lst, i))
                if not d or _cfget(d, "Type") != "InternalBattery":
                    continue
                if _cfget(d, "Is Present") is False:
                    continue
                cur, mx = _cfget(d, "Current Capacity"), _cfget(d, "Max Capacity")
                if cur is None:
                    continue
                pct = int(round(100.0 * cur / mx)) if mx else int(cur)
                ac = _cfget(d, "Power Source State") == "AC Power"
                charging = bool(_cfget(d, "Is Charging"))
                if charging and _cfget(d, "Is Finishing Charge"):
                    state = "finishing charge"
                elif charging:
                    state = "charging"
                elif ac and _cfget(d, "Is Charged"):
                    state = "charged"
                elif ac:
                    state = "ac attached; not charging"
                else:
                    state = "discharging"
                mins = _cfget(d, "Time to Full Charge" if charging else "Time to Empty")
                if state == "charged":
                    mins = 0                     # pmset: "100%; charged; 0:00 remaining"
                elif ac and not charging:
                    mins = None                  # pmset prints no time
                else:                            # -1: still calculating ("no estimate")
                    mins = mins if isinstance(mins, int) and mins >= 0 else None
                return {"pct": pct, "charging": state in ("charging", "finishing charge"),
                        "ac": ac, "mins_left": mins, "state": state}
        finally:
            cf.CFRelease(lst)
    finally:
        cf.CFRelease(blob)
    return None


def rate_limits(dirpath=None, now=None):
    """The statusline's per-session plan-limit records, merged into one pair.

    Each file in cache/ratelimits.d is one session's last payload, written by
    statusline.sh as `five_pct five_reset week_pct week_reset written_at`, with
    -1 0 for a window the payload did not carry. Merge per window, the same
    rule the statusline applies (see its MERGE RULE): drop a window whose
    reset has passed, newest reset wins, then the higher percentage.

    `written_at` is NOT the age of the reading. Every open session rewrites its
    record about once a second from the payload of its LAST API response, so
    an idle session stamps an old figure as new: measured 2026-11-04, three
    records written within one second read 69%, 80% and 83% for the same
    weekly window. Usage only climbs inside a window, so the highest is the
    freshest.

    A window whose reset has passed with no newer record has ROLLED OVER: that
    is reported as pct 0, stale True, not as a missing figure. kiln-top drew
    it as "-1%". pct None means no session ever reported the window.
    """
    dirpath = dirpath or os.path.expanduser("~/.claude/cache/ratelimits.d")
    now = time.time() if now is None else now
    best = [None, None]
    expired = [0, 0]
    read_at = 0
    try:
        names = os.listdir(dirpath)
    except OSError:
        names = []
    for n in names:
        try:
            with open(os.path.join(dirpath, n)) as f:
                vals = [int(x) for x in f.readline().split()[:5]]
        except Exception:
            continue
        if len(vals) < 4:                 # empty or truncated record
            continue
        if len(vals) > 4:
            read_at = max(read_at, vals[4])
        for i in (0, 1):
            pct, reset = vals[i * 2], vals[i * 2 + 1]
            if pct < 0 or reset <= 0:
                continue
            if reset <= now:
                expired[i] = max(expired[i], reset)
                continue
            b = best[i]
            if b is None or reset > b[1] or (reset == b[1] and pct > b[0]):
                best[i] = (pct, reset)

    def win(i):
        if best[i]:
            return {"pct": best[i][0], "resets_at": best[i][1], "stale": False}
        if expired[i]:
            return {"pct": 0, "resets_at": None, "stale": True,
                    "last_reset_at": expired[i]}
        return {"pct": None, "resets_at": None, "stale": True}
    return {"five_hour": win(0), "seven_day": win(1), "read_at": read_at or None}
