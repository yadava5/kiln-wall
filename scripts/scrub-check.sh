#!/usr/bin/env bash
# scrub-check.sh: fail if anything personal is in a file git would publish.
#
#   scripts/scrub-check.sh          (or: npm run scrub)
#
# Scans every file `git ls-files -co --exclude-standard` lists (tracked plus untracked, minus
# ignored), text files only, and prints file:line for each hit. Exit 0 = clean, 1 = hits,
# 2 = could not run.
#
# What it looks for:
#   1. macOS home-directory paths;
#   2. e-mail addresses (any; allow one with SCRUB_ALLOW_EMAIL='regex');
#   3. the author's GitHub handle anywhere but the bundle id io.github.<handle>.kilnwall;
#   4. paths into the author's other, private wallpaper project;
#   5. denylisted tokens: the author's name and e-mail, real session, project and repository
#      names, and personal agent names. These are stored as truncated SHA-256 hashes of the
#      lowercase token, so this public script does not itself publish the names it guards.
#      A token is matched whole and by its pieces (split at . _ : / @);
#   6. a fixture (a file assigning window.KILN_FIXTURE) that is not the synthetic one, or
#      that carries markers of a real capture.
# Extra plaintext tokens, one per line, can be added for a local run in a git-ignored
# .release-notes/denylist.txt.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
command -v python3 >/dev/null || { echo "scrub-check: python3 not found" >&2; exit 2; }
exec python3 -I - <<'PY'
import hashlib, os, re, subprocess, sys

DENY = set("""
0e6a8e0b849ed9b0 1521a6dc7ffb9c8a 23f1029dcbb52814 2405edb9cb818ab6 250251da56ffc074 2b8b3644ac7e9a7d
327c91918300f488 3450ac98c9f92a5c 3608e4bd0e693177 3848e9eff8d31953 42aef2f386567bd5 4949f017b95eac35
4ae4ea8fc89d2239 4bfbdf7ebee257ff 4e05ba345e2a07e6 5871aba85df7c214 5d28e5e2c8509529 69bad3bad23e4274
6c7d8e25dbc7e992 73b73fc47c51ceb3 742f60d6cf0a684c 77c6afde5c431e2b 7b6b9413d4b34430 80d820808e1a5781
81fc491b95a4aba1 8535736902ba8d36 88669879cd6ae5e2 9259cfc2a4ef8d15 97ca08051f9cc1f3 9ce12cdb0203fca2
9d2bd64948862859 9f7a4d84ecec8e36 a59b3972600a69e3 a68e36f1cde694e7 a8392aebe6547302 ab946f94220db9d9
b35e16d0d135be3c bbebec50e47b8dc6 bc321492ad33afc6 bf69453240b00446 c07a7c07fd542fd5 c5a62ce3fa7f6d86
c7a65f6369e7a127 cd5430295cd2c3a4 d27200032bd8d877 d371e4ecc9678aac d703a32a7ae5d356 e32efe6cec98e1a2
e3edddb0ed97a47b ede713f05b636055 eefd0d7defd4cb5a f831c3a29d05f41f fc76c15ec39f410c fe4d66bc1928178b
""".split())
h16 = lambda s: hashlib.sha256(s.encode()).hexdigest()[:16]
extra = ".release-notes/denylist.txt"
if os.path.exists(extra):
    DENY |= {h16(l.strip().lower()) for l in open(extra, encoding="utf-8") if l.strip() and not l.startswith("#")}

# The literals are split so this file does not match its own patterns.
HOME, HANDLE, LW = "/" + "Users/", "yada" + "va5", "live" + "-?wall"
PATTERNS = [
    ("home path", re.compile(re.escape(HOME))),
    ("e-mail", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")),
    ("handle outside the bundle id", re.compile(rf"(?i)(?<!io\.github\.){HANDLE}|{HANDLE}(?!\.kilnwall)")),
    ("private wallpaper project path", re.compile(rf"(?i)[/~][^\s'\"]*{LW}|{LW}paper")),
]
# The author's public identity belongs in the copyright line, the repository URL and the
# credits, and nowhere else. In these files only, exactly these forms are removed before
# scanning: the full name, and the handle as a GitHub URL, an owner/repo slug or an @mention
# at a word boundary. Anything else personal in them (paths, e-mail, session names) still hits.
IDENTITY_FILES = {"LICENSE", "README.md", "CREDITS.md", "SECURITY.md"}
NAME = "Ayu" + "sh Yad" + "av"
IDENTITY = re.compile(rf"{NAME}|(?:https?://)?github\.com/{HANDLE}(?:/[\w.-]+)*|{HANDLE}/[\w.-]+|@{HANDLE}\b")
ALLOW_EMAIL = os.environ.get("SCRUB_ALLOW_EMAIL")
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]*")
FIX_ASSIGN = re.compile(r'^\s*window\.KILN_FIXTURE\s*=\s*\{"', re.M)   # the data file, not a mention
REAL_MARKERS = [re.compile(p, re.I) for p in (r"real kiln-feed capture", r"never commit", r'"lat":\s*39\.5', r'"lon":\s*-84\.7', r"oxford")]

try:
    files = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], capture_output=True, check=True).stdout.decode().split("\0")
except Exception as e:
    print("scrub-check: git ls-files failed:", e, file=sys.stderr); sys.exit(2)
files = [f for f in files if f and os.path.isfile(f)]
if not files:
    print("scrub-check: no files to scan", file=sys.stderr); sys.exit(2)

hits, scanned = [], 0
def hit(f, n, what, s):
    hits.append(f"{f}:{n}: {what}: {s[:80]}")

for f in files:
    with open(f, "rb") as fh:
        data = fh.read()
    if b"\0" in data[:8192]:
        continue                                   # binary (fonts, images)
    scanned += 1
    text = data.decode("utf-8", "replace")
    identity = f in IDENTITY_FILES or f.startswith(".github/")
    for n, line in enumerate(text.splitlines(), 1):
        if identity:
            line = IDENTITY.sub("", line)   # a leftover bare name or handle still hits below
        for what, rx in PATTERNS:
            for m in rx.finditer(line):
                if what == "e-mail" and ALLOW_EMAIL and re.fullmatch(ALLOW_EMAIL, m.group(0)):
                    continue
                hit(f, n, what, m.group(0))
        for m in TOKEN.finditer(line):
            tok = m.group(0).strip(".:/-@").lower()
            for piece in {tok, *re.split(r"[._:/@]+", tok)}:
                piece = piece.strip("-")
                if piece and h16(piece) in DENY:
                    hit(f, n, "denylisted token", piece)
    if FIX_ASSIGN.search(text):
        if not text.startswith("// SYNTHETIC demo feed"):
            hit(f, 1, "fixture without the synthetic header", text.splitlines()[0] if text else "")
        for rx in REAL_MARKERS:
            m = rx.search(text)
            if m:
                hit(f, text.count("\n", 0, m.start()) + 1, "real-capture marker in a fixture", m.group(0))

for h in hits:
    print(h)
print(f"scrub-check: {scanned} text files of {len(files)} scanned, {len(hits)} hit(s)")
sys.exit(1 if hits else 0)
PY
