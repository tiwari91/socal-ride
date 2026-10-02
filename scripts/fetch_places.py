#!/usr/bin/env python3
"""Fetch points of interest along the ride (cafes, food, viewpoints, beaches,
parks, bike shops, fuel, water and restrooms, sights) from the OpenStreetMap
Overpass API and write a compact snapshot to data/places.json.

Run once during development (results are cached in raw/places_*.json so a
re-run does not hit Overpass again; delete those files to refresh):

    python3 scripts/fetch_places.py

Map data (c) OpenStreetMap contributors, ODbL."""
import json
import math
import time
from pathlib import Path

from osm import overpass

ROOT = Path(__file__).resolve().parent.parent
route = json.loads((ROOT / "data" / "route.json").read_text())
O = route["origin"]
xz = route["xz"]
STEP = route["step"]
N = len(xz) // 2
RADIUS = 900  # metres either side of the route
CHUNK_KM = 12

# (category, overpass selector) pairs; first match wins when classifying.
SELECTORS = [
    ("cafe", '["amenity"="cafe"]'),
    ("food", '["amenity"~"^(restaurant|fast_food|ice_cream|food_court)$"]'),
    ("food", '["shop"~"^(bakery|deli)$"]["name"]'),
    ("view", '["tourism"="viewpoint"]'),
    ("beach", '["natural"="beach"]["name"]'),
    ("park", '["leisure"~"^(park|garden|nature_reserve)$"]["name"]'),
    ("bike", '["shop"~"^(bicycle|motorcycle)$"]'),
    ("bike", '["amenity"="bicycle_repair_station"]'),
    ("fuel", '["amenity"="fuel"]'),
    ("water", '["amenity"~"^(drinking_water|toilets|water_point)$"]'),
    ("sight", '["tourism"~"^(museum|attraction|gallery|artwork)$"]["name"]'),
    ("sight", '["historic"]["name"]'),
]
DEFAULT_NAMES = {
    "drinking_water": "Drinking water",
    "toilets": "Restrooms",
    "water_point": "Water",
    "bicycle_repair_station": "Bike repair station",
    "viewpoint": "Viewpoint",
    "fuel": "Gas station",
}


def latlon(i):
    x, z = xz[2 * i], xz[2 * i + 1]
    return (-z / O["kz"] + O["lat"], x / O["kx"] + O["lon"])


def line(a_km, b_km, every=150):
    i0 = int(a_km * 1000 / STEP)
    i1 = min(N - 1, int(b_km * 1000 / STEP))
    k = max(1, int(every / STEP))
    idx = list(range(i0, i1 + 1, k))
    if idx[-1] != i1:
        idx.append(i1)
    return ",".join(f"{la:.5f},{lo:.5f}" for la, lo in (latlon(i) for i in idx))


def classify(t):
    a, sh, tour, nat, lei = t.get("amenity"), t.get("shop"), t.get("tourism"), t.get("natural"), t.get("leisure")
    if a == "cafe":
        return "cafe", "cafe"
    if a in ("restaurant", "fast_food", "ice_cream", "food_court"):
        return "food", a
    if sh in ("bakery", "deli"):
        return "food", sh
    if tour == "viewpoint":
        return "view", "viewpoint"
    if nat == "beach":
        return "beach", "beach"
    if lei in ("park", "garden", "nature_reserve"):
        return "park", lei
    if sh in ("bicycle", "motorcycle"):
        return "bike", sh + "_shop"
    if a == "bicycle_repair_station":
        return "bike", a
    if a == "fuel":
        return "fuel", "fuel"
    if a in ("drinking_water", "toilets", "water_point"):
        return "water", a
    if tour in ("museum", "attraction", "gallery", "artwork"):
        return "sight", tour
    if t.get("historic"):
        return "sight", "historic_" + t["historic"]
    return None, None


# nearest route sample for the "km along the ride" field
CELL = 400
grid = {}
for i in range(0, N, 2):
    grid.setdefault((int(xz[2 * i] // CELL), int(xz[2 * i + 1] // CELL)), []).append(i)


def along(lat, lon):
    x = (lon - O["lon"]) * O["kx"]
    z = -(lat - O["lat"]) * O["kz"]
    cx, cz = int(x // CELL), int(z // CELL)
    best, bi = 1e18, -1
    for dx in (-3, -2, -1, 0, 1, 2, 3):
        for dz in (-3, -2, -1, 0, 1, 2, 3):
            for i in grid.get((cx + dx, cz + dz), ()):
                d = (xz[2 * i] - x) ** 2 + (xz[2 * i + 1] - z) ** 2
                if d < best:
                    best, bi = d, i
    return bi * STEP, math.sqrt(best)


def main():
    total = route["length"] / 1000
    seen = {}
    k = 0.0
    while k < total:
        b = min(total, k + CHUNK_KM)
        ln = line(k, b)
        body = "".join(f"nwr{sel}(around:{RADIUS},{ln});" for _, sel in SELECTORS)
        q = f"[out:json][timeout:300];({body});out center tags;"
        cache = f"places_{int(k)}.json"
        fresh = not (ROOT / "raw" / cache).exists()
        d = overpass(q, cache)
        print("places", k, b, len(d["elements"]))
        for e in d["elements"]:
            t = e.get("tags", {})
            cat, sub = classify(t)
            if not cat:
                continue
            lat = e.get("lat", e.get("center", {}).get("lat"))
            lon = e.get("lon", e.get("center", {}).get("lon"))
            if lat is None:
                continue
            name = t.get("name") or t.get("brand") or DEFAULT_NAMES.get(sub)
            if not name:
                continue
            s, off = along(lat, lon)
            if off > RADIUS + 150:
                continue
            p = {"id": f'{e["type"][0]}{e["id"]}', "c": cat, "t": sub, "n": name,
                 "la": round(lat, 6), "lo": round(lon, 6), "s": round(s), "o": round(off)}
            for src, dst in (("opening_hours", "h"), ("cuisine", "cu"), ("phone", "ph")):
                if t.get(src):
                    p[dst] = t[src][:120]
            web = t.get("website") or t.get("contact:website") or t.get("url")
            if web and web.startswith("http"):
                p["w"] = web[:200]
            street = " ".join(x for x in (t.get("addr:housenumber"), t.get("addr:street")) if x)
            city = t.get("addr:city")
            if street or city:
                p["a"] = ", ".join(x for x in (street, city) if x)
            if t.get("outdoor_seating") == "yes":
                p["os"] = 1
            seen[p["id"]] = p
        if fresh:
            time.sleep(8)  # be polite to the public Overpass instance
        k = b
    places = sorted(seen.values(), key=lambda p: p["s"])
    out = {
        "credit": "Map data (c) OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright",
        "generated": time.strftime("%Y-%m-%d"),
        "radius": RADIUS,
        "places": places,
    }
    (ROOT / "data" / "places.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    counts = {}
    for p in places:
        counts[p["c"]] = counts.get(p["c"], 0) + 1
    print(len(places), "places", counts)


if __name__ == "__main__":
    main()
