# Citrus to Surf

A slow, scenic motorcycle ride across Southern California in the browser. You start among the orange groves and mission-revival storefronts of Redlands in the morning and finish on Pacific Coast Highway in Laguna Beach as the sun goes down over the ocean.

**Ride it:** https://tiwari91.github.io/socal-ride/

## The route (about 82 miles)

1. **Redlands**: Cajon Street, Citrus Avenue and State Street past the A. K. Smiley Public Library, then Redlands Boulevard to the I-10, with groves and eucalyptus windbreaks below the San Bernardino Mountains.
2. **Riverside**: I-215 and the 91 into downtown, Mission Inn Avenue under the palms, Mount Rubidoux and its summit cross to the west.
3. **Santa Ana Canyon**: CA-91 through the river gap between the Chino Hills and the Santa Ana Mountains.
4. **Fullerton**: CA-57 to Nutwood Avenue past Cal State Fullerton, then State College Boulevard south through Anaheim, I-5 and CA-55.
5. **Irvine**: I-405 to Jamboree Road, Campus Drive and Peltason Drive through UC Irvine, jacarandas and office towers.
6. **Newport Beach**: MacArthur Boulevard down to Pacific Coast Highway, Corona del Mar and Crystal Cove.
7. **Laguna Beach**: PCH along the coves to Main Beach at sunset.

Every road is real: the route is stitched from OpenStreetMap ways with a shortest-path search between named waypoints, so the curves, ramps and lane counts follow the actual streets and freeways.

## What you can do

