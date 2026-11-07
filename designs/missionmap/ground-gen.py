"""Mission Map's ground: the contours of Oxford, Ohio, binned by the way each slope faces.

    python3 ground-gen.py            # writes ground.js beside this file

NOT A GENERATED TEXTURE. The lines are USGS-lineage 3DEP elevation (Terrarium tiles, the
same eight-by-five z14 tiles the kitty wallpaper uses, read from its cache and fetched
only if that cache is gone), contoured at 5 m with every fifth line an index contour.
The window is 1 pt per sample (7.4 m), framed so Miami University sits under the hub:
the Mac is the hub, and the hub is on the campus. Nothing on the canvas is invented;
the only processing is a one-cell Gaussian low-pass before contouring, which is what a
map does by hand when it smooths a 5 m line drawn through 7 m samples.

WHY THE BINS. mm.js lights these contours the way Tanaka (1950) did: a line brightens
where the slope it sits on faces the light. The light is the real sun (and the real
moon at night) over this latitude and longitude at `state.t`, so the page needs each
run of contour tagged with its aspect. Every chained contour is cut into runs by the
16-point compass bearing its slope faces, and each bin becomes one SVG path string;
the page builds them once into inline SVG (32 groups, hair and index by bin, each cut
into a coarse grid of paths, lines under fixed cards dropped) and sets each group's
stroke once a minute. That is the whole runtime cost.

OUTPUT ground.js: window.MM_GROUND = {lat, lon, mpp, interval, bins, hair[16], index[16]}
with coordinates in page points (1512 x 982, top-left origin), 0.1 pt precision.
"""
import json, math, os, urllib.request
import numpy as np
from PIL import Image

S = os.path.dirname(os.path.abspath(__file__))

# ── the place ──────────────────────────────────────────────────────────────
LAT, LON = 39.5070, -84.7452            # Oxford, Ohio: the sun and moon are computed here
UNI_LAT, UNI_LON = 39.5089, -84.7340    # Miami University, under the hub
ZOOM, TW, TH = 14, 8, 5
X0, Y0 = 4331, 6229                     # the kitty wallpaper's tiles, bit for bit
CACHE = os.path.expanduser("~/.config/kitty/backgrounds/tiles/14")
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
CW, CH = 1512, 982                      # the stage, pt
HUB = (756, 468)                        # the hub's centre, pt
INTERVAL, INDEX_EVERY, BINS = 5.0, 5, 16
EPS = 0.12                              # Douglas-Peucker tolerance, pt (a quarter device pixel at 2x)
SIGMA = 1.3                             # low-pass, cells
MINLEN = 8.0                            # pt; shorter closed loops are specks, not landforms

n = 2 ** ZOOM
mpp = 156543.03 * math.cos(math.radians(LAT)) / n
def grid_xy(lat, lon):
    cx = (lon + 180.0) / 360.0 * n - X0
    cy = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n - Y0
    return cx * 256, cy * 256

# ── elevation grid from the cached tiles ───────────────────────────────────
os.makedirs(CACHE, exist_ok=True)
el = np.zeros((TH * 256, TW * 256), dtype=np.float64)
for ty in range(TH):
    for tx in range(TW):
        path = f"{CACHE}/{X0 + tx}_{Y0 + ty}.png"
        if not os.path.exists(path):
            with urllib.request.urlopen(TILE_URL.format(z=ZOOM, x=X0 + tx, y=Y0 + ty), timeout=30) as r, open(path, "wb") as fh:
                fh.write(r.read())
            print(f"  fetched {os.path.basename(path)}")
        px = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
        el[ty * 256:(ty + 1) * 256, tx * 256:(tx + 1) * 256] = px[..., 0] * 256 + px[..., 1] + px[..., 2] / 256 - 32768

# ── window: 1 pt per sample, the university under the hub ──────────────────
ux, uy = grid_xy(UNI_LAT, UNI_LON)
ox, oy = int(round(ux - HUB[0])), int(round(uy - HUB[1]))
assert 0 <= ox and ox + CW + 1 <= el.shape[1] and 0 <= oy and oy + CH + 1 <= el.shape[0], (ox, oy)
z = el[oy:oy + CH + 1, ox:ox + CW + 1]

