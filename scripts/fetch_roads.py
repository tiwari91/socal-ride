#!/usr/bin/env python3
"""Download the road network along the ride corridor from OpenStreetMap
(Overpass API) plus the coastline. Raw responses are cached in raw/ (not committed).
Map data (c) OpenStreetMap contributors, ODbL."""
from osm import overpass

MAJOR = "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link)$"
# south, west, north, east boxes hugging the route
BOXES = {
    "redlands": (34.015, -117.36, 34.095, -117.14),
    "colton": (33.95, -117.42, 34.08, -117.28),
    "riverside": (33.82, -117.86, 34.00, -117.36),
    "orange": (33.66, -117.90, 33.88, -117.74),
    "fullerton": (33.78, -117.94, 33.90, -117.84),
    "coast": (33.52, -117.92, 33.67, -117.74),
}
LOCAL = {  # small downtown boxes where residential streets matter
    "redlands_dt": (34.040, -117.200, 34.065, -117.165),
    "riverside_dt": (33.970, -117.395, 33.995, -117.360),
}


def main():
    for name, (s, w, n, e) in BOXES.items():
        print("roads", name)
        q = f'[out:json][timeout:360];way["highway"~"{MAJOR}"]({s},{w},{n},{e});out body geom;'
        d = overpass(q, f"roads_{name}.json")
        print("  ways", len(d["elements"]))
    for name, (s, w, n, e) in LOCAL.items():
        print("local", name)
        q = f'[out:json][timeout:200];way["highway"~"^(residential|unclassified|living_street)$"]({s},{w},{n},{e});out body geom;'
        d = overpass(q, f"roads_{name}.json")
        print("  ways", len(d["elements"]))
    print("coastline")
    d = overpass('[out:json][timeout:200];way["natural"="coastline"](33.40,-118.10,33.72,-117.68);out body geom;', "coast.json")
    print("  ways", len(d["elements"]))


if __name__ == "__main__":
    main()
