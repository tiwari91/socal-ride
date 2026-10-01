"""Small Overpass API helper shared by the fetch scripts (cached in raw/)."""
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
RAW.mkdir(exist_ok=True)
ENDPOINT = "https://overpass-api.de/api/interpreter"
UA = "citrus-to-surf-builder/1.0 (+https://github.com/tiwari91)"


def overpass(query, cache_name, tries=4):
    path = RAW / cache_name
    if path.exists():
        return json.loads(path.read_text())
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(tries):
        try:
            req = urllib.request.Request(ENDPOINT, data=body, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=400) as resp:
                text = resp.read().decode("utf-8")
            data = json.loads(text)
            path.write_text(text)
            return data
        except Exception as exc:
            print(f"  overpass retry {attempt + 1} ({exc.__class__.__name__}: {str(exc)[:80]})")
            time.sleep(25 * (attempt + 1))
    raise RuntimeError("overpass failed: " + cache_name)
