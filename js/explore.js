// Explore map: Leaflet with OpenStreetMap tiles, the route, the rider's live
// position and every cafe, viewpoint, beach and stop along the way.
// Leaflet loads from cdnjs the first time the map opens.
import { store } from "./util.js";
import { toLatLon, toXZ } from "./world.js";
import { CATS, CAT_ORDER, cuisineLabel, esc, fmtDist, iconSvg, typeLabel } from "./places.js";

const CDN = "https://cdnjs.cloudflare.com/ajax/libs/";
const CSS = [
	[`${CDN}leaflet/1.9.4/leaflet.min.css`, "sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw=="],
	[`${CDN}leaflet.markercluster/1.5.3/MarkerCluster.min.css`, "sha512-ENrTWqddXrLJsQS2A86QmvA17PkJ0GVm1bqj5aTgpeMAfDKN2+SIOLpKG8R/6KkimnhTb+VW5qqUHB/r1zaRgg=="],
];
const JS = [
	[`${CDN}leaflet/1.9.4/leaflet.min.js`, "sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g=="],
	[`${CDN}leaflet.markercluster/1.5.3/leaflet.markercluster.min.js`, "sha512-TiMWaqipFi2Vqt4ugRzsF8oRoGFlFFuqIi30FFxEPNw58Ov9mOy6LgC05ysfkxwLE0xVeZtmr92wVg9siAFRWA=="],
];
// main public instance first, then a community mirror if it is busy
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const LIVE_TTL = 7 * 24 * 3600 * 1000;
const $ = (id) => document.getElementById(id);

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
function loadLeaflet() {
	if (!libs) {
		libs = Promise.all(CSS.map(([u, s]) => loadTag("link", u, s)))
			.then(() => loadTag("script", JS[0][0], JS[0][1]))
			.then(() => loadTag("script", JS[1][0], JS[1][1]))
			.catch((e) => {
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

export class Explore {
	constructor(app) {
		this.app = app;
		this.places = app.places;
		this.open = false;
		this.map = null;
		this.markers = new Map();
		this.follow = true;
		this.query = "";
		this.t = 0;
		this.el = $("explore");
		this.buildChips();
		this.bind();
		this.places.onChange(() => {
			this.buildChips();
			if (this.map) this.refreshMarkers();
		});
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
		this.el.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				this.hide();
			}
		});
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
			await loadLeaflet();
		} catch (e) {
			$("ex-status").textContent = e.message + ". Check your connection and try again.";
			return;
		}
		if (!this.open) return;
		if (!this.map) this.init();
		this.map.invalidateSize();
		$("ex-status").textContent = "";
		if (focus) this.focus(focus);
		else if (this.follow) this.map.setView(this.riderLatLng(), Math.max(this.map.getZoom(), 14), { animate: false });
		this.updateRider(true);
		this.renderList();
		// keyboard users land in the search box; phones keep the keyboard closed
		if (!this.app.ui.touchDev) setTimeout(() => $("ex-search").focus({ preventScroll: true }), 50);
		else $("ex-close").focus({ preventScroll: true });
	}

	hide() {
		this.open = false;
		this.el.hidden = true;
		document.body.classList.remove("exploring");
		if (this.map) this.map.closePopup();
		const b = $("map-wrap");
		if (b) b.focus({ preventScroll: true });
	}

	riderLatLng() {
		const p = this.app.bike.root.position;
		return toLatLon(p.x, p.z);
	}

	init() {
		const L = window.L;
		const app = this.app, r = app.route;
		const map = L.map("ex-map", { zoomControl: false, worldCopyJump: false, preferCanvas: false, maxBounds: [[32.9, -118.9], [34.8, -116.3]], minZoom: 9 });
		this.map = map;
		map.setView(this.riderLatLng(), 14);
		L.control.zoom({ position: "bottomright" }).addTo(map);
		L.control.scale({ position: "bottomright", imperial: true, metric: false }).addTo(map);
		L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19,
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
		}).addTo(map);
		// route, with the ridden part highlighted
		const pts = [];
		for (let i = 0; i < r.n; i += 4) pts.push(toLatLon(r.X[i], r.Z[i]));
		this.routePts = pts;
		L.polyline(pts, { color: "#1d2327", weight: 8, opacity: 0.22, interactive: false }).addTo(map);
		this.ahead = L.polyline(pts, { color: "#1f5f66", weight: 4, opacity: 0.75, interactive: false }).addTo(map);
		this.done = L.polyline([], { color: "#d9652a", weight: 5, opacity: 0.95, interactive: false }).addTo(map);
		r.chapters.forEach((c, k) => {
			const P = r.at(c.s);
			const ic = L.divIcon({ className: "ex-chapter", html: `<span>${k + 1}</span>`, iconSize: [24, 24] });
			L.marker(toLatLon(P.x, P.z), { icon: ic, title: c.name, keyboard: false, zIndexOffset: 500 })
				.bindTooltip(`${k + 1}. ${esc(c.name)}`, { direction: "top", offset: [0, -10] })
				.on("click", () => this.rideTo(c.s + (k === 0 ? 0 : 60)))
				.addTo(map);
		});
		const riderIcon = L.divIcon({ className: "ex-rider", html: '<i class="cone"></i><i class="dot"></i>', iconSize: [44, 44] });
		this.rider = L.marker(this.riderLatLng(), { icon: riderIcon, zIndexOffset: 1000, keyboard: false, title: "You are here" }).addTo(map);
		this.cluster = L.markerClusterGroup({
			showCoverageOnHover: false,
			maxClusterRadius: (z) => (z >= 16 ? 30 : 52),
			spiderfyOnMaxZoom: true,
			chunkedLoading: true,
			iconCreateFunction: (cl) => {
				const kids = cl.getAllChildMarkers();
				const tally = {};
				for (const m of kids) tally[m.place.c] = (tally[m.place.c] || 0) + 1;
				const top = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
				const n = cl.getChildCount();
				const sz = n < 10 ? 34 : n < 50 ? 40 : 46;
				return L.divIcon({ className: "ex-cluster", html: `<span style="--c:${CATS[top].color}">${n}</span>`, iconSize: [sz, sz] });
			},
		});
		map.addLayer(this.cluster);
		map.on("dragstart", () => this.setFollow(false));
		map.on("moveend", () => this.renderList());
		map.on("zoomend", () => this.updateLiveButton());
		map.on("popupopen", (e) => this.wirePopup(e.popup));
		this.refreshMarkers();
		this.updateLiveButton();
	}

	markerFor(p) {
		let m = this.markers.get(p.id);
		if (!m) {
			const L = window.L;
			const ic = L.divIcon({ className: "ex-pin", html: `<span style="--c:${CATS[p.c].color}">${iconSvg(p.c, 14)}</span>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
			m = L.marker([p.la, p.lo], { icon: ic, title: p.n, riseOnHover: true });
			m.place = p;
			m.bindPopup(() => this.popupHtml(p), { maxWidth: 280, minWidth: 200, autoPanPaddingTopLeft: [10, 70] });
			this.markers.set(p.id, m);
		}
		return m;
	}

	visible(p) {
		return this.places.enabled.has(p.c) && (!this.query || p.n.toLowerCase().includes(this.query) || typeLabel(p).toLowerCase().includes(this.query) || (p.cu || "").includes(this.query));
	}

	refreshMarkers() {
		if (!this.cluster) return;
		const want = this.places.list.filter((p) => this.visible(p)).map((p) => this.markerFor(p));
		this.cluster.clearLayers();
		this.cluster.addLayers(want);
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

	wirePopup(popup) {
		const el = popup.getElement();
		const b = el && el.querySelector(".pp-go");
		if (b) b.addEventListener("click", () => this.rideTo(parseFloat(b.dataset.s) - 120));
	}

	async rideTo(s) {
		this.hide();
		await this.app.jumpTo(Math.max(0, s));
	}

	focus(p) {
		const m = this.markerFor(p);
		if (!this.places.enabled.has(p.c)) this.places.setEnabled(p.c, true);
		this.setFollow(false);
		const go = () => this.cluster.zoomToShowLayer(m, () => m.openPopup());
		if (this.map.getZoom() < 15) {
			this.map.setView([p.la, p.lo], 16, { animate: false });
			setTimeout(go, 60);
		} else go();
	}

	setFollow(on, recenter) {
		this.follow = on;
		$("ex-follow").classList.toggle("active", on);
		$("ex-follow").setAttribute("aria-pressed", on);
		if (on && recenter && this.map) this.map.setView(this.riderLatLng(), Math.max(this.map.getZoom(), 14));
	}

	updateRider(force) {
		if (!this.map) return;
		const app = this.app;
		const ll = this.riderLatLng();
		this.rider.setLatLng(ll);
		const P = app.route.at(app.rider.s);
		const heading = (Math.atan2(P.tx, -P.tz) * 180) / Math.PI;
		const el = this.rider.getElement();
		if (el) el.style.setProperty("--hdg", `${heading}deg`);
		const k = Math.min(this.routePts.length - 1, Math.floor(app.rider.s / app.route.step / 4));
		if (force || k !== this._k) {
			this._k = k;
			this.done.setLatLngs(this.routePts.slice(0, k + 1).concat([ll]));
			this.ahead.setLatLngs([ll].concat(this.routePts.slice(k + 1)));
		}
		if (this.follow) {
			const pt = this.map.latLngToContainerPoint(ll), sz = this.map.getSize();
			if (force || Math.abs(pt.x - sz.x / 2) > sz.x * 0.18 || Math.abs(pt.y - sz.y / 2) > sz.y * 0.18) this.map.panTo(ll, { animate: true, duration: 0.6 });
		}
	}

	renderList() {
		if (!this.map || !this.open) return;
		const b = this.map.getBounds();
		const app = this.app, bp = app.bike.root.position;
		const ll = this.riderLatLng();
		// a search covers the whole route; browsing lists what is in view
		const all = !!this.query;
		const ref = all || b.contains(ll) ? { x: bp.x, z: bp.z } : null;
		const c = this.map.getCenter();
		const items = [];
		for (const p of this.places.list) {
			if (!this.visible(p) || (!all && !b.contains([p.la, p.lo]))) continue;
			const d = ref ? Math.hypot(p.x - ref.x, p.z - ref.z) : this.map.distance(c, [p.la, p.lo]);
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
	// per area for a week so the public server is not hit repeatedly.
	async liveRefresh() {
		if (!this.map || this.map.getZoom() < 13) return;
		const b = this.map.getBounds();
		const r2 = (v) => Math.round(v * 50) / 50;
		const bbox = [r2(b.getSouth()) - 0.01, r2(b.getWest()) - 0.01, r2(b.getNorth()) + 0.01, r2(b.getEast()) + 0.01].map((v) => v.toFixed(3)).join(",");
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
					const [c, sub] = classify(t);
					const la = e.lat ?? (e.center && e.center.lat), lo = e.lon ?? (e.center && e.center.lon);
					const n = t.name || t.brand || DEFAULT_NAMES[sub];
					if (!c || la == null || !n) continue;
					const p = { id: e.type[0] + e.id, c, t: sub, n, la, lo };
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
		if (!this.open || !this.map) return;
		this.t -= dt;
		if (this.t <= 0) {
			this.t = 0.25;
			this.updateRider(false);
		}
	}
}
