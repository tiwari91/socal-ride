#!/usr/bin/env python3
"""Stitch the ride route from cached OSM road data (raw/roads_*.json).

Builds a directed road graph, then runs Dijkstra between named waypoints
(snapped to ways carrying that name or ref), and writes data/route.json:
the centre line of our carriageway in local metres plus per-segment road
attributes, chapter distances and the coastline. Map data (c) OpenStreetMap
contributors, ODbL."""
import glob
import heapq
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAT0, LON0 = 33.85, -117.50
KX = math.cos(math.radians(LAT0)) * 111320.0
KZ = 110574.0


def proj(lat, lon):
    return ((lon - LON0) * KX, -(lat - LAT0) * KZ)


# (match name/ref substring, lat, lon). Order is the ride order.
WAYPOINTS = [
    ("Cajon Street", 34.0445, -117.1742),
    ("West State Street", 34.0567, -117.1935),
    ("I 10", 34.0640, -117.2500),
    ("I 215", 34.0300, -117.3100),
    ("Mission Inn Avenue", 33.9850, -117.3650),
    ("Mission Inn Avenue", 33.9824, -117.3752),
    ("Market Street", 33.9790, -117.3772),
    ("CA 91", 33.9200, -117.4700),
    ("CA 91", 33.8650, -117.7000),
    ("CA 57", 33.8650, -117.8700),
    ("Nutwood Avenue", 33.8780, -117.8850),
    ("State College Boulevard", 33.8300, -117.8895),
    ("I 5", 33.7950, -117.8700),
    ("CA 55", 33.7300, -117.8500),
    ("Jamboree Road", 33.6800, -117.8480),
    ("Campus Drive", 33.6500, -117.8420),
    ("MacArthur Boulevard", 33.6200, -117.8650),
    ("Pacific Coast Highway", 33.5900, -117.8650),
    ("Pacific Coast Highway", 33.5650, -117.8300),
    ("Pacific Coast Highway", 33.5412, -117.7838),
]

CHAPTERS = [
    ("Redlands", 34.0440, -117.1790),
    ("Riverside", 33.9900, -117.3600),
    ("Santa Ana Canyon", 33.8700, -117.6400),
    ("Fullerton", 33.8720, -117.8700),
    ("Irvine", 33.6900, -117.8500),
    ("Newport Beach", 33.6050, -117.8700),
    ("Laguna Beach", 33.5600, -117.8150),
]

COST = {"motorway": 0.55, "trunk": 0.6, "primary": 0.8, "secondary": 0.9, "tertiary": 1.05,
        "motorway_link": 0.9, "trunk_link": 0.9, "primary_link": 1.0, "secondary_link": 1.0, "tertiary_link": 1.1,
        "residential": 1.8, "unclassified": 1.8, "living_street": 3.0}


def load():
    ways = {}
    for f in sorted(glob.glob(str(ROOT / "raw" / "roads_*.json"))):
        for w in json.load(open(f))["elements"]:
            if w["type"] == "way" and "geometry" in w:
                ways[w["id"]] = w
    return ways


def build_graph(ways):
    coords, adj = {}, {}
    for wid, w in ways.items():
        t = w["tags"]
        hw = t.get("highway", "")
        if hw not in COST:
            continue
        ids = w["nodes"]
        for nid, g in zip(ids, w["geometry"]):
            coords[nid] = proj(g["lat"], g["lon"])
        ow = t.get("oneway", "no")
        implied = hw in ("motorway", "motorway_link") or t.get("junction") == "roundabout"
        fwd = True
        back = not (ow in ("yes", "true", "1") or (implied and ow != "no"))
        if ow == "-1":
            fwd, back = False, True
        for a, b in zip(ids, ids[1:]):
            ax, az = coords[a]
            bx, bz = coords[b]
            d = math.hypot(bx - ax, bz - az)
            c = d * COST[hw]
            if fwd:
                adj.setdefault(a, []).append((b, c, wid))
            if back:
                adj.setdefault(b, []).append((a, c, wid))
    return coords, adj


