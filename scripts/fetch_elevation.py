#!/usr/bin/env python3
"""Fetch a 1 arc-minute elevation grid for the Inland Empire / Orange County
region from NOAA ETOPO1 (ERDDAP dataset etopo180, public domain).
Adapted from the interactiveViz fetch script.

Writes data/terrain.bin (int16 little-endian metres, rows north->south,
cols west->east) and data/terrain.json (grid metadata)."""
import array
import csv
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST = "https://upwell.pfeg.noaa.gov/erddap/griddap/etopo180.csv"
LAT = (33.30, 34.45)
LON = (-118.25, -116.60)


def get(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=300) as resp:
                return resp.read().decode("utf-8")
        except Exception as exc:
            if attempt == tries - 1:
                raise
            print(f"retrying ({exc.__class__.__name__})")
            time.sleep(5)


def main():
    rows = {}
    bands = 3
    step = (LAT[1] - LAT[0]) / bands
    for b in range(bands):
        lo, hi = LAT[0] + b * step, LAT[0] + (b + 1) * step
        q = f"?altitude%5B({lo:.4f}):1:({hi:.4f})%5D%5B({LON[0]}):1:({LON[1]})%5D"
        for r in list(csv.reader(io.StringIO(get(HOST + q))))[2:]:
            rows[(round(float(r[0]), 5), round(float(r[1]), 5))] = r[2]
    lats = sorted({k[0] for k in rows}, reverse=True)
    lons = sorted({k[1] for k in rows})
    li = {v: i for i, v in enumerate(lats)}
    lo = {v: i for i, v in enumerate(lons)}
    grid = array.array("h", [0]) * (len(lats) * len(lons))
    for (lat, lon), alt in rows.items():
        grid[li[lat] * len(lons) + lo[lon]] = max(-32768, min(32767, int(float(alt))))
    if sys.byteorder != "little":
        grid.byteswap()
    (ROOT / "data" / "terrain.bin").write_bytes(grid.tobytes())
    meta = {"source": "NOAA ETOPO1 (etopo180) via ERDDAP, metres", "rows": len(lats), "cols": len(lons),
            "north": lats[0], "south": lats[-1], "west": lons[0], "east": lons[-1]}
    (ROOT / "data" / "terrain.json").write_text(json.dumps(meta, indent=1))
    print(meta, "max", max(grid), "min", min(grid))


if __name__ == "__main__":
    main()
