#!/usr/bin/env python3
"""Second pass after build_route.py: fetch OSM buildings, land use and
landmark POIs along the stitched route (Overpass 'around' a line).
Cached in raw/. Map data (c) OpenStreetMap contributors, ODbL."""
import json
import math
from pathlib import Path

from osm import overpass

ROOT = Path(__file__).resolve().parent.parent
route = json.loads((ROOT / "data" / "route.json").read_text())
O = route["origin"]
xz = route["xz"]
STEP = route["step"]
N = len(xz) // 2

# route km ranges that get real building footprints
CITY = [(0, 5.0), (23.5, 26.5), (80.5, 93), (106.5, 117.5), (117.5, 132.5)]


def latlon(i):
    x, z = xz[2 * i], xz[2 * i + 1]
    return (-z / O["kz"] + O["lat"], x / O["kx"] + O["lon"])


def line(a_km, b_km, every=60):
    i0 = int(a_km * 1000 / STEP)
    i1 = min(N - 1, int(b_km * 1000 / STEP))
    k = max(1, int(every / STEP))
    pts = [latlon(i) for i in range(i0, i1 + 1, k)]
    return ",".join(f"{la:.5f},{lo:.5f}" for la, lo in pts)


def main():
    for a, b in CITY:
        q = f'[out:json][timeout:300];way["building"](around:150,{line(a, b)});out body geom;'
        d = overpass(q, f"bld_{int(a)}_{int(b)}.json")
        print("buildings", a, b, len(d["elements"]))
    total = route["length"] / 1000
    k = 0.0
    while k < total:
        b = min(total, k + 12)
        q = ('[out:json][timeout:300];('
             f'way["landuse"~"^(orchard|farmland|grass|meadow|recreation_ground|cemetery|vineyard)$"](around:450,{line(k, b, 120)});'
             f'way["leisure"~"^(park|golf_course|pitch)$"](around:450,{line(k, b, 120)});'
             f'way["natural"~"^(scrub|wood|grassland|beach|sand|water|cliff)$"](around:600,{line(k, b, 120)});'
             ');out body geom;')
        d = overpass(q, f"land_{int(k)}.json")
        print("land", k, len(d["elements"]))
        k = b
    names = ["A. K. Smiley Public Library", "Mission Inn", "Mount Rubidoux", "California State University, Fullerton",
             "University of California, Irvine", "Fashion Island", "Crystal Cove State Park", "Main Beach Park",
             "Redlands Bowl", "Kimberly Crest", "Riverside City Hall", "Heisler Park", "Newport Pier", "Balboa Pier"]
    parts = "".join(f'nwr["name"="{n}"](33.4,-118.1,34.2,-117.1);' for n in names)
    d = overpass(f'[out:json][timeout:120];({parts});out center tags;', "pois.json")
    print("pois", len(d["elements"]))


if __name__ == "__main__":
    main()