def candidates(ways, coords, key, lat, lon, slack=160):
    px, pz = proj(lat, lon)
    found = []
    for w in ways.values():
        t = w["tags"]
        if key not in t.get("name", "") and key not in t.get("ref", ""):
            continue
        for nid in w["nodes"]:
            if nid in coords:
                x, z = coords[nid]
                found.append((math.hypot(x - px, z - pz), nid))
    if not found:
        raise SystemExit(f"no candidates for {key}")
    near = min(found)[0]
    if near > 800:
        print(f"  warning: {key} nearest node {near:.0f} m away")
    return {nid for d, nid in found if d < near + slack}


def dijkstra(adj, sources, targets):
    dist = {s: 0.0 for s in sources}
    prev = {}
    pq = [(0.0, s) for s in sources]
    heapq.heapify(pq)
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18):
            continue
        if u in targets:
            path = [u]
            while path[-1] in prev:
                path.append(prev[path[-1]][0])
            path.reverse()
            wids = [None] + [prev[n][1] for n in path[1:]]
            return path, wids
        for v, c, wid in adj.get(u, ()):
            nd = d + c
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                prev[v] = (u, wid)
                heapq.heappush(pq, (nd, v))
    raise SystemExit("no path")


def kind_of(t):
    hw = t.get("highway", "")
    if hw in ("motorway", "trunk") and t.get("ref", "") != "CA 1":
        return "freeway"
    if hw.endswith("_link"):
        return "ramp"
    if t.get("ref", "") == "CA 1" or "Pacific Coast" in t.get("name", ""):
        return "coast"
    if hw in ("primary", "secondary"):
        return "boulevard"
    return "street"


