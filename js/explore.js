// Explore map: MapLibre GL with Sentinel-2 satellite imagery, OpenStreetMap
// vector streets, 3D terrain and buildings, the route, the rider's live
// position and every cafe, viewpoint, beach and stop along the way.
// MapLibre loads from cdnjs the first time the map opens.
import { store } from "./util.js";
import { toLatLon, toXZ } from "./world.js";
import { CATS, CAT_ORDER, cuisineLabel, esc, fmtDist, iconSvg, typeLabel } from "./places.js";

const CDN = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.24.0/";
const LIB_CSS = [`${CDN}maplibre-gl.min.css`, "sha512-KIMsMWIdnoG9OwZa+oaIafmbDonqck1UCmq+/zcUi2aaZ97N9QE6TqpTM+n36EO40HGh64hU/375zxtjx7WTyQ=="];
const LIB_JS = [`${CDN}maplibre-gl.min.js`, "sha512-hoXlvOdSmh58mppUyZHZsscHkR/yXl6zLpTMTNwA6IZ61DpeaCNjosRu1WJ2DeIpkfW5MsJJ9H89zjV4IBGqRw=="];

// Keyless sources. OpenFreeMap serves OpenMapTiles vector tiles of OSM with
// the "liberty" style; EOX serves Sentinel-2 cloudless imagery; the AWS Open
// Data terrain tiles carry elevation as terrarium-encoded PNGs.
const STREETS_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const FONTS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const SAT_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";
const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const ATTR_SAT = '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless – https://s2maps.eu</a> by <a href="https://eox.at" target="_blank" rel="noopener">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2016)';
const ATTR_DEM = 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a> (Mapzen, AWS Open Data; USGS 3DEP, SRTM, GMTED2010, ETOPO1)';
const ATTR_OSM = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

const EXAGGERATION = 1.25;
const MAX_PITCH = 70;
const STYLES = ["hybrid", "satellite", "streets"];
// main public instance first, then a community mirror if it is busy
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const LIVE_TTL = 7 * 24 * 3600 * 1000;
const FLY_SPEED = 1100; // metres of route per second in the fly-along preview
const $ = (id) => document.getElementById(id);

// Camera for each chapter: how far along the chapter to centre, which way to
// look, and how steeply, so the mountains, the canyon and the coast read in 3D.
const CHAPTER_VIEWS = [
	{ ds: 2500, bearing: 18, pitch: 66, zoom: 12.3 }, // Redlands, up at the San Bernardino Mountains
	{ ds: 3200, bearing: 292, pitch: 64, zoom: 13.4 }, // Riverside, Mount Rubidoux and the Santa Ana River
	{ ds: 9000, bearing: 232, pitch: 70, zoom: 12.6 }, // Santa Ana Canyon, down the river gap
	{ ds: 1600, bearing: 30, pitch: 60, zoom: 13.0 }, // Fullerton, toward the Puente Hills
	{ ds: 3000, bearing: 62, pitch: 67, zoom: 12.2 }, // Irvine, toward Saddleback and the Santa Anas
	{ ds: 5200, bearing: 128, pitch: 68, zoom: 13.0 }, // Newport Beach, down the coast past Crystal Cove
	{ ds: 2600, bearing: 318, pitch: 70, zoom: 13.4 }, // Laguna Beach, up the coast along the bluffs
];

function loadTag(tag, url, sri) {
	return new Promise((res, rej) => {
		const el = document.createElement(tag);
		if (tag === "link") {
			el.rel = "stylesheet";
			el.href = url;
		} else el.src = url;
		el.integrity = sri;
		el.crossOrigin = "anonymous";
		el.referrerPolicy = "no-referrer";
		el.onload = res;
		el.onerror = () => rej(new Error("Could not load " + url.split("/").pop()));
		document.head.appendChild(el);
	});
}

let libs = null;
function loadMapLibre() {
	if (!libs) {
		libs = Promise.all([loadTag("link", ...LIB_CSS), loadTag("script", ...LIB_JS)]).catch((e) => {
			libs = null;
			throw e;
		});
	}
	return libs;
}

// Same classification as scripts/fetch_places.py, for live refreshes.
function classify(t) {
	const a = t.amenity, sh = t.shop, tour = t.tourism;
	if (a === "cafe") return ["cafe", "cafe"];
	if (["restaurant", "fast_food", "ice_cream", "food_court"].includes(a)) return ["food", a];
	if (sh === "bakery" || sh === "deli") return ["food", sh];
	if (tour === "viewpoint") return ["view", "viewpoint"];
	if (t.natural === "beach") return ["beach", "beach"];
	if (["park", "garden", "nature_reserve"].includes(t.leisure)) return ["park", t.leisure];
	if (sh === "bicycle" || sh === "motorcycle") return ["bike", sh + "_shop"];
	if (a === "bicycle_repair_station") return ["bike", a];
	if (a === "fuel") return ["fuel", "fuel"];
	if (["drinking_water", "toilets", "water_point"].includes(a)) return ["water", a];
	if (["museum", "attraction", "gallery", "artwork"].includes(tour)) return ["sight", tour];
	if (t.historic) return ["sight", "historic_" + t.historic];
	return [null, null];
}
const DEFAULT_NAMES = { drinking_water: "Drinking water", toilets: "Restrooms", water_point: "Water", bicycle_repair_station: "Bike repair station", viewpoint: "Viewpoint", fuel: "Gas station" };

