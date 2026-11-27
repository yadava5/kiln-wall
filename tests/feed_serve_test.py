#!/usr/bin/env python3
"""The shared feed's protocol: kiln-feed.py --serve against real subscribers, in a scratch HOME.

    python3 tests/feed_serve_test.py        (macOS: the feed reads the machine through Mach/IOKit)

A fake Claude session (a symlink named `claude` to /bin/sleep, so ps lists it as one) owns a
sessions json, a transcript, chime.jsonl and an ask-chime lock in the scratch HOME, written the
way Claude Code and the hooks write them. Nothing outside the scratch folder is read or written.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

FEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "feed", "kiln-feed.py")
SID = "test-0000-4000-8000-000000000001"


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % int((t % 1) * 1000)


def append(path, obj):
    with open(path, "a") as f:
        f.write(json.dumps(obj, separators=(",", ":")) + "\n")


class Home:
    """A scratch HOME with one live fake session, idle."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="kf")
        self.claude = os.path.join(self.root, ".claude")
        for d in ("sessions", "projects/-t", "cache"):
            os.makedirs(os.path.join(self.claude, d))
        self.tr = os.path.join(self.claude, "projects/-t", SID + ".jsonl")
        self.chime = os.path.join(self.claude, "cache/chime.jsonl")
        self.lock = os.path.join(self.claude, "cache/ask-chime-%s.json" % SID)
        self.sock = os.path.join(self.root, "Library/Application Support/kiln-feed/feed.sock")
        os.symlink("/bin/sleep", os.path.join(self.root, "claude"))
        t = time.time() - 60
        self.user(t)
        append(self.tr, {"isSidechain": False, "type": "system", "subtype": "turn_duration",
                         "timestamp": iso(t + 1)})
        open(self.chime, "w").close()
        # No inherited stdout, so nothing left running can hold a caller's pipe open.
        self.proc = subprocess.Popen([os.path.join(self.root, "claude"), "600"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(os.path.join(self.claude, "sessions/%d.json" % self.proc.pid), "w") as f:
            json.dump({"pid": self.proc.pid, "sessionId": SID, "cwd": "/tmp/t", "kind": "interactive",
                       "startedAt": int(time.time() * 1000), "name": "test-session",
                       "nameSource": "user"}, f)
        self.env = dict(os.environ, HOME=self.root, KILN_GITHUB="0", PYTHONUNBUFFERED="1")
        for k in ("KILN_LAT", "KILN_LON", "KILN_FEED_SOCK"):
            self.env.pop(k, None)
        self.servers = []

    def user(self, t):
        append(self.tr, {"parentUuid": None, "isSidechain": False, "type": "user",
                         "message": {"role": "user", "content": "go"}, "timestamp": iso(t),
                         "sessionId": SID})

    def serve(self):
        p = subprocess.Popen([sys.executable, FEED, "--serve"], env=self.env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        self.servers.append(p)
        for _ in range(200):               # answering, not merely there (a stale file is)
            try:
                Client(self, "").close()
                return p
            except OSError:
                time.sleep(0.025)
        raise AssertionError("no socket answering after 5 s")

    def close(self):
        for p in self.servers:
            if p.poll() is None:
                p.terminate()
                p.wait(10)
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        shutil.rmtree(self.root, ignore_errors=True)


class Client:
    def __init__(self, home, commands="", rcvbuf=None):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if rcvbuf:
            self.s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
        cwd = os.getcwd()
        os.chdir(os.path.dirname(home.sock))      # the scratch path can exceed sun_path
        try:
            self.s.connect("feed.sock")
        finally:
            os.chdir(cwd)
        self.buf = b""
        self.q = []                        # (arrival, line) received, not yet taken
        if commands:
            self.send(commands)

    def send(self, text):
        self.s.sendall(text.encode())

    def _fill(self, timeout):
        """One read of up to `timeout`; False on timeout or close."""
        self.s.settimeout(max(0.001, timeout))
        try:
            chunk = self.s.recv(1 << 20)
        except socket.timeout:
            return False
        if not chunk:
            return False
        now = time.time()
        self.buf += chunk
        while b"\n" in self.buf:
            ln, self.buf = self.buf.split(b"\n", 1)
            self.q.append((now, json.loads(ln)))
        return True

    def lines(self, seconds):
        """Every line received so far plus those arriving within `seconds`."""
        end = time.time() + seconds
        while time.time() < end and self._fill(end - time.time()):
            pass
        out, self.q = self.q, []
        return out

    def until(self, pred, seconds=3.0):
        """The first line for which pred(line) holds, with its arrival time, as soon as it
        arrives; else (None, None). Lines before it are taken too."""
        end = time.time() + seconds
        while True:
            while self.q:
                t, d = self.q.pop(0)
                if pred(d):
                    return t, d
            if time.time() >= end or not self._fill(end - time.time()):
                return None, None

    def close(self):
        self.s.close()


def state(d):
    ss = (d.get("claude") or {}).get("sessions")
    if ss is None:
        return None
    return next((s["state"] for s in ss if s["sid"] == SID), "gone")


def status(home):
    c = Client(home, "status\n")
    _, d = c.until(lambda d: "status" in d)
    c.close()
    return d["status"]


class ServeTest(unittest.TestCase):
    def setUp(self):
        self.home = Home()
        self.clients = []
        try:
            self.server = self.home.serve()
        except BaseException:
            self.home.close()              # tearDown does not run after a failed setUp
            raise

    def tearDown(self):
        for c in self.clients:
            c.close()
        self.home.close()

    def client(self, commands="", rcvbuf=None):
        c = Client(self.home, commands, rcvbuf)
        self.clients.append(c)
        return c

    def test_nothing_before_want_then_a_whole_line_at_once(self):
        c = self.client("hello t\n")
        self.assertEqual(c.lines(0.6), [], "a line before any want")
        t0 = time.time()
        c.send("want claude\n")
        got = c.lines(0.3)
        self.assertTrue(got, "no line within 0.3 s of want")
        self.assertLess(got[0][0] - t0, 0.3)
        d = got[0][1]
        self.assertEqual(sorted(d), ["claude", "feed", "t", "v"])
        self.assertEqual(sorted(d["claude"]), ["agents_running", "events", "limits", "sessions",
                                               "sessions_other", "tokens"])
        self.assertEqual(state(d), "idle")
        self.assertEqual(d["claude"]["sessions"][0]["name"], "test-session")
        self.assertEqual(d["feed"]["subs"], 1)

    def test_blocks_and_sticky_rule_are_per_subscriber(self):
        wall = self.client("hello wall\nwant all\nperiod 200\n")
        isl = self.client("hello island\nwant claude\nperiod 200\n")
        w, i = wall.lines(1.5), isl.lines(0.05)
        i += isl.lines(1.0)
        self.assertGreaterEqual(len(w), 4)
        self.assertGreaterEqual(len(i), 4)
        self.assertTrue({"sys", "claude", "weather", "github", "analytics"} <= set(w[0][1]))
        for _, d in i:
            self.assertEqual(set(d) - {"v", "t", "feed", "claude"}, set(), "island got a block it did not want")
        # Sticky blocks: on the first line, then only when changed (events never change here).
        for lines in (w, i):
            self.assertIn("events", lines[0][1]["claude"])
            self.assertTrue(all("events" not in d["claude"] for _, d in lines[1:]))
        self.assertIn("analytics", w[0][1])
        self.assertFalse(any("analytics" in d for _, d in w[1:3]))
        # A subscriber arriving now still gets every sticky block on its own first line.
        late = self.client("want claude\n")
        _, d = late.until(lambda d: True)
        self.assertIn("events", d["claude"])
        self.assertIn("limits", d["claude"])

    def test_each_subscriber_has_its_own_period(self):
        fast = self.client("want claude\nperiod 200\n")
        slow = self.client("want claude\nperiod 1000\n")
        time.sleep(2.2)
        nf, ns = len(fast.lines(0.05)), len(slow.lines(0.05))
        self.assertTrue(9 <= nf <= 13, "fast got %d lines in 2.2 s at 200 ms" % nf)
        self.assertTrue(2 <= ns <= 4, "slow got %d lines in 2.2 s at 1000 ms" % ns)

    def test_a_session_change_is_pushed_between_periods(self):
        c = self.client("want claude\nperiod 1000\n")
        c.until(lambda d: state(d) == "idle")
        h = self.home
        for name, act, want in (
                ("lock", lambda: json.dump({"pid": os.getpid(), "since": time.time()}, open(h.lock, "w")),
                 "waiting"),
                ("unlock", lambda: os.remove(h.lock), "idle"),
                ("prompt", lambda: h.user(time.time()), "working"),
                ("chime stop", lambda: append(h.chime, {"ts": time.time(), "sid": SID, "event": "stop",
                                                        "verdict": "chime", "why": "done"}), "idle"),
                # killed and reaped, as its shell reaps a real claude (a zombie still
                # answers kill(pid, 0), so it would stay listed until ps drops it)
                ("exit", lambda: (h.proc.kill(), h.proc.wait()), "gone")):
            # Just after a periodic line, so the next is ~0.95 s away and only a push is
            # faster. (No step here is a prompt within 0.5 s of a stop: kiln-feed reads that
            # as the same turn.)
            c.lines(0)
            c.until(lambda d: True, 2.0)
            time.sleep(0.05)
            t0 = time.time()
            act()
            t, d = c.until(lambda d: state(d) == want, 2.0)
            self.assertIsNotNone(t, "%s: never %s" % (name, want))
            self.assertLess(t - t0, 0.25, "%s: %s after %.0f ms, not pushed" % (name, want, (t - t0) * 1000))

    def test_a_streaming_reply_pushes_nothing(self):
        h = self.home
        c = self.client("want claude\nperiod 1000\n")
        h.user(time.time())
        c.until(lambda d: state(d) == "working")
        time.sleep(0.05)
        c.lines(0.01)
        n0 = status(h)["pushes"]
        for k in range(20):            # a reply landing in the transcript, 20 writes in 2 s
            append(h.tr, {"isSidechain": False, "type": "assistant", "timestamp": iso(time.time()),
                          "message": {"id": "m%d" % k, "role": "assistant", "model": "test",
                                      "content": [{"type": "text", "text": "x" * 200}]}})
            time.sleep(0.1)
        got = c.lines(0.2)
        self.assertEqual(status(h)["pushes"], n0, "a streaming reply caused pushes")
        self.assertLessEqual(len(got), 4)
        self.assertTrue(all(state(d) == "working" for _, d in got))

    def test_costly_blocks_run_only_while_someone_wants_them(self):
        isl = self.client("want claude\nperiod 200\n")
        isl.until(lambda d: True)
        s0 = status(self.home)
        time.sleep(1.2)
        s1 = status(self.home)
        self.assertEqual(s1["machine_at"], s0["machine_at"], "machine sampled for a claude-only subscriber")
        self.assertIsNone(s1["analytics_at"], "analytics derived for a claude-only subscriber")
        self.assertIsNone(s1["fill_at"], "the slow ps ran for a claude-only subscriber")
        self.assertEqual(s1["child_cpu_s"], s0["child_cpu_s"], "a fork for a claude-only subscriber")
        wall = self.client("want all\nperiod 200\n")
        wall.until(lambda d: "sys" in d)
        time.sleep(0.5)
        s2 = status(self.home)
        self.assertGreater(s2["machine_at"], s1["machine_at"])
        self.assertIsNotNone(s2["analytics_at"])
        self.assertIsNotNone(s2["fill_at"], "no slow ps for a subscriber that draws top_cpu")
        wall.close()
        self.clients.remove(wall)
        time.sleep(0.5)
        s3 = status(self.home)
        time.sleep(1.0)
        s4 = status(self.home)
        self.assertEqual(s4["machine_at"], s3["machine_at"], "machine still sampled after the wall left")
        self.assertEqual([x["want"] for x in s4["subs"]], [["claude"]])

    def test_a_reader_that_stops_reading_holds_up_nobody(self):
        # The server's 64 KB send buffer is what fills first (measured: 30 lines, 64 KB, in
        # 3 s here), so 5 s of unread lines at 100 ms back up.
        stuck = self.client("hello stuck\nwant all\nperiod 100\n", rcvbuf=2048)
        ok = self.client("hello ok\nwant claude\nperiod 200\n")
        n = 0
        end = time.time() + 5.0
        while time.time() < end:
            n += len(ok.lines(0.2))
        self.assertGreaterEqual(n, 22, "the reading subscriber got %d lines in 5 s at 200 ms" % n)
        subs = {x["name"]: x for x in status(self.home)["subs"]}
        self.assertGreater(subs["stuck"]["skipped"], 0)
        # Once it reads again: its first line (never read until now), the lines that were
        # buffered (sticky blocks left out, as nothing changed), then, after the dropped ones,
        # a line carrying every sticky block again.
        got = stuck.lines(1.5)
        self.assertIn("events", got[0][1]["claude"])
        later = [d for _, d in got[1:] if "events" in d["claude"]]
        self.assertTrue(later, "no line with the sticky blocks after the dropped ones")
        self.assertIn("analytics", later[0])

    def test_status_one_server_and_the_socket_removed_on_exit(self):
        self.client("hello wall\nwant all\nperiod 500\n").until(lambda d: True)
        st = status(self.home)
        self.assertEqual([(x["name"], x["period_ms"]) for x in st["subs"]], [("wall", 500)])
        self.assertEqual(os.stat(self.home.sock).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(os.path.dirname(self.home.sock)).st_mode & 0o777, 0o700)
        second = subprocess.run([sys.executable, FEED, "--serve"], env=self.home.env,
                                capture_output=True, text=True, timeout=20)
        self.assertIn("another --serve", second.stderr)
        self.assertEqual(status(self.home)["pid"], self.server.pid, "the first server stopped serving")
        self.server.send_signal(signal.SIGTERM)
        self.assertEqual(self.server.wait(10), 0)
        self.assertFalse(os.path.exists(self.home.sock), "socket left after exit")

    def test_a_socket_left_by_a_crash_is_replaced(self):
        self.server.kill()
        self.server.wait()
        self.assertTrue(os.path.exists(self.home.sock))
        self.home.serve()
        c = self.client("want claude\n")
        _, d = c.until(lambda d: True)
        self.assertEqual(state(d), "idle")


def sampler():
    """kiln-sample.py, loaded the way kiln-feed loads it."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "kiln_sample_test", os.path.join(os.path.dirname(FEED), "kiln-sample.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class ProcessTableTest(unittest.TestCase):
    """process_table() reads libproc in process; ps is the reference it must agree with."""

    @classmethod
    def setUpClass(cls):
        cls.S = sampler()

    def test_the_table_is_the_one_ps_prints(self):
        S = self.S
        a = S._table_libproc()
        self.assertTrue(a, "the libproc table is empty or unusable (process_table would fork ps)")
        ps = S._table_ps()
        b = S._table_libproc()
        self.assertTrue(ps)
        A, B, P = ({r[0]: r for r in t} for t in (a, b, ps))
        both = set(A) & set(B)
        # Listed before and after ps ran, so alive while it ran: ps must list it.
        self.assertEqual(sorted(both - set(P)), [])
        # ps itself, and anything born after one table and gone before the other.
        missing = set(P) - set(A) - set(B)
        self.assertLessEqual(len(missing), 3, sorted((p, P[p][5]) for p in missing))
        bad = {"ppid": [], "etime": [], "comm": [], "rss": []}
        own = 0
        for pid in sorted(both & set(P)):
            r, p = A[pid], P[pid]
            if r[1] != p[1]:
                bad["ppid"].append((pid, r[1], p[1]))
            if abs(r[2] - p[2]) > 2:
                bad["etime"].append((pid, r[2], p[2]))
            if r[4]:                     # the user's own process: read in full
                own += 1
                if r[5] != p[5]:
                    bad["comm"].append((pid, r[5], p[5]))
                if abs(r[4] - p[4]) > max(8 << 20, p[4] // 4):
                    bad["rss"].append((pid, r[4], p[4]))
        self.assertIn(os.getpid(), A)
        self.assertEqual(A[os.getpid()][5], P[os.getpid()][5], "this process's own comm")
        self.assertGreater(own, 0)
        # A process exec'ing, exiting or growing between the two reads may differ once or twice.
        for k, v in bad.items():
            self.assertLessEqual(len(v), 2, "%s differs from ps: %r" % (k, v[:8]))

    def test_cpu_reads_a_spinning_process_as_busy(self):
        S = self.S
        spin = subprocess.Popen([sys.executable, "-c", "while True: pass"])
        try:
            time.sleep(0.5)
            S._table_libproc()
            time.sleep(1.5)
            row = next((r for r in S._table_libproc() if r[0] == spin.pid), None)
            self.assertIsNotNone(row)
            # ps reads ~100 here. CPU time arrives in Mach units, 125/3 ns on Apple silicon.
            self.assertGreater(row[3], 40, row)
            self.assertLess(row[3], 150, row)
        finally:
            spin.kill()
            spin.wait()


def feed_module():
    """kiln-feed.py as a module (its main() is not run)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("kiln_feed_test", FEED)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class FillTest(unittest.TestCase):
    """Other users' rows: libproc cannot read their CPU or memory, so a slow ps fills them
    in, and only while the sys block (top_cpu/top_mem) is wanted."""

    @classmethod
    def setUpClass(cls):
        cls.F = feed_module()

    def counting_ps(self):
        """Patch subprocess.run in the sampler; returns the list of ps calls it sees."""
        from unittest import mock
        sub = self.F.S.subprocess
        real, calls = sub.run, []

        def run(argv, *a, **k):
            if argv and argv[0] == "/bin/ps":
                calls.append(argv)
            return real(argv, *a, **k)
        p = mock.patch.object(sub, "run", run)
        p.start()
        self.addCleanup(p.stop)
        return calls

    def test_no_ps_fork_unless_the_sys_block_is_wanted(self):
        calls = self.counting_ps()
        s = self.F.Sys()
        for _ in range(3):
            s.tick(force=True, machine=False)           # claude only
            s.tick(force=True, machine=True)            # hist only: machine, no top lists
            s.ps_now()
            s.block()
        self.assertTrue(s.procs.blind, "libproc read every row: nothing to fill (run unprivileged)")
        self.assertEqual(calls, [], "ps forked with no subscriber drawing top_cpu/top_mem")
        self.assertEqual(s.fill_at, 0.0)
        s.tick(force=True, machine=True, top=True)
        self.assertEqual(len(calls), 1, "the sys block wanted: one slow ps")
        s.tick(machine=True, top=True)                  # within its 30 s phase: no other
        self.assertEqual(len(calls), 1)

    def test_other_users_rows_get_cpu_and_rss_from_the_fill(self):
        s = self.F.Sys()
        s.tick(force=True, machine=True, top=True)
        raw = {p[0]: p for p in s.procs}
        # launchd, pid 1, is root's: unreadable to libproc, filled from ps.
        self.assertIn(1, s.procs.blind)
        self.assertEqual(raw[1][3:5], (0.0, 0))
        got = {p[0]: p for p in s.rows()}
        self.assertGreater(got[1][4], 0, "pid 1's rss not filled in")
        unfilled = [raw[p][5] for p in s.procs.blind if p in got and got[p][4] == 0]
        self.assertLessEqual(len(unfilled), 3, unfilled[:5])      # gone between table and ps
        # cpu%: the CPU-time delta between two fills, over the wall time between them.
        cur = self.F.S.ps_usage()
        st, cpu_s, _, rss = cur[1]
        t = time.time()
        s._fill_from({1: (st, cpu_s, 0.0, rss)}, t - 10.0)
        s._fill_from({1: (st, cpu_s + 3.0, 77.0, rss)}, t)
        self.assertAlmostEqual({p[0]: p for p in s.rows()}[1][3], 30.0, places=1)
        # The first fill, or one too long after the last: ps's own %cpu.
        s._fill_prev = None
        s._fill_from({1: (st, cpu_s, 77.0, rss)}, t)
        self.assertEqual({p[0]: p for p in s.rows()}[1][3], 77.0)
        # A pid whose start time does not match (reused) keeps the table's zeros.
        s._fill_from({1: (st - 100.0, cpu_s, 55.0, rss)}, t)
        self.assertEqual({p[0]: p for p in s.rows()}[1][3:5], (0.0, 0))
        # A fill older than FILL_MAX_S is not used.
        s._fill_from({1: (st, cpu_s, 55.0, rss)}, t)
        s.fill_at = time.time() - s.FILL_MAX_S - 1
        self.assertEqual({p[0]: p for p in s.rows()}[1][3:5], (0.0, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