def lanes_of(t, kind):
    oneway = t.get("oneway") in ("yes", "1", "true") or t.get("highway", "").startswith("motorway")
    try:
        n = int(str(t.get("lanes", "")).split(";")[0])
    except ValueError:
        n = {"freeway": 6, "ramp": 1, "boulevard": 4, "coast": 4, "street": 2}[kind]
    if not oneway:
        n = max(1, n // 2)
    n = max(1, min(n, 5))
    return n, oneway


def main():
    ways = load()
    coords, adj = build_graph(ways)
    print("ways", len(ways), "nodes", len(coords))
    cands = [candidates(ways, coords, k, la, lo) for k, la, lo in WAYPOINTS]
    full, fwids = [], []
    cur = cands[0]
    for i in range(1, len(cands)):
        path, wids = dijkstra(adj, cur, cands[i])
        if full:
            path, wids = path[1:], wids[1:]
        full += path
        fwids += wids
        cur = {path[-1]} if path else cur
        print(f"  leg {i}: {WAYPOINTS[i][0]} nodes {len(path)}")
    fwids[0] = fwids[1]
    # per-node attributes from the way used to arrive
    pts = []
    for nid, wid in zip(full, fwids):
        t = ways[wid]["tags"]
        k = kind_of(t)
        n, oneway = lanes_of(t, k)
        pts.append({"x": coords[nid][0], "z": coords[nid][1], "kind": k, "lanes": n, "oneway": oneway,
                    "name": t.get("name", t.get("ref", "")), "ref": t.get("ref", "")})
    # drop duplicate points
    clean = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p["x"] - clean[-1]["x"], p["z"] - clean[-1]["z"]) > 0.5:
            clean.append(p)
    pts = clean
    # offset two-way roads to the centre of our (right-hand) carriageway
    LW = 3.6
    off = []
    for i, p in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        dx, dz = b["x"] - a["x"], b["z"] - a["z"]
        L = math.hypot(dx, dz) or 1
        # right-hand normal in x/z with z pointing south: heading (dx,dz) -> right = (-dz, dx)
        rx, rz = -dz / L, dx / L
        o = 0 if p["oneway"] else p["lanes"] * LW / 2 + 0.2
        off.append((rx, rz, o))
    # smooth offsets along the route so lane shifts are gradual
    os_ = [o for _, _, o in off]
    sm = []
    for i in range(len(os_)):
        lo, hi = max(0, i - 6), min(len(os_), i + 7)
        sm.append(sum(os_[lo:hi]) / (hi - lo))
    for p, (rx, rz, _), o in zip(pts, off, sm):
        p["x"] += rx * o
        p["z"] += rz * o
    # resample to even spacing
    STEP = 6.0
    seg = [0.0]
    for a, b in zip(pts, pts[1:]):
        seg.append(seg[-1] + math.hypot(b["x"] - a["x"], b["z"] - a["z"]))
    total = seg[-1]
    out, attr_idx = [], []
    j = 0
    s = 0.0
    while s <= total:
        while j < len(seg) - 2 and seg[j + 1] < s:
            j += 1
        a, b = pts[j], pts[j + 1]
        f = (s - seg[j]) / max(1e-6, seg[j + 1] - seg[j])
        out.append([a["x"] + (b["x"] - a["x"]) * f, a["z"] + (b["z"] - a["z"]) * f])
        attr_idx.append(j + 1 if f > 0.5 else j)
        s += STEP
    # smoothing: a few passes of a binomial filter removes polyline kinks
    for _ in range(6):
        nxt = [out[0]]
        for i in range(1, len(out) - 1):
            nxt.append([(out[i - 1][0] + 2 * out[i][0] + out[i + 1][0]) / 4,
                        (out[i - 1][1] + 2 * out[i][1] + out[i + 1][1]) / 4])
        nxt.append(out[-1])
        out = nxt
    # run-length road attributes
    segs = []
    for i, ai in enumerate(attr_idx):
        p = pts[ai]
        key = (p["kind"], p["lanes"], p["name"], p["ref"])
        if segs and segs[-1]["key"] == key:
            segs[-1]["to"] = i
        else:
            segs.append({"key": key, "from": i, "to": i})
    # merge very short segments into neighbours (ramps aside)
    segs_out = [{"from": s_["from"], "to": s_["to"], "kind": s_["key"][0], "lanes": s_["key"][1],
                 "name": s_["key"][2], "ref": s_["key"][3]} for s_ in segs]
    # chapters: nearest sample to each anchor (monotonic)
    chapters = []
    last = 0
    for name, la, lo in CHAPTERS:
        px, pz = proj(la, lo)
        best = min(range(last, len(out)), key=lambda i: (out[i][0] - px) ** 2 + (out[i][1] - pz) ** 2)
        if name == "Redlands":
            best = 0
        chapters.append({"name": name, "s": round(best * STEP, 1)})
        last = best
    # coastline polylines (land on the left of the way direction)
    coast = []
    cj = json.load(open(ROOT / "raw" / "coast.json"))
    for w in cj["elements"]:
        if "geometry" not in w:
            continue
        line = [proj(g["lat"], g["lon"]) for g in w["geometry"]]
        simp = [line[0]]
        for p in line[1:]:
            if math.hypot(p[0] - simp[-1][0], p[1] - simp[-1][1]) > 25:
                simp.append(p)
        if line[-1] != simp[-1]:
            simp.append(line[-1])
        if len(simp) > 1:
            coast.append([v for p in simp for v in (round(p[0], 1), round(p[1], 1))])
    data = {
        "origin": {"lat": LAT0, "lon": LON0, "kx": KX, "kz": KZ},
        "step": STEP,
        "length": round((len(out) - 1) * STEP, 1),
        "xz": [round(v, 1) for p in out for v in p],
        "segments": segs_out,
        "chapters": chapters,
        "coast": coast,
        "credit": "Map data (c) OpenStreetMap contributors, ODbL",
    }
    (ROOT / "data" / "route.json").write_text(json.dumps(data, separators=(",", ":")))
    print("length km", round(total / 1000, 1), "samples", len(out), "segments", len(segs_out))
    for c in chapters:
        print("  chapter", c)
    names = []
    for s_ in segs_out:
        nm = s_["ref"] or s_["name"]
        if not names or names[-1][0] != nm:
            names.append([nm, s_["kind"], s_["from"] * STEP])
    for n in names:
        print("   ", round(n[2] / 1000, 2), n[1], n[0])


if __name__ == "__main__":
    main()