// ---------- colour helpers for the dark streets style ----------
const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };
function parseColor(s) {
	if (typeof s !== "string") return null;
	const t = s.trim().toLowerCase();
	if (NAMED[t]) return NAMED[t].slice();
	let m = /^#([0-9a-f]{3,8})$/.exec(t);
	if (m) {
		let h = m[1];
		if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
		if (h.length !== 6 && h.length !== 8) return null;
		const n = (i) => parseInt(h.slice(i, i + 2), 16);
		return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
	}
	m = /^(rgba?|hsla?)\(([^)]+)\)$/.exec(t);
	if (!m) return null;
	const v = m[2].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
	if (v.length < 3 || v.some(isNaN)) return null;
	const a = v.length > 3 ? v[3] : 1;
	if (m[1].startsWith("rgb")) return [v[0], v[1], v[2], a];
	const [r, g, b] = hslToRgb(v[0] / 360, v[1] / 100, v[2] / 100);
	return [r, g, b, a];
}
function hslToRgb(h, s, l) {
	const f = (n) => {
		const k = (n + h * 12) % 12;
		return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
	};
	return [f(0), f(8), f(4)];
}
function rgbToHsl(r, g, b) {
	r /= 255;
	g /= 255;
	b /= 255;
	const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
	if (mx === mn) return [0, 0, l];
	const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
	const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h / 6, s, l];
}
// Invert lightness, keep hue: light paper becomes a dark slate, dark text light.
function darkColor(s) {
	const c = parseColor(s);
	if (!c) return null;
	const [h, sat, l] = rgbToHsl(c[0], c[1], c[2]);
	const [r, g, b] = hslToRgb(h, sat * 0.6, 0.09 + (1 - l) * 0.78);
	return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+c[3].toFixed(3)})`;
}
function mapColors(v, fn) {
	if (typeof v === "string") return fn(v) ?? v;
	if (Array.isArray(v)) return v.map((x) => mapColors(x, fn));
	return v;
}

// Which part of the liberty style a layer belongs to.
function groupOf(l) {
	const sl = l["source-layer"];
	if (l.type === "background") return "bg";
	if (l.type === "symbol") return sl === "poi" ? "poi" : "label";
	if (sl === "building") return "bld";
	if (sl === "boundary") return "boundary";
	if (sl === "transportation") {
		if (l.type !== "line" || /rail|path|pedestrian|hatching|service_track/.test(l.id)) return "minor";
		return /casing/.test(l.id) ? "casing" : "road";
	}
	return "base";
}

// Category pin drawn once per colour and handed to MapLibre as an image.
function pinImage(cat, ratio) {
	const S = 30 * ratio;
	const cv = document.createElement("canvas");
	cv.width = cv.height = S;
	const g = cv.getContext("2d");
	g.scale(ratio, ratio);
	g.shadowColor = "rgba(0,0,0,0.35)";
	g.shadowBlur = 3;
	g.shadowOffsetY = 1;
	g.fillStyle = "#fff";
	g.beginPath();
	g.arc(15, 15, 13, 0, Math.PI * 2);
	g.fill();
	g.shadowColor = "transparent";
	g.fillStyle = CATS[cat].color;
	g.beginPath();
	g.arc(15, 15, 11, 0, Math.PI * 2);
	g.fill();
	g.translate(15 - 7.5, 15 - 7.5);
	g.scale(15 / 24, 15 / 24);
	g.strokeStyle = "#fff";
	g.lineWidth = 2.2;
	g.lineCap = g.lineJoin = "round";
	g.stroke(new Path2D(CATS[cat].icon));
	return g.getImageData(0, 0, S, S);
}

// A numeric comparison on a missing property logs a warning per feature;
// default the property so the comparison is simply false.
function guardNulls(v) {
	if (!Array.isArray(v)) return v;
	const op = v[0];
	if ((op === "<" || op === "<=" || op === ">" || op === ">=") && Array.isArray(v[1]) && v[1][0] === "get" && v[1].length === 2 && typeof v[2] === "number") {
		return [op, ["coalesce", v[1], op[0] === "<" ? 1e9 : -1e9], v[2]];
	}
	return v.map(guardNulls);
}

const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

export class Explore {
	constructor(app) {
		this.app = app;
		this.places = app.places;
		this.open = false;
		this.map = null;
		this.ready = false;
		this.follow = true;
		this.query = "";
		this.t = 0;
		this.flying = null;
		const st = store.get("mapStyle", "hybrid");
		this.styleName = STYLES.includes(st) ? st : "hybrid";
		this.is3d = store.get("map3d", true) !== false;
		this.el = $("explore");
		this.buildChips();
		this.buildChapters();
		this.bind();
		this.places.onChange(() => {
			this.buildChips();
			if (this.ready) this.refreshMarkers();
		});
		this.syncBar();
	}

	bind() {
		$("ex-close").addEventListener("click", () => this.hide());
		$("ex-follow").addEventListener("click", () => this.setFollow(!this.follow, true));
		$("ex-search").addEventListener("input", (e) => {
			this.query = e.target.value.trim().toLowerCase();
			this.refreshMarkers();
		});
		$("ex-labels").addEventListener("change", (e) => this.places.setLabels(e.target.checked));
		$("ex-labels").checked = this.places.labels3d;
		$("ex-live").addEventListener("click", () => this.liveRefresh());
		$("ex-sheet-toggle").addEventListener("click", () => this.el.classList.toggle("sheet-open"));
		$("ex-style").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => this.setStyle(b.dataset.v)));
		$("ex-3d").addEventListener("click", () => this.set3d(!this.is3d));
		$("ex-overview").addEventListener("click", () => this.overview());
		$("ex-fly").addEventListener("click", () => (this.flying ? this.stopFly() : this.flyRoute()));
		this.el.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				if (this.flying) this.stopFly();
				else this.hide();
				return;
			}
			// arrow keys move the map even when focus is on a button or the panel;
			// the map canvas handles its own keys, and the search box keeps its caret
			const t = e.target;
			const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
			const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
			if (dir && this.ready && !typing && !(t && t.classList && t.classList.contains("maplibregl-canvas"))) {
				e.preventDefault();
				this.stopFly();
				const m = this.map;
				// Shift turns and tilts, as on the map canvas itself
				if (e.shiftKey) m.easeTo({ bearing: m.getBearing() + dir[0] * 15, pitch: Math.max(0, Math.min(m.getMaxPitch(), m.getPitch() - dir[1] * 10)), duration: 250 });
				else {
					this.setFollow(false);
					m.panBy([dir[0] * 120, dir[1] * 120], { duration: 250 });
				}
			}
		});
		const theme = () => this.applyTheme();
		new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		matchMedia("(prefers-color-scheme: dark)").addEventListener("change", theme);
	}

	buildChips() {
		const box = $("ex-cats");
		const counts = this.places.counts();
		box.innerHTML = "";
		for (const k of CAT_ORDER) {
			const c = CATS[k];
			const b = document.createElement("button");
			b.className = "cat" + (this.places.enabled.has(k) ? " on" : "");
			b.style.setProperty("--c", c.color);
			b.setAttribute("aria-pressed", this.places.enabled.has(k));
			b.innerHTML = `${iconSvg(k, 15)}<span>${c.label}</span><small>${counts[k]}</small>`;
			b.addEventListener("click", () => this.places.setEnabled(k, !this.places.enabled.has(k)));
			box.appendChild(b);
		}
		const all = document.createElement("button");
		all.className = "cat all";
		const allOn = this.places.enabled.size === CAT_ORDER.length;
		all.textContent = allOn ? "Hide all" : "Show all";
		all.addEventListener("click", () => {
			for (const k of CAT_ORDER) if (allOn ? this.places.enabled.has(k) : !this.places.enabled.has(k)) this.places.setEnabled(k, !allOn);
		});
		box.appendChild(all);
	}

	buildChapters() {
		const box = $("ex-chaps");
		box.innerHTML = "";
		this.app.route.chapters.forEach((c, k) => {
			const b = document.createElement("button");
			b.className = "chap";
			b.title = `Fly to ${c.name} in 3D`;
			b.innerHTML = `<span>${k + 1}</span>${esc(c.name)}`;
			b.addEventListener("click", () => {
				this.flyChapter(k);
				this.el.classList.remove("sheet-open");
			});
			box.appendChild(b);
		});
	}

	syncBar() {
		$("ex-style").querySelectorAll("button").forEach((b) => {
			const on = b.dataset.v === this.styleName;
			b.classList.toggle("active", on);
			b.setAttribute("aria-checked", on);
		});
		const b3 = $("ex-3d");
		b3.classList.toggle("active", this.is3d);
		b3.setAttribute("aria-pressed", this.is3d);
		b3.textContent = this.is3d ? "3D" : "2D";
		$("ex-fly").innerHTML = this.flying ? '<span class="l">Stop flying</span><span class="s">Stop</span>' : '<span class="l">Fly the route</span><span class="s">Fly</span>';
		b3.title = this.is3d ? "3D terrain on. Switch to a flat 2D map" : "Flat 2D map. Switch to 3D terrain";
		const fb = $("ex-fly");
		fb.classList.toggle("active", !!this.flying);
		fb.setAttribute("aria-pressed", !!this.flying);
	}

	toggle() {
		this.open ? this.hide() : this.show();
	}

	async show(focus = null) {
		this.open = true;
		this.el.hidden = false;
		document.body.classList.add("exploring");
		this.app.ui.close();
		$("ex-status").textContent = "Loading map";
		try {
			await loadMapLibre();
		} catch (e) {
			$("ex-status").textContent = e.message + ". Check your connection and try again.";
			return;
		}
		if (!this.open) return;
		if (!this.map) await this.init();
		if (!this.open || !this.map) return;
		this.map.resize();
		$("ex-status").textContent = "";
		if (focus) this.focus(focus);
		else if (this.follow) this.map.jumpTo({ center: this.riderLngLat(), zoom: Math.max(this.map.getZoom(), 13.6) });
		this.updateRider(true);
		this.renderList();
		// keyboard users land in the search box; phones keep the keyboard closed
		if (!this.app.ui.touchDev) setTimeout(() => $("ex-search").focus({ preventScroll: true }), 50);
		else $("ex-close").focus({ preventScroll: true });
	}

	hide() {
		this.open = false;
		this.stopFly();
		this.el.hidden = true;
		document.body.classList.remove("exploring");
		if (this.popup) this.popup.remove();
		const b = $("map-wrap");
		if (b) b.focus({ preventScroll: true });
	}

	riderLngLat() {
		const p = this.app.bike.root.position;
		const [la, lo] = toLatLon(p.x, p.z);
		return [lo, la];
	}

	routeLngLat(s) {
		const P = this.app.route.at(Math.max(0, Math.min(this.app.route.length, s)));
		const [la, lo] = toLatLon(P.x, P.z);
		return [lo, la];
	}

	isDark() {
		const t = document.documentElement.dataset.theme;
		return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
	}

	// ---------- style ----------
	async fetchStreets() {
		try {
			const r = await fetch(STREETS_STYLE);
			if (!r.ok) throw new Error(r.status);
			return await r.json();
		} catch (e) {
			console.warn("Street style unavailable, showing satellite only:", e.message);
			return null;
		}
	}

	buildStyle(base) {
		const sources = {
			sat: { type: "raster", tiles: [SAT_TILES], tileSize: 256, minzoom: 0, maxzoom: 14, attribution: ATTR_SAT },
			// one DEM source for the 3D mesh and one for hillshade, as MapLibre recommends
			dem: { type: "raster-dem", tiles: [DEM_TILES], encoding: "terrarium", tileSize: 256, maxzoom: 14, attribution: ATTR_DEM },
			"dem-hs": { type: "raster-dem", tiles: [DEM_TILES], encoding: "terrarium", tileSize: 256, maxzoom: 14 },
		};
		const below = [], above = [], labels = [];
		this.groups = {};
		if (base) {
			for (const [k, v] of Object.entries(base.sources)) {
				sources[k] = v;
				if (v.type === "vector") v.attribution = ATTR_OSM;
			}
			for (const l of base.layers) {
				if (l.filter) l.filter = guardNulls(l.filter);
				const g = groupOf(l);
				(this.groups[g] = this.groups[g] || []).push(l.id);
				if (g === "label" || g === "poi") labels.push(l);
				else if (g === "bg" || g === "base") below.push(l);
				else above.push(l);
			}
		} else {
			below.push({ id: "background", type: "background", paint: { "background-color": "#3b4a3c" } });
			this.groups.bg = ["background"];
		}
		const layers = [
			...below,
			{ id: "sat", type: "raster", source: "sat", paint: { "raster-fade-duration": 200 } },
			{ id: "hillshade", type: "hillshade", source: "dem-hs", paint: {} },
			...above,
			{ id: "rt-casing", type: "line", source: "route-ahead", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-opacity": 0.7, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 14, 9, 18, 16] } },
			{ id: "rt-casing-done", type: "line", source: "route-done", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-opacity": 0.75, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 14, 10, 18, 17] } },
			{ id: "rt-ahead", type: "line", source: "route-ahead", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#1f7f8a", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 14, 4.5, 18, 9] } },
			{ id: "rt-done", type: "line", source: "route-done", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#e2692c", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 14, 5.5, 18, 10] } },
			...labels,
		];
		Object.assign(sources, {
			"route-ahead": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
			"route-done": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
			places: {
				type: "geojson",
				data: { type: "FeatureCollection", features: [] },
				cluster: true,
				clusterRadius: 54,
				clusterMaxZoom: 15,
				clusterProperties: Object.fromEntries(CAT_ORDER.map((k) => [k, ["+", ["case", ["==", ["get", "c"], k], 1, 0]]])),
			},
		});
		// cluster colour: the category with the most places in it
		const top = ["case"];
		for (const k of CAT_ORDER) {
			top.push(["all", ...CAT_ORDER.filter((j) => j !== k).map((j) => [">=", ["get", k], ["get", j]])], CATS[k].color);
		}
		top.push("#555");
		layers.push(
			{ id: "pl-cluster", type: "circle", source: "places", filter: ["has", "point_count"], paint: { "circle-color": top, "circle-radius": ["step", ["get", "point_count"], 14, 10, 17, 50, 21], "circle-stroke-color": "rgba(255,255,255,0.9)", "circle-stroke-width": 3, "circle-pitch-alignment": "viewport", "circle-pitch-scale": "viewport" } },
			{ id: "pl-count", type: "symbol", source: "places", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#ffffff" } },
			{ id: "pl-pin", type: "symbol", source: "places", filter: ["!", ["has", "point_count"]], layout: { "icon-image": ["concat", "pin-", ["get", "c"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 1], "icon-allow-overlap": true, "icon-ignore-placement": true, "text-field": ["step", ["zoom"], "", 16, ["get", "n"]], "text-font": ["Noto Sans Regular"], "text-size": 11.5, "text-anchor": "top", "text-offset": [0, 1.25], "text-max-width": 9, "text-optional": true }, paint: { "text-color": "#1d2327", "text-halo-color": "rgba(255,255,255,0.92)", "text-halo-width": 1.4 } },
		);
		return {
			version: 8,
			name: "Citrus to Surf",
			glyphs: (base && base.glyphs) || FONTS,
			sprite: base && base.sprite,
			sources,
			layers,
			light: { anchor: "map", position: [1.3, 210, 40], intensity: 0.35, color: "#ffffff" },
		};
	}

	async init() {
		const ml = window.maplibregl;
		const base = await this.fetchStreets();
		if (!this.open) return;
		this.hasStreets = !!base;
		if (!base && this.styleName === "streets") this.styleName = "hybrid";
		$("ex-style").querySelector('[data-v="streets"]').disabled = !base;
		$("ex-style").querySelector('[data-v="hybrid"]').disabled = !base;
		if (!base) this.styleName = "satellite";
		const style = this.buildStyle(base);
		if (!style.sprite) delete style.sprite;
		const center = this.riderLngLat();
		const map = new ml.Map({
			container: "ex-map",
			style,
			center,
			zoom: 13.6,
			pitch: this.is3d ? 55 : 0,
			maxPitch: this.is3d ? MAX_PITCH : 0,
			minZoom: 8,
			maxZoom: 19,
			maxBounds: [[-119.2, 32.7], [-115.9, 35.0]],
			pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
			attributionControl: false,
			fadeDuration: 150,
			cancelPendingTileRequestsWhileZooming: true,
		});
		this.map = map;
		this.ml = ml;
		const attrib = new ml.AttributionControl({ compact: innerWidth < 760 || innerHeight < 500 });
		map.addControl(attrib, "bottom-right");
		map.addControl(new ml.NavigationControl({ visualizePitch: true, showCompass: true, showZoom: true }), "bottom-right");
		map.addControl(new ml.ScaleControl({ unit: "imperial", maxWidth: 110 }), "bottom-left");
		this.pad();
		addEventListener("resize", () => this.map && this.pad());
		map.on("error", (e) => {
			// a missing tile or a busy server should not break the map
			console.warn("Map:", (e.error && e.error.message) || e.type);
		});
		map.on("styleimagemissing", (e) => {
			if (!e.id.startsWith("pin-")) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
		});
		await new Promise((res) => (map.loaded() ? res() : map.once("load", res)));
		const ratio = 2;
		for (const k of CAT_ORDER) map.addImage("pin-" + k, pinImage(k, ratio), { pixelRatio: ratio });
		this.captureOriginals();
		this.applyStyle();
		this.applyTheme();
		if (this.is3d) map.setTerrain({ source: "dem", exaggeration: EXAGGERATION });
		this.addRouteAndMarkers();
		this.wireEvents();
		this.ready = true;
		// on small screens the credits fold into the (i) button after a moment;
		// they stay one tap away, and in full at the foot of the places sheet
		if (innerWidth < 760 || innerHeight < 500) setTimeout(() => attrib._container && attrib._container.classList.remove("maplibregl-compact-show"), 4000);
		this.refreshMarkers();
		this.updateLiveButton();
	}

	// Keep the map's focal point clear of the side panel (desktop) or the
	// bottom sheet and toolbar (phone), so centring on the rider looks centred.
	pad() {
		const side = $("ex-side").getBoundingClientRect();
		const phone = innerWidth <= 600;
		this.map.setPadding(phone ? { top: 100, bottom: Math.round(side.height), left: 0, right: 0 } : { top: 60, bottom: 0, left: Math.round(side.right), right: 0 });
	}

	captureOriginals() {
		this.orig = {};
		const st = this.map.getStyle();
		for (const l of st.layers) this.orig[l.id] = { paint: JSON.parse(JSON.stringify(l.paint || {})), group: Object.keys(this.groups).find((g) => this.groups[g].includes(l.id)) };
		this.applied = {};
		this.appliedProps = {};
	}

	setPaint(id, prop, val) {
		const key = id + "|" + prop, j = JSON.stringify(val);
		if (this.applied[key] === j) return;
		this.applied[key] = j;
		this.map.setPaintProperty(id, prop, val === undefined ? null : val);
	}

	setVis(ids, on) {
		for (const id of ids || []) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
	}

	setStyle(name) {
		if (!STYLES.includes(name) || (name !== "satellite" && !this.hasStreets && this.map)) return;
		this.styleName = name;
		store.set("mapStyle", name);
		this.syncBar();
		if (this.ready) {
			this.applyStyle();
			this.applyTheme();
		}
	}

	// Satellite: imagery only. Hybrid: imagery with roads and labels drawn over
	// it, easing toward the street map at close zoom where 10 m imagery blurs.
	// Streets: the OpenStreetMap vector style.
	applyStyle() {
		const G = this.groups, s = this.styleName;
		const sat = s !== "streets", hyb = s === "hybrid", str = s === "streets";
		this.setVis(["sat"], sat);
		this.setVis(G.base, str || hyb);
		this.setVis(G.road, str || hyb);
		this.setVis(G.casing, str);
		this.setVis(G.minor, str);
		this.setVis(G.boundary, str);
		this.setVis(G.label, str || hyb);
		this.setVis(G.poi, false);
		this.setVis(G.bld, true);
		this.flatBuildings(!this.is3d);
	}

	applyTheme() {
		const m = this.map;
		if (!this.ready && !m) return;
		if (!m || !this.orig) return;
		const dark = this.isDark(), s = this.styleName, hyb = s === "hybrid", str = s === "streets";
		const ramp = (z0, v0, z1, v1) => ["interpolate", ["linear"], ["zoom"], z0, v0, z1, v1];
		for (const [id, o] of Object.entries(this.orig)) {
			const g = o.group;
			if (!g) continue;
			const type = m.getLayer(id).type;
			// start from the style's own paint (recoloured for dark streets), then override
			const want = {};
			for (const [prop, v] of Object.entries(o.paint)) want[prop] = str && dark ? mapColors(v, darkColor) : v;
			// sprite patterns (wetland, scrub) cannot be recoloured; let them recede
			if (str && dark && type === "fill" && o.paint["fill-pattern"]) want["fill-opacity"] = 0.12;
			if (hyb && g === "label") {
				want["text-color"] = id.startsWith("water") ? "#d4ecff" : "#ffffff";
				want["text-halo-color"] = "rgba(12,16,20,0.85)";
				want["text-halo-width"] = 1.4;
				want["text-halo-blur"] = 0.5;
			}
			if (hyb && g === "road") want["line-opacity"] = ["interpolate", ["linear"], ["zoom"], 8, 0.3, 12, 0.45, 16, 0.75];
			// the street map underneath shows through only where the imagery runs out of detail
			if (hyb && g === "base") {
				if (type === "fill") want["fill-opacity"] = ramp(15, 0, 17.5, 0.85);
				else if (type === "line") want["line-opacity"] = ramp(14, 0, 16, 1);
				else if (type === "raster") want["raster-opacity"] = 0;
			}
			if (g === "bld" && type === "fill-extrusion" && !str) {
				want["fill-extrusion-color"] = dark ? "#b9b2a6" : "#ebe5da";
				want["fill-extrusion-opacity"] = 0.9;
			} else if (g === "bld" && type === "fill-extrusion" && dark) {
				want["fill-extrusion-color"] = "#3a4148";
				want["fill-extrusion-opacity"] = 0.85;
			}
			if (g === "bld" && type === "fill" && !str) {
				want["fill-color"] = dark ? "#9c968c" : "#ddd6ca";
				want["fill-opacity"] = this.is3d ? 0 : ramp(14.5, 0, 16, 0.6);
			}
			const prev = this.appliedProps[id] || new Set();
			for (const prop of prev) if (!(prop in want)) this.setPaint(id, prop, undefined);
			for (const [prop, v] of Object.entries(want)) this.setPaint(id, prop, v);
			this.appliedProps[id] = new Set(Object.keys(want));
		}
		// imagery a touch crisper; dimmer at night so the panels do not glare
		this.setPaint("sat", "raster-opacity", hyb ? ["interpolate", ["linear"], ["zoom"], 15.5, 1, 17.5, 0.45] : 1);
		this.setPaint("sat", "raster-contrast", 0.08);
		this.setPaint("sat", "raster-saturation", 0.08);
		this.setPaint("sat", "raster-brightness-max", dark ? 0.78 : 1);
		this.setPaint("hillshade", "hillshade-exaggeration", str ? 0.38 : 0.16);
		this.setPaint("hillshade", "hillshade-shadow-color", dark ? "#05080b" : "#3b3a36");
		this.setPaint("hillshade", "hillshade-highlight-color", dark ? "#2a3138" : "#fffaf0");
		this.setPaint("hillshade", "hillshade-accent-color", dark ? "#0c1014" : "#5c5a52");
		this.setPaint("pl-pin", "text-color", dark || !str ? "#ffffff" : "#1d2327");
		this.setPaint("pl-pin", "text-halo-color", dark || !str ? "rgba(12,16,20,0.85)" : "rgba(255,255,255,0.92)");
		this.setPaint("rt-casing", "line-color", dark && str ? "#0c1014" : "#ffffff");
		this.setPaint("rt-casing-done", "line-color", dark && str ? "#0c1014" : "#ffffff");
		this.setPaint("rt-ahead", "line-color", dark ? "#3fb3bd" : "#1f7f8a");
		// hazy Southern California sky by day, a deep blue dusk in dark mode
		m.setSky(dark
			? { "sky-color": "#0c1a2e", "horizon-color": "#30445e", "fog-color": "#1a2636", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.35, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 1, 12, 0] }
			: { "sky-color": "#7fb0dd", "horizon-color": "#dfe8ee", "fog-color": "#e3e6e4", "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.3, "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 1, 12, 0] });
		m.setLight({ anchor: "map", position: [1.3, 210, 40], intensity: dark ? 0.25 : 0.35, color: dark ? "#c8d4e6" : "#ffffff" });
	}

	set3d(on) {
		this.is3d = on;
		store.set("map3d", on);
		this.syncBar();
		if (!this.ready) return;
		const m = this.map;
		if (on) {
			m.setMaxPitch(MAX_PITCH);
			m.setTerrain({ source: "dem", exaggeration: EXAGGERATION });
			this.setVis(this.groups.bld && this.groups.bld.filter((id) => m.getLayer(id).type === "fill-extrusion"), true);
			if (m.getPitch() < 20) m.easeTo({ pitch: 55, duration: 900 });
		} else {
			this.stopFly();
			m.setTerrain(null);
			m.easeTo({ pitch: 0, bearing: 0, duration: 700 });
			setTimeout(() => !this.is3d && m.setMaxPitch(0), 720);
		}
		this.flatBuildings(!on);
		this.applyTheme();
	}

	// In 2D the flat footprints carry on past zoom 14 instead of extruding.
	flatBuildings(flat) {
		const m = this.map;
		for (const id of this.groups.bld || []) {
			const l = m.getLayer(id);
			if (l.type === "fill") m.setLayerZoomRange(id, 13, flat ? 24 : 14);
			if (l.type === "fill-extrusion") m.setLayoutProperty(id, "visibility", flat ? "none" : "visible");
		}
	}

	addRouteAndMarkers() {
		const ml = this.ml, map = this.map, r = this.app.route;
		const pts = [];
		for (let i = 0; i < r.n; i += 4) {
			const [la, lo] = toLatLon(r.X[i], r.Z[i]);
			pts.push([+lo.toFixed(6), +la.toFixed(6)]);
		}
		this.routePts = pts;
		let w = 180, e = -180, s = 90, n = -90;
		for (const [lo, la] of pts) {
			w = Math.min(w, lo);
			e = Math.max(e, lo);
			s = Math.min(s, la);
			n = Math.max(n, la);
		}
		this.routeBounds = [[w, s], [e, n]];
		this.chapterMarkers = r.chapters.map((c, k) => {
			const el = document.createElement("button");
			el.className = "ex-chapter";
			el.title = `${k + 1}. ${c.name}: fly here in 3D`;
			el.setAttribute("aria-label", el.title);
			el.innerHTML = `<span>${k + 1}</span><em>${esc(c.name)}</em>`;
			el.addEventListener("click", (ev) => {
				ev.stopPropagation();
				this.flyChapter(k, true);
			});
			return new ml.Marker({ element: el, anchor: "left", offset: [-12, 0], opacityWhenCovered: 0.55 }).setLngLat(this.routeLngLat(c.s)).addTo(map);
		});
		const rel = document.createElement("div");
		rel.className = "ex-rider";
		rel.title = "You are here";
		rel.innerHTML = '<i class="cone"></i><i class="dot"></i>';
		this.rider = new ml.Marker({ element: rel, rotationAlignment: "map", pitchAlignment: "map", opacityWhenCovered: 1 }).setLngLat(this.riderLngLat()).addTo(map);
		this.popup = new ml.Popup({ closeButton: true, maxWidth: "290px", offset: 16, className: "ex-pop", focusAfterOpen: false });
		this.popup.on("open", () => this.wirePopup());
	}

	wireEvents() {
		const map = this.map;
		map.on("dragstart", () => {
			this.setFollow(false);
			this.stopFly();
		});
		for (const ev of ["mousedown", "touchstart", "wheel"]) map.getCanvasContainer().addEventListener(ev, () => this.flying && this.stopFly(), { passive: true });
		// a keyboard pan is the user taking over too
		map.on("movestart", (e) => {
			if (e.originalEvent && e.originalEvent.type === "keydown" && /^Arrow/.test(e.originalEvent.key) && !e.originalEvent.shiftKey) this.setFollow(false);
		});
		map.on("moveend", () => this.renderList());
		map.on("zoomend", () => this.updateLiveButton());
		map.on("click", "pl-pin", (e) => {
			const f = e.features && e.features[0];
			const p = f && this.places.byId.get(f.properties.id);
			if (p) this.openPlace(p);
		});
		map.on("click", "pl-cluster", async (e) => {
			const f = e.features && e.features[0];
			if (!f) return;
			this.setFollow(false);
			try {
				const z = await map.getSource("places").getClusterExpansionZoom(f.properties.cluster_id);
				map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.3, 18), duration: 600 });
			} catch (err) {
				map.easeTo({ center: f.geometry.coordinates, zoom: map.getZoom() + 2 });
			}
		});
		for (const id of ["pl-pin", "pl-cluster"]) {
			map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
			map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
		}
	}

	visible(p) {
		return this.places.enabled.has(p.c) && (!this.query || p.n.toLowerCase().includes(this.query) || typeLabel(p).toLowerCase().includes(this.query) || (p.cu || "").includes(this.query));
	}

	refreshMarkers() {
		if (!this.ready) return;
		const features = [];
		for (const p of this.places.list) {
			if (!this.visible(p)) continue;
			features.push({ type: "Feature", geometry: { type: "Point", coordinates: [p.lo, p.la] }, properties: { id: p.id, c: p.c, n: p.n } });
		}
		this.placeData = { type: "FeatureCollection", features };
		this.map.getSource("places").setData(this.placeData);
		this.shown = features.length;
		this.renderList();
	}

	popupHtml(p) {
		const app = this.app;
		const bp = app.bike.root.position;
		const d = Math.hypot(p.x - bp.x, p.z - bp.z);
		const along = p.s - app.rider.s;
		const rows = [];
		const cu = cuisineLabel(p);
		if (cu) rows.push(`<div class="pp-row">${esc(cu)}</div>`);
		if (p.a) rows.push(`<div class="pp-row">${esc(p.a)}</div>`);
		if (p.h) rows.push(`<div class="pp-row"><b>Hours</b> ${esc(p.h.replace(/;\s*/g, "; "))}</div>`);
		if (p.ph) rows.push(`<div class="pp-row"><b>Phone</b> <a href="tel:${esc(p.ph.replace(/[^+\d]/g, ""))}">${esc(p.ph)}</a></div>`);
		if (p.os) rows.push(`<div class="pp-row">Outdoor seating</div>`);
		const links = [];
		if (p.w) links.push(`<a href="${esc(p.w)}" target="_blank" rel="noopener nofollow">Website</a>`);
		const kind = { n: "node", w: "way", r: "relation" }[p.id[0]];
		if (kind) links.push(`<a href="https://www.openstreetmap.org/${kind}/${p.id.slice(1)}" target="_blank" rel="noopener">OpenStreetMap</a>`);
		const where = along > 50 ? `${fmtDist(along)} ahead on the route` : along < -50 ? `${fmtDist(-along)} behind you` : "right here";
		return `<div class="pp">
			<div class="pp-kind" style="--c:${CATS[p.c].color}">${iconSvg(p.c, 13)}${esc(typeLabel(p))}</div>
			<div class="pp-name">${esc(p.n)}</div>
			<div class="pp-dist">${fmtDist(d)} away · ${where}</div>
			${rows.join("")}
			<div class="pp-links">${links.join(" · ")}</div>
			<button class="pp-go primary" data-s="${p.s}">Ride here</button>
		</div>`;
	}

	openPlace(p) {
		this.popup.setLngLat([p.lo, p.la]).setHTML(this.popupHtml(p)).addTo(this.map);
		this.wirePopup();
	}

	wirePopup() {
		const el = this.popup.getElement();
		const b = el && el.querySelector(".pp-go");
		if (b && !b.dataset.wired) {
			b.dataset.wired = "1";
			b.addEventListener("click", () => this.rideTo(parseFloat(b.dataset.s) - (b.dataset.exact ? 0 : 120)));
		}
	}

	async rideTo(s) {
		this.hide();
		await this.app.jumpTo(Math.max(0, s));
	}

	focus(p) {
		if (!this.places.enabled.has(p.c)) this.places.setEnabled(p.c, true);
		this.setFollow(false);
		this.stopFly();
		const m = this.map;
		const zoom = Math.max(m.getZoom(), 16.2);
		if (m.getZoom() < 13 || !m.getBounds().contains([p.lo, p.la])) m.jumpTo({ center: [p.lo, p.la], zoom });
		else m.easeTo({ center: [p.lo, p.la], zoom, duration: 700 });
		this.openPlace(p);
	}

	setFollow(on, recenter) {
		this.follow = on;
		$("ex-follow").classList.toggle("active", on);
		$("ex-follow").setAttribute("aria-pressed", on);
		if (on && recenter && this.ready) {
			this.stopFly();
			this.map.easeTo({ center: this.riderLngLat(), zoom: Math.max(this.map.getZoom(), 14), duration: 700 });
		}
	}

	updateRider(force) {
		if (!this.ready) return;
		const app = this.app, map = this.map;
		const ll = this.riderLngLat();
		this.rider.setLngLat(ll);
		const P = app.route.at(app.rider.s);
		this.rider.setRotation((Math.atan2(P.tx, -P.tz) * 180) / Math.PI);
		const k = Math.min(this.routePts.length - 1, Math.floor(app.rider.s / app.route.step / 4));
		if (force || k !== this._k) {
			this._k = k;
			const line = (c) => ({ type: "Feature", geometry: { type: "LineString", coordinates: c.length > 1 ? c : [ll, ll] }, properties: {} });
			this.routeData = { done: line(this.routePts.slice(0, k + 1).concat([ll])), ahead: line([ll].concat(this.routePts.slice(k + 1))) };
			map.getSource("route-done").setData(this.routeData.done);
			map.getSource("route-ahead").setData(this.routeData.ahead);
		}
		if (this.follow && !this.flying && !map.isMoving()) {
			const pt = map.project(ll), c = map.getCanvas(), w = c.clientWidth, h = c.clientHeight;
			if (force || Math.abs(pt.x - w / 2) > w * 0.18 || Math.abs(pt.y - h / 2) > h * 0.18) map.easeTo({ center: ll, duration: force ? 0 : 600 });
		}
	}

	// ---------- 3D camera moves ----------
	chapterCamera(k) {
		const r = this.app.route, c = r.chapters[k], v = CHAPTER_VIEWS[k] || { ds: 1500, bearing: 0, pitch: 60, zoom: 13 };
		const next = r.chapters[k + 1] ? r.chapters[k + 1].s : r.length;
		const s = Math.min(c.s + v.ds, next - 200);
		const narrow = innerWidth < 600 ? 0.6 : 0;
		return { center: this.routeLngLat(s), zoom: v.zoom - narrow, pitch: this.is3d ? v.pitch : 0, bearing: this.is3d ? v.bearing : 0, s };
	}

	flyChapter(k, withPopup) {
		if (!this.ready) return;
		this.stopFly();
		this.setFollow(false);
		const cam = this.chapterCamera(k);
		const c = this.app.route.chapters[k];
		this.popup.remove();
		this.map.flyTo({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing, duration: 3200, curve: 1.3, essential: true });
		if (withPopup) {
			const s0 = c.s + (k === 0 ? 0 : 60);
			this.map.once("moveend", () => {
				if (!this.open) return;
				this.popup.setLngLat(this.routeLngLat(c.s)).setHTML(`<div class="pp"><div class="pp-kind" style="--c:#1d2327">Chapter ${k + 1}</div><div class="pp-name">${esc(c.name)}</div><button class="pp-go primary" data-s="${s0}" data-exact="1">Ride from here</button></div>`).addTo(this.map);
				this.wirePopup();
			});
		}
	}

	overview() {
		if (!this.ready) return;
		this.stopFly();
		this.setFollow(false);
		this.popup.remove();
		const m = this.map;
		const bearing = this.is3d ? 38 : 0;
		const pad = innerWidth <= 600 ? { top: 30, bottom: 30, left: 24, right: 24 } : { top: 60, bottom: 50, left: 50, right: 70 };
		const cam = m.cameraForBounds(this.routeBounds, { padding: pad, bearing });
		if (!cam) return;
		m.flyTo({ center: cam.center, zoom: cam.zoom - (this.is3d ? 0.35 : 0), bearing, pitch: this.is3d ? 52 : 0, duration: 2400, essential: true });
	}

	// Cinematic preview: the camera flies the whole ride, banking with the
	// road, at a fixed height over the terrain. Any touch, drag or wheel stops it.
	flyRoute() {
		if (!this.ready) return;
		this.popup.remove();
		this.setFollow(false);
		if (!this.is3d) this.set3d(true);
		const r = this.app.route;
		const narrow = innerWidth < 600;
		const F = { s: 0, bearing: null, last: 0, zoom: narrow ? 12.6 : 13.1, pitch: 66, chapter: -1 };
		this.flying = F;
		this.syncBar();
		// a clean view for the cinematic; the places come back when it stops
		this.setVis(["pl-cluster", "pl-count", "pl-pin"], false);
		const start = this.routeLngLat(0);
		const b0 = this.routeBearing(0);
		F.bearing = b0;
		this.map.flyTo({ center: start, zoom: F.zoom, pitch: F.pitch, bearing: b0, duration: 2200, essential: true });
		this.map.once("moveend", () => {
			if (this.flying !== F) return;
			const step = (now) => {
				if (this.flying !== F || !this.open) return;
				const dt = F.last ? Math.min(0.05, (now - F.last) / 1000) : 0;
				F.last = now;
				F.s += dt * FLY_SPEED;
				if (F.s >= r.length - 300) {
					this.stopFly();
					$("ex-status").textContent = "You flew the whole ride. Pick a chapter or Ride here to go.";
					setTimeout(() => $("ex-status").textContent.startsWith("You flew") && ($("ex-status").textContent = ""), 5000);
					return;
				}
				const tb = this.routeBearing(F.s);
				F.bearing += angleDiff(tb, F.bearing) * (1 - Math.exp(-dt * 0.9));
				this.map.jumpTo({ center: this.routeLngLat(F.s), bearing: F.bearing, pitch: F.pitch, zoom: F.zoom });
				const ck = r.chapterAt(F.s);
				if (ck !== F.chapter) {
					F.chapter = ck;
					$("ex-status").textContent = `Flying the route · ${ck + 1}. ${r.chapters[ck].name}`;
				}
				F.raf = requestAnimationFrame(step);
			};
			F.raf = requestAnimationFrame(step);
		});
	}

	// Compass bearing of the road a little way ahead, so the camera looks
	// down the route rather than twitching with every bend.
	routeBearing(s) {
		const r = this.app.route;
		const a = r.at(s), b = r.at(Math.min(r.length, s + 2600));
		return (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
	}

	stopFly() {
		if (!this.flying) return;
		cancelAnimationFrame(this.flying.raf);
		this.flying = null;
		this.syncBar();
		this.setVis(["pl-cluster", "pl-count", "pl-pin"], true);
		if ($("ex-status").textContent.startsWith("Flying")) $("ex-status").textContent = "";
		this.renderList();
	}

	renderList() {
		if (!this.ready || !this.open || this.flying) return;
		const map = this.map;
		const b = map.getBounds();
		const app = this.app, bp = app.bike.root.position;
		const ll = this.riderLngLat();
		// a search covers the whole route; browsing lists what is in view
		const all = !!this.query;
		const ref = all || b.contains(ll) ? { x: bp.x, z: bp.z } : null;
		const c = map.getCenter();
		const items = [];
		for (const p of this.places.list) {
			if (!this.visible(p) || (!all && !b.contains([p.lo, p.la]))) continue;
			const d = ref ? Math.hypot(p.x - ref.x, p.z - ref.z) : c.distanceTo(new this.ml.LngLat(p.lo, p.la));
			items.push({ p, d });
		}
		items.sort((a, b2) => a.d - b2.d);
		const ul = $("ex-list");
		const n = items.length, pl = `${n} place${n === 1 ? "" : "s"}`;
		$("ex-count").textContent = all ? (n ? `${pl} along the route match, nearest first` : "Nothing along the route matches. Try another word or turn on more categories.") : n ? `${pl} in view${ref ? ", nearest to you first" : ""}` : "No places in this view. Zoom out or turn on more categories.";
		ul.innerHTML = "";
		for (const { p, d } of items.slice(0, 80)) {
			const li = document.createElement("li");
			const btn = document.createElement("button");
			const type = typeLabel(p);
			const sub = (type.toLowerCase() !== p.n.toLowerCase() ? type : "Near " + app.route.nameAt(p.s)) + (p.h ? " · " + p.h.slice(0, 40) : "");
			btn.innerHTML = `<span class="li-ic" style="--c:${CATS[p.c].color}">${iconSvg(p.c, 14)}</span><span class="li-t"><b>${esc(p.n)}</b><small>${esc(sub)}</small></span><span class="li-d">${fmtDist(d)}</span>`;
			btn.addEventListener("click", () => {
				this.focus(p);
				this.el.classList.remove("sheet-open");
			});
			li.appendChild(btn);
			ul.appendChild(li);
		}
	}

	updateLiveButton() {
		const b = $("ex-live");
		const z = this.map ? this.map.getZoom() : 0;
		b.disabled = z < 13;
		b.title = z < 13 ? "Zoom in to refresh this area from OpenStreetMap" : "Fetch the latest places in this view from OpenStreetMap";
	}

	// Optional live refresh of the current view from the Overpass API, cached
	// per area for a week so the public server is not hit repeatedly. A tilted
	// view can reach the horizon, so the box is capped around the centre.
	async liveRefresh() {
		if (!this.ready || this.map.getZoom() < 13) return;
		const b = this.map.getBounds(), c = this.map.getCenter();
		const r2 = (v) => Math.round(v * 50) / 50;
		const S = Math.max(b.getSouth(), c.lat - 0.05), N = Math.min(b.getNorth(), c.lat + 0.05);
		const W = Math.max(b.getWest(), c.lng - 0.06), E = Math.min(b.getEast(), c.lng + 0.06);
		const bbox = [r2(S) - 0.01, r2(W) - 0.01, r2(N) + 0.01, r2(E) + 0.01].map((v) => v.toFixed(3)).join(",");
		const key = "ovp." + bbox;
		const status = $("ex-status");
		let list = null;
		const cached = store.get(key, null);
		if (cached && Date.now() - cached.t < LIVE_TTL) list = cached.list;
		if (!list) {
			status.textContent = "Asking OpenStreetMap for the latest places in this view";
			const sel = ['["amenity"~"^(cafe|restaurant|fast_food|ice_cream|food_court|fuel|drinking_water|toilets|water_point|bicycle_repair_station)$"]', '["shop"~"^(bakery|deli|bicycle|motorcycle)$"]', '["tourism"~"^(viewpoint|museum|attraction|gallery|artwork)$"]', '["natural"="beach"]["name"]', '["leisure"~"^(park|garden|nature_reserve)$"]["name"]', '["historic"]["name"]'];
			const q = `[out:json][timeout:25];(${sel.map((s) => `nwr${s}(${bbox});`).join("")});out center tags 600;`;
			try {
				let res = null;
				for (const url of OVERPASS) {
					const ac = new AbortController();
					const timer = setTimeout(() => ac.abort(), 20000);
					try {
						res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), signal: ac.signal });
					} catch (err) {
						res = null;
					}
					clearTimeout(timer);
					if (res && res.ok) break;
				}
				if (!res || !res.ok) throw new Error(!res || res.status === 429 || res.status >= 500 ? "OpenStreetMap is busy right now, try again in a minute" : "Refresh failed (" + res.status + ")");
				const d = await res.json();
				list = [];
				for (const e of d.elements || []) {
					const t = e.tags || {};
					const [c2, sub] = classify(t);
					const la = e.lat ?? (e.center && e.center.lat), lo = e.lon ?? (e.center && e.center.lon);
					const n = t.name || t.brand || DEFAULT_NAMES[sub];
					if (!c2 || la == null || !n) continue;
					const p = { id: e.type[0] + e.id, c: c2, t: sub, n, la, lo };
					if (t.opening_hours) p.h = t.opening_hours.slice(0, 120);
					if (t.cuisine) p.cu = t.cuisine.slice(0, 120);
					if (t.phone) p.ph = t.phone.slice(0, 40);
					const w = t.website || t["contact:website"];
					if (w && /^https?:/.test(w)) p.w = w.slice(0, 200);
					const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
					const addr = [street, t["addr:city"]].filter(Boolean).join(", ");
					if (addr) p.a = addr;
					list.push(p);
				}
				store.set(key, { t: Date.now(), list });
			} catch (e) {
				status.textContent = e.message || "Refresh failed";
				return;
			}
		}
		// distance along the route for anything new
		const r = this.app.route;
		for (const p of list) {
			if (p.s != null) continue;
			const [x, z] = toXZ(p.la, p.lo);
			const q = r.nearest(x, z, 3000);
			p.s = q ? Math.round(q.s) : 0;
			p.o = q ? Math.round(q.d) : 9999;
		}
		const n = this.places.add(list, true);
		status.textContent = n ? `Added ${n} new place${n === 1 ? "" : "s"} from OpenStreetMap` : "Up to date with OpenStreetMap";
		this.places.emit();
		setTimeout(() => {
			if (status.textContent.startsWith("Added") || status.textContent.startsWith("Up to")) status.textContent = "";
		}, 4000);
	}

	update(dt) {
		if (!this.open || !this.ready) return;
		this.t -= dt;
		if (this.t <= 0) {
			this.t = 0.25;
			this.updateRider(false);
		}
	}
}