- **Cruise**: the bike rides itself at a relaxed, realistic pace (city 25 to 40 mph, freeway about 65), slowing for curves and traffic. The camera drifts between chase, side, low-wheel and drone views.
- **Ride**: you take the bars. Throttle, brake and steer within the lanes; the bike leans into turns, the road edge keeps you on the pavement, and traffic slows for you.
- **Chapters**: jump to any city from the pin menu (or keys 1 to 7). A title card announces each city and the HUD notes landmarks as you pass them.
- **Time and weather**: time of day follows the ride (morning to sunset), or set it by hand. June Gloom adds a grey marine layer near the coast. Streetlights, lit windows, headlight and taillights come on at dusk.
- **Sound** (procedural Web Audio, no files): a V-twin engine tied to RPM with gear changes, wind, tyre hum and freeway slab joints, birds in the groves, surf at the coast and an optional soft ambient pad. Muted until you turn it on; the choice is remembered.
- **Paint**: four original colour schemes for the bike (the rider's helmet is painted to match).
- **Explore the map**: tap the minimap, the map button or press G for a full-screen OpenStreetMap you can pan and zoom. It shows the whole route (ridden part in orange), the chapter stops and your live position and heading, plus about 2,000 real places within roughly half a mile of the road: cafes, food, viewpoints, beaches, parks, sights, bike and motorcycle shops, fuel, and water and restrooms. Markers cluster as you zoom out; category chips turn each kind on or off; the search box finds anything along the whole route by name, type or cuisine; the list shows what is in view, nearest first. Each place has a popup with its type, address, opening hours, phone, website and OpenStreetMap link, and **Ride here** jumps the bike to it. **Refresh area** fetches the latest places for the current view from the Overpass API (zoomed in only, cached in your browser for a week).
- **Places in 3D**: the nearest places ahead float as labelled pins over the scene with their distance. Click or tap one to open it on the map. Turn them off from the map panel.

### Realism

- **Roads**: Caltrans-style portland-cement concrete on the freeways (longitudinal tining, slab joints, raised reflective markers between the lane dashes) with asphalt shoulders and ground-in rumble strips; city asphalt with visible aggregate, sun-faded patches, utility-cut patches, sealed transverse and seam cracks, polished wheel paths and an oil-drip strip down each lane; worn thermoplastic lane lines; concrete gutter pans and curbs. Pacific Coast Highway and Irvine's arterials get Class II bike lanes with the bicycle stencil and arrow.
- **Rider**: a proportioned, articulated rider in a full-face helmet with a tinted visor, a touring jacket with armour and reflective piping, jeans, gloves and boots. Arms are solved with two-bone IK so the hands stay on the grips as the bars turn; the torso hangs into corners and tucks a little at speed; the head looks through the turn and keeps the eyes nearer level than the bike; the left boot goes down when the bike stops. All animation is delta-time based.

## Controls

| Action | Keyboard | Touch | Gamepad |
| --- | --- | --- | --- |
| Throttle | Up / W | Throttle | RT or A |
| Brake | Down / S / Space | Brake | LT |
| Steer | Left, Right / A, D | arrow buttons | left stick |
| Camera | C | camera chip | |
| Cruise / Ride | M (pressing throttle in Cruise hands you the bars) | mode switch | |
| Chapter | 1 to 7 | pin menu | |
| Explore map | G (Esc closes) | minimap | |
| Settings and shortcuts | ? | settings button | |
| Hide HUD / pause | H / P | | |

While the map is open the arrow keys pan it instead of steering, and the ride carries on in the background.

## Run it locally

It is a static site with no build step. Serve the folder over HTTP (ES modules do not load from `file://`):

```sh
cd socal-ride
python3 -m http.server 8000
# open http://localhost:8000/
```

Useful URL parameters: `?s=120` starts at kilometre 120, `?h=16.8` fixes the hour, `?gloom=1` turns on the marine layer, `?q=low|medium|high` picks the quality preset, `?mode=ride` starts in Ride mode.

Quality defaults to Low on phones and High elsewhere; the pixel ratio is capped at 2. The app needs WebGL and loads three.js r147 from cdnjs. Map, places and terrain data ship in `data/`. The only other runtime requests are Google Fonts, and, once you open the explore map, Leaflet and Leaflet.markercluster from cdnjs (with subresource integrity) and OpenStreetMap's standard tiles. The Overpass API is contacted only when you press Refresh area.

## Rebuilding the data

The processed files in `data/` are committed. To regenerate them (Python 3, no extra packages):

```sh
python3 scripts/fetch_roads.py       # OSM road network and coastline via Overpass (cached in raw/)
python3 scripts/fetch_elevation.py   # NOAA ETOPO1 grid via ERDDAP -> data/terrain.bin/.json
python3 scripts/build_route.py       # stitch the route -> data/route.json
python3 scripts/fetch_corridor.py    # buildings, land use, POIs along the route
python3 scripts/build_corridor.py    # -> data/scenery.json
python3 scripts/fetch_places.py      # cafes, food, viewpoints, beaches... within 900 m -> data/places.json
```

`fetch_places.py` queries Overpass in 12 km stretches along the route (cached in `raw/places_*.json`, with a pause between requests) and writes a compact snapshot with name, category, coordinates, distance along the route, and opening hours, cuisine, phone, address and website where OSM has them. Delete the cached `raw/places_*.json` files and re-run it to refresh the snapshot; the live site never queries Overpass on its own.

## Tests

`tests/check.mjs` serves the folder on a free port and drives headless Chromium through Playwright. It checks that WebGL renders, Cruise advances and chapter cards trigger, Ride controls move, steer and brake the bike, the bike stays on the road surface, the rider puts a foot down at a stop, the audio graph builds only after a click and mutes, the theme toggles, the places snapshot loads, the explore map opens with tiles, the route, the rider and places, arrow keys pan the map instead of steering, search, popups, category toggles and Ride here work, Escape closes the map, phones get no horizontal scroll, working touch controls and a minimap that opens the map, and that there are no console errors. It also saves screenshots of every chapter, the sunset coast, dusk, June Gloom and the explore map to `tests/shots/`.

```sh
CHROME_BIN=/path/to/chrome-headless-shell node tests/check.mjs
```

The script resolves Playwright from another local project; change the `createRequire` path at the top if yours lives elsewhere.

## How it is built

- `js/world.js`: ETOPO1 bicubic height field with procedural ridges, a little extra relief on the high ranges, Mount Rubidoux added back (it is too small for a 1-arc-minute grid), and coastline signed distance from OSM for beaches and bluffs.
- `js/route.js`: the route polyline, road attributes, smoothed and grade-limited height profile, bridges where the route crosses itself, and a spatial index.
- `js/ground.js`, `js/terrain.js`: streamed 500 m ground tiles shaped around the road (verges, embankments, cuts) and coloured by zone and OSM land use; the static far terrain hides itself under the near tiles with a mask texture.
- `js/road.js`: road surface with lane markings drawn in the shader, curbs, sidewalks, Jersey barriers, landscaped medians, sound walls and bridges.
- `js/scenery.js`, `js/models.js`: instanced palms, citrus groves, eucalyptus, jacarandas, oaks, oleander, streetlights and signals, plus suburban rooftops.
- `js/buildings.js`, `js/streets.js`: OSM building footprints extruded with area palettes (mission revival, glass offices, beach houses) and side streets.
- `js/bike.js`, `js/ride.js`, `js/camera.js`: the original touring cruiser and rider, the ride dynamics and gears, and the camera rig.
- `js/sky.js`, `js/water.js`, `js/audio.js`, `js/ui.js`, `js/signs.js`, `js/traffic.js`, `js/landmarks.js`: sky and light, ocean and surf, sound, HUD, guide signs, traffic and landmarks.
- `js/places.js`, `js/explore.js`: the places snapshot, the floating 3D place labels, and the Leaflet explore map with clustering, filters, search, popups and the optional Overpass refresh.

## Credits

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License (ODbL). Roads, coastline, buildings, land use, place names and the points of interest in `data/places.json` are derived from OSM. The explore map shows the standard OpenStreetMap tiles (© OpenStreetMap contributors), used lightly and with attribution under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
- Map view: [Leaflet](https://leafletjs.com/) 1.9.4 (BSD-2-Clause) and [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) 1.5.3 (MIT), from cdnjs.
- Elevation: NOAA ETOPO1 Global Relief Model (Amante, C. and B. W. Eakins, 2009, NOAA NGDC), accessed through the NOAA ERDDAP `etopo180` dataset. Public domain.
- Rendering: [three.js](https://threejs.org/) r147 (MIT).
- Fonts: Fraunces, Inter and Overpass from Google Fonts (SIL Open Font License).

The motorcycle, rider, signs and logo are original designs; no real brands or logos are used. Freeway sign shapes follow generic public highway conventions.

## License

Code is released under the MIT License (see `LICENSE`). Data in `data/` derived from OpenStreetMap remains under the ODbL.
