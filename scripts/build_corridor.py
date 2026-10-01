#!/usr/bin/env python3
"""Process cached OSM buildings, land use, side streets and POIs into
data/scenery.json for the ride. Map data (c) OpenStreetMap contributors, ODbL."""
import glob
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
route = json.loads((ROOT / "data" / "route.json").read_text())
O = route["origin"]
STEP = route["step"]
XZ = route["xz"]
N = len(XZ) // 2
CITY = [(0, 5.0), (23.5, 26.5), (80.5, 93), (106.5, 117.5), (117.5, 132.5)]


def proj(lat, lon):
    return ((lon - O["lon"]) * O["kx"], -(lat - O["lat"]) * O["kz"])


CELL = 100.0
grid = {}
for i in range(N):
    grid.setdefault((int(XZ[2 * i] // CELL), int(XZ[2 * i + 1] // CELL)), []).append(i)


def nearest(x, z, r=300):
    ci, cj = int(x // CELL), int(z // CELL)
    R = int(r // CELL) + 1
    best, bi = 1e18, -1
    for i in range(ci - R, ci + R + 1):
        for j in range(cj - R, cj + R + 1):
            for k in grid.get((i, j), ()):
                d = (XZ[2 * k] - x) ** 2 + (XZ[2 * k + 1] - z) ** 2
                if d < best:
                    best, bi = d, k
    return math.sqrt(best), bi


def in_city(i):
    km = i * STEP / 1000
    return any(a <= km <= b for a, b in CITY)


def dp(pts, tol):
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    dx, dz = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dz) or 1e-9
    idx, dmax = 0, -1
    for i in range(1, len(pts) - 1):
        d = abs((pts[i][0] - a[0]) * dz - (pts[i][1] - a[1]) * dx) / L
        if d > dmax:
            idx, dmax = i, d
    if dmax > tol:
        return dp(pts[: idx + 1], tol)[:-1] + dp(pts[idx:], tol)
    return [a, b]


def dp_ring(pts, tol):
    """Simplify a closed ring given without the repeated closing point."""
    if len(pts) < 4:
        return pts
    k = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    a = dp(pts[: k + 1], tol)
    b = dp(pts[k:] + [pts[0]], tol)
    return a[:-1] + b[:-1]


def area(pts):
    s = 0
    for i in range(len(pts)):
        x0, z0 = pts[i]
        x1, z1 = pts[(i + 1) % len(pts)]
        s += x0 * z1 - x1 * z0
    return s / 2


BTYPES = {"house": 1, "detached": 1, "residential": 1, "bungalow": 1, "semidetached_house": 1,
          "apartments": 2, "dormitory": 2, "terrace": 2,
          "commercial": 3, "retail": 3, "supermarket": 3, "hotel": 3,
          "office": 4, "university": 5, "college": 5, "school": 5,
          "church": 6, "chapel": 6, "civic": 7, "public": 7, "government": 7,
          "garage": 8, "garages": 8, "shed": 8, "roof": 8, "carport": 8, "industrial": 9, "warehouse": 9}


def buildings():
    out, seen = [], set()
    for f in sorted(glob.glob(str(ROOT / "raw" / "bld_*.json"))):
        for w in json.load(open(f))["elements"]:
            if w["type"] != "way" or "geometry" not in w or w["id"] in seen:
                continue
            seen.add(w["id"])
            t = w.get("tags", {})
            pts = [proj(g["lat"], g["lon"]) for g in w["geometry"]]
            if len(pts) > 1 and pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) < 3:
                continue
            pts = dp_ring(pts, 0.8)
            if len(pts) < 3:
                continue
            a = area(pts)
            if abs(a) < 30:
                continue
            if a < 0:  # make counter-clockwise in x/(-z) sense consistently
                pts = pts[::-1]
            cx = sum(p[0] for p in pts) / len(pts)
            cz = sum(p[1] for p in pts) / len(pts)
            d, i = nearest(cx, cz, 220)
            if d > 170 or d < 9:
                continue
            ty = BTYPES.get(t.get("building", "yes"), 0)
            if t.get("amenity") in ("place_of_worship",):
                ty = 6
            h = 0
            try:
                h = float(str(t.get("height", "0")).split()[0])
            except ValueError:
                h = 0
            if not h and t.get("building:levels"):
                try:
                    h = float(t["building:levels"]) * 3.5 + 1
                except ValueError:
                    h = 0
            ring = []
            for p in pts:
                ring += [round((p[0] - cx) * 2), round((p[1] - cz) * 2)]
            out.append([round(cx, 1), round(cz, 1), round(h, 1), ty, ring])
    return out


LTYPE = {"orchard": "orchard", "vineyard": "orchard", "farmland": "farm",
         "grass": "green", "meadow": "green", "recreation_ground": "green", "cemetery": "green",
         "park": "green", "golf_course": "golf", "pitch": "green",
         "scrub": "scrub", "grassland": "scrub", "wood": "wood", "beach": "sand", "sand": "sand", "water": "water"}


def landuse():
    out, seen = [], set()
    for f in sorted(glob.glob(str(ROOT / "raw" / "land_*.json"))):
        for w in json.load(open(f))["elements"]:
            if w["type"] != "way" or "geometry" not in w or w["id"] in seen:
                continue
            seen.add(w["id"])
            t = w.get("tags", {})
            ty = LTYPE.get(t.get("landuse") or t.get("leisure") or t.get("natural"))
            if not ty:
                continue
            pts = [proj(g["lat"], g["lon"]) for g in w["geometry"]]
            if len(pts) < 4 or pts[0] != pts[-1]:
                continue
            pts = dp_ring(pts[:-1], 6)
            if len(pts) < 3 or abs(area(pts)) < 800:
                continue
            out.append([ty, [round(v, 0) for p in pts for v in p]])
    return out


def streets():
    out, seen = [], set()
    for f in sorted(glob.glob(str(ROOT / "raw" / "roads_*.json"))):
        for w in json.load(open(f))["elements"]:
            if w["type"] != "way" or "geometry" not in w or w["id"] in seen:
                continue
            seen.add(w["id"])
            t = w["tags"]
            hw = t.get("highway", "")
            if hw.startswith("motorway") or hw.startswith("trunk"):
                continue
            pts = [proj(g["lat"], g["lon"]) for g in w["geometry"]]
            keep, onroute, near_city = [], 0, False
            for p in pts:
                d, i = nearest(p[0], p[1], 260)
                if d < 240 and in_city(i):
                    near_city = True
                if d < 14:
                    onroute += 1
                keep.append((p, d))
            if not near_city or onroute > len(pts) * 0.4:
                continue
            # trim to the part inside 260 m and outside the route carriageway
            run, runs = [], []
            for p, d in keep:
                if 6 < d < 260:
                    run.append(p)
                else:
                    if len(run) > 1:
                        runs.append(run)
                    run = []
            if len(run) > 1:
                runs.append(run)
            width = {"primary": 14, "secondary": 13, "tertiary": 11, "residential": 9, "unclassified": 8,
                     "living_street": 7}.get(hw.replace("_link", ""), 0)
            if not width:
                continue
            for r in runs:
                r = dp(r, 1.0)
                out.append([width, [round(v, 1) for p in r for v in p]])
    return out


def pois():
    d = json.load(open(ROOT / "raw" / "pois.json"))
    out, seen = [], set()
    for e in d["elements"]:
        n = e["tags"].get("name")
        if n in seen:
            continue
        seen.add(n)
        c = e.get("center") or e
        x, z = proj(c["lat"], c["lon"])
        out.append({"name": n, "x": round(x, 1), "z": round(z, 1)})
    x, z = proj(33.8823, -117.8854)
    out.append({"name": "Cal State Fullerton", "x": round(x, 1), "z": round(z, 1)})
    return out


def main():
    b = buildings()
    l = landuse()
    s = streets()
    p = pois()
    data = {"buildings": b, "landuse": l, "streets": s, "pois": p,
            "credit": "Map data (c) OpenStreetMap contributors, ODbL"}
    txt = json.dumps(data, separators=(",", ":"))
    (ROOT / "data" / "scenery.json").write_text(txt)
    print("buildings", len(b), "landuse", len(l), "streets", len(s), "pois", len(p), "KB", len(txt) // 1000)


if __name__ == "__main__":
    main()