# separable Gaussian, one cell: the contour of a 7 m sample grid at a 5 m interval
# wanders through flat ground without it (edge rows repeat)
k = np.exp(-0.5 * (np.arange(-3, 4) / SIGMA) ** 2); k /= k.sum()
def blur1(a, axis):
    pad = [(0, 0), (0, 0)]; pad[axis] = (3, 3)
    p = np.pad(a, pad, mode="edge"); out = np.zeros_like(a)
    for i, w in enumerate(k):
        out += w * (p[i:i + a.shape[0], :] if axis == 0 else p[:, i:i + a.shape[1]])
    return out
z = blur1(blur1(z, 0), 1)
gy, gx = np.gradient(z)                      # dz/dy (y down), dz/dx
lo, hi = float(z.min()), float(z.max())
print(f"window {CW}x{CH} pt at {mpp:.2f} m/pt = {CW * mpp / 1000:.1f} x {CH * mpp / 1000:.1f} km; "
      f"grid origin ({ox},{oy}); university at grid ({ux:.0f},{uy:.0f}); elevation {lo:.0f}..{hi:.0f} m")

# ── marching squares, vectorised per level ─────────────────────────────────
# Corner order a(i,j) b(i+1,j) c(i+1,j+1) d(i,j+1). Each endpoint is keyed by the cell
# edge it lies on ("h", i, j) = the top edge of cell (i, j), ("v", i, j) = its left edge,
# so chaining needs no float matching: a level crosses an edge at most once.
a, b, c, d = z[:-1, :-1], z[:-1, 1:], z[1:, 1:], z[1:, :-1]
J, I = np.indices(a.shape)
def f(va, vb, t):
    dd = vb - va
    return np.where(dd == 0, 0.5, (t - va) / np.where(dd == 0, 1, dd))
# case -> edge pairs; edges: 0 top, 1 right, 2 bottom, 3 left
CASES = {1: [(3, 0)], 2: [(0, 1)], 3: [(3, 1)], 4: [(1, 2)], 5: [(3, 0), (1, 2)], 6: [(0, 2)], 7: [(3, 2)],
         8: [(2, 3)], 9: [(0, 2)], 10: [(0, 1), (2, 3)], 11: [(2, 1)], 12: [(1, 3)], 13: [(1, 0)], 14: [(0, 3)]}
levels = []
L = math.ceil(lo / INTERVAL) * INTERVAL
while L < hi:
    levels.append(L); L += INTERVAL

def edge_key(e, i, j):
    return ("h", i, j) if e == 0 else ("v", i + 1, j) if e == 1 else ("h", i, j + 1) if e == 2 else ("v", i, j)

hair_runs, index_runs = [], []
nseg = 0
for t in levels:
    idx = (a > t) * 1 | (b > t) * 2 | (c > t) * 4 | (d > t) * 8
    sel = (idx > 0) & (idx < 15)
    ii, jj = I[sel], J[sel]; cs = idx[sel]
    va, vb, vc, vd = a[sel], b[sel], c[sel], d[sel]
    pts = [np.stack([ii + f(va, vb, t), jj], 1), np.stack([ii + 1, jj + f(vb, vc, t)], 1),
           np.stack([ii + f(vd, vc, t), jj + 1], 1), np.stack([ii, jj + f(va, vd, t)], 1)]
    # segments as (key0, key1, p0, p1)
    segs = []
    for case, pairs in CASES.items():
        m = np.nonzero(cs == case)[0]
        for e0, e1 in pairs:
            for q in m:
                i, j = int(ii[q]), int(jj[q])
                segs.append((edge_key(e0, i, j), edge_key(e1, i, j), tuple(pts[e0][q]), tuple(pts[e1][q])))
    nseg += len(segs)
    # chain: each edge key touches at most two segments
    at = {}
    for s, sg in enumerate(segs):
        at.setdefault(sg[0], []).append(s); at.setdefault(sg[1], []).append(s)
    used = [False] * len(segs)
    def walk(s, key):
        out = []
        while True:
            used[s] = True
            sg = segs[s]
            nk, p = (sg[1], sg[3]) if sg[0] == key else (sg[0], sg[2])
            out.append(p)
            nxt = [u for u in at.get(nk, []) if not used[u]]
            if not nxt:
                return out
            s, key = nxt[0], nk
    for s in range(len(segs)):
        if used[s]:
            continue
        sg = segs[s]
        # walk(s, k) enters segment s from endpoint k, so back = [p0 .. far end on the p0
        # side] and fwd = [p1 .. far end on the p1 side]; a loop closes on itself.
        back = walk(s, sg[1])
        used[s] = False
        fwd = walk(s, sg[0])
        chain = list(reversed(back)) + fwd
        if len(chain) < 2 or sum(math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(chain, chain[1:])) < MINLEN:
            continue
        (index_runs if round(t / INTERVAL) % INDEX_EVERY == 0 else hair_runs).append(chain)
print(f"{len(levels)} levels -> {nseg} segments, {len(hair_runs)} hair chains, {len(index_runs)} index chains")

# ── aspect per vertex, runs per bin, simplify, emit ────────────────────────
# Compass bearing the slope faces = the downhill direction: east -dz/dx, north +dz/dy
# (y runs south). Smoothed along the chain over nine vertices so a run does not break
# on every wobble of a near-flat gradient.
def bearings(chain):
    P = np.array(chain)
    x = np.clip(P[:, 0], 0, CW - 1e-6); y = np.clip(P[:, 1], 0, CH - 1e-6)
    i0, j0 = x.astype(int), y.astype(int); fx, fy = x - i0, y - j0
    def samp(g):
        return ((1 - fx) * (1 - fy) * g[j0, i0] + fx * (1 - fy) * g[j0, i0 + 1] + (1 - fx) * fy * g[j0 + 1, i0] + fx * fy * g[j0 + 1, i0 + 1])
    e, nn = -samp(gx), samp(gy)
    ang = np.arctan2(e, nn)
    cs, sn = np.cos(ang), np.sin(ang)
    w = np.ones(9) / 9
    if len(ang) >= 9:
        cs = np.convolve(np.pad(cs, 4, mode="edge"), w, "valid"); sn = np.convolve(np.pad(sn, 4, mode="edge"), w, "valid")
    return (np.degrees(np.arctan2(sn, cs)) + 360) % 360

def dp(pts, eps):
    if len(pts) < 3:
        return pts
    out = [pts[0]]; stack = [(0, len(pts) - 1)]; keep = np.zeros(len(pts), bool); keep[0] = keep[-1] = True
    P = np.array(pts)
    while stack:
        s, e = stack.pop()
        if e - s < 2:
            continue
        A, B = P[s], P[e]; AB = B - A; ln = np.hypot(*AB)
        seg = P[s + 1:e]
        dist = np.abs((seg[:, 0] - A[0]) * AB[1] - (seg[:, 1] - A[1]) * AB[0]) / ln if ln > 0 else np.hypot(seg[:, 0] - A[0], seg[:, 1] - A[1])
        m = int(np.argmax(dist))
        if dist[m] > eps:
            keep[s + 1 + m] = True; stack.append((s, s + 1 + m)); stack.append((s + 1 + m, e))
    return [p for p, kp in zip(pts, keep) if kp]

def to_paths(chains):
    runs = [[] for _ in range(BINS)]
    npts = 0
    for chain in chains:
        br = bearings(chain)
        bins = (np.round(br / (360 / BINS)).astype(int)) % BINS
        s = 0
        for e in range(1, len(chain) + 1):
            if e == len(chain) or bins[e] != bins[s]:
                run = chain[s:e + 1] if e < len(chain) else chain[s:e]   # share the joint vertex
                if len(run) >= 2:
                    r = dp(run, EPS); runs[int(bins[s])].append(r); npts += len(r)
                s = e
    paths = []
    for rs in runs:
        d = []
        for r in rs:
            d.append("M" + " ".join(f"{x:.1f} {y:.1f}" for x, y in r[:1]) + "L" + " ".join(f"{x:.1f} {y:.1f}" for x, y in r[1:]))
        paths.append("".join(d))
    return paths, npts

hair, nh = to_paths(hair_runs)
index, ni = to_paths(index_runs)
out = {"lat": LAT, "lon": LON, "mpp": round(mpp, 3), "interval": INTERVAL, "bins": BINS,
       "levels": [levels[0], levels[-1]], "hair": hair, "index": index}
dst = f"{S}/ground.js"
with open(dst, "w") as fh:
    fh.write("// Generated by ground-gen.py from 3DEP elevation (Terrarium z14 tiles): do not edit.\n")
    fh.write("window.MM_GROUND=" + json.dumps(out, separators=(",", ":")) + ";\n")
print(f"{nh} hair + {ni} index vertices after simplification -> {os.path.getsize(dst) // 1024} KB {dst}")
