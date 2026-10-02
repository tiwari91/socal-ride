// Points of interest along the ride (OpenStreetMap snapshot in data/places.json):
// categories, formatting helpers and the labelled pins that float over the
// nearest places in the 3D scene.
import { clamp, damp, store } from "./util.js";
import { toXZ } from "./world.js";

export const CATS = {
	cafe: { label: "Cafes", one: "Cafe", color: "#8a5a3b", icon: "M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8.5 3.5c0 1.2 1 1.2 1 2.4M12 3.5c0 1.2 1 1.2 1 2.4" },
	food: { label: "Food", one: "Food", color: "#c8562a", icon: "M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 1.5-2.5 5-2.5 8H17v10" },
	view: { label: "Viewpoints", one: "Viewpoint", color: "#3d7ea6", icon: "M3 19l6-9 4 6 3-4 5 7zM17 4.5a2 2 0 1 0 .01 0" },
	beach: { label: "Beaches", one: "Beach", color: "#c99a22", icon: "M4 11a8 8 0 0 1 16 0zM12 11v9M4 20.5h16" },
	park: { label: "Parks", one: "Park", color: "#4f8a3c", icon: "M12 3l5 7h-3l4 5H6l4-5H7zM12 15v6" },
	sight: { label: "Sights", one: "Sight", color: "#9c3f78", icon: "M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9z" },
	bike: { label: "Bike & moto shops", one: "Shop", color: "#6b4bb0", icon: "M5.5 14.5a3 3 0 1 0 .01 0M18.5 14.5a3 3 0 1 0 .01 0M5.5 17.5L9 10h6l3.5 7.5M9 10l3 7.5M14 6h2l1 4" },
	fuel: { label: "Fuel", one: "Gas", color: "#a83a3a", icon: "M5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M4 20h11M7 8h5M14 9h2l2 2v6a1.5 1.5 0 0 0 3 0V8l-3-3" },
	water: { label: "Water & restrooms", one: "Water", color: "#2683a8", icon: "M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z" },
};
export const CAT_ORDER = Object.keys(CATS);

const TYPES = {
	cafe: "Cafe", restaurant: "Restaurant", fast_food: "Fast food", ice_cream: "Ice cream", food_court: "Food court", bakery: "Bakery", deli: "Deli",
	viewpoint: "Viewpoint", beach: "Beach", park: "Park", garden: "Garden", nature_reserve: "Nature reserve",
	bicycle_shop: "Bike shop", motorcycle_shop: "Motorcycle shop", bicycle_repair_station: "Bike repair stand", fuel: "Gas station",
	drinking_water: "Drinking water", toilets: "Restrooms", water_point: "Water", museum: "Museum", attraction: "Attraction", gallery: "Gallery", artwork: "Public art",
};

export function typeLabel(p) {
	if (TYPES[p.t]) return TYPES[p.t];
	if (p.t && p.t.startsWith("historic_")) return "Historic " + p.t.slice(9).replace(/_/g, " ");
	return CATS[p.c] ? CATS[p.c].one : "Place";
}

export function cuisineLabel(p) {
	return p.cu ? p.cu.split(";").slice(0, 3).map((c) => c.replace(/_/g, " ")).join(", ") : "";
}

// US-style distance: feet under a tenth of a mile.
export function fmtDist(m) {
	const mi = m / 1609.34;
	if (mi < 0.1) return `${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft`;
	return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

export function iconSvg(cat, size = 16) {
	const c = CATS[cat] || CATS.sight;
	return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="${c.icon}"/></svg>`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
export { esc };

export class Places {
	constructor(app) {
		this.app = app;
		this.list = [];
		this.byId = new Map();
		this.ready = false;
		const saved = store.get("cats", null);
		this.enabled = new Set(Array.isArray(saved) ? saved.filter((c) => CATS[c]) : CAT_ORDER);
		this.labels3d = store.get("labels3d", true);
		this.listeners = [];
		this.group = new THREE.Group();
		this.group.renderOrder = 10;
		this.pool = [];
		this.timer = 0;
		this.ray = new THREE.Raycaster();
	}

	async load() {
		try {
			const r = await fetch("data/places.json");
			if (!r.ok) throw new Error("places " + r.status);
			const d = await r.json();
			this.generated = d.generated;
			this.add(d.places, false);
		} catch (e) {
			console.warn("Places unavailable:", e.message);
		}
		this.ready = true;
		this.emit();
	}

	// Merge places (from the snapshot or a live Overpass refresh), keyed by OSM id.
	add(list, live) {
		let n = 0;
		for (const p of list) {
			if (!CATS[p.c]) continue;
			const [x, z] = toXZ(p.la, p.lo);
			const old = this.byId.get(p.id);
			const q = Object.assign(old || {}, p, { x, z, live: live || (old && old.live) || false });
			if (!old) {
				this.byId.set(p.id, q);
				this.list.push(q);
				n++;
			}
		}
		this.list.sort((a, b) => a.s - b.s);
		return n;
	}

	onChange(fn) {
		this.listeners.push(fn);
	}

	emit() {
		for (const fn of this.listeners) fn(this);
	}

	setEnabled(cat, on) {
		if (on) this.enabled.add(cat);
		else this.enabled.delete(cat);
		store.set("cats", [...this.enabled]);
		this.timer = 0;
		this.emit();
	}

	setLabels(on) {
		this.labels3d = on;
		store.set("labels3d", on);
		this.timer = 0;
	}

	counts() {
		const c = {};
		for (const k of CAT_ORDER) c[k] = 0;
		for (const p of this.list) c[p.c]++;
		return c;
	}

	// Places within `ahead` metres along the route, nearest first.
	nearby(x, z, s, opts = {}) {
		const { behind = 150, ahead = 1500, maxOff = 400, limit = 8, cats = this.enabled } = opts;
		const L = this.list;
		let lo = 0, hi = L.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (L[m].s < s - behind) lo = m + 1;
			else hi = m;
		}
		const out = [];
		for (let i = lo; i < L.length && L[i].s <= s + ahead; i++) {
			const p = L[i];
			if (!cats.has(p.c) || p.o > maxOff) continue;
			out.push({ p, d: Math.hypot(p.x - x, p.z - z) });
		}
		out.sort((a, b) => a.d - b.d);
		return out.slice(0, limit);
	}

	// ---------- 3D labels ----------
	makeLabel() {
		const cv = document.createElement("canvas");
		cv.width = 640;
		cv.height = 96;
		const tex = new THREE.CanvasTexture(cv);
		tex.encoding = THREE.sRGBEncoding;
		tex.anisotropy = 4;
		const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, opacity: 0, fog: false });
		const sp = new THREE.Sprite(mat);
		sp.center.set(0.5, 0);
		sp.renderOrder = 20;
		const stemGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]);
		const stem = new THREE.Line(stemGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false }));
		stem.renderOrder = 19;
		this.group.add(sp, stem);
		const L = { cv, tex, sp, stem, place: null, alpha: 0, text: "" };
		this.pool.push(L);
		return L;
	}

	draw(L, p, dist) {
		const text = `${p.n}|${fmtDist(dist)}`;
		if (text === L.text) return;
		L.text = text;
		const g = L.cv.getContext("2d");
		const W = L.cv.width, H = L.cv.height;
		g.clearRect(0, 0, W, H);
		const name = p.n.length > 28 ? p.n.slice(0, 27) + "…" : p.n;
		g.font = "600 34px Inter, system-ui, sans-serif";
		const tw = g.measureText(name).width;
		g.font = "500 26px Inter, system-ui, sans-serif";
		const dw = g.measureText(fmtDist(dist)).width;
		const w = Math.min(W - 4, 84 + tw + 16 + dw + 26), h = 76, x0 = (W - w) / 2, y0 = 4;
		g.fillStyle = "rgba(250, 245, 236, 0.94)";
		g.strokeStyle = "rgba(29, 35, 39, 0.18)";
		g.lineWidth = 2;
		g.beginPath();
		const r = h / 2;
		g.moveTo(x0 + r, y0);
		g.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
		g.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
		g.arcTo(x0, y0 + h, x0, y0, r);
		g.arcTo(x0, y0, x0 + w, y0, r);
		g.closePath();
		g.fill();
		g.stroke();
		const col = CATS[p.c].color;
		g.fillStyle = col;
		g.beginPath();
		g.arc(x0 + 40, y0 + h / 2, 28, 0, Math.PI * 2);
		g.fill();
		g.save();
		g.translate(x0 + 40 - 18, y0 + h / 2 - 18);
		g.scale(1.5, 1.5);
		g.strokeStyle = "#fff";
		g.lineWidth = 1.9;
		g.lineCap = g.lineJoin = "round";
		g.stroke(new Path2D(CATS[p.c].icon));
		g.restore();
		g.fillStyle = "#1d2327";
		g.textBaseline = "middle";
		g.font = "600 34px Inter, system-ui, sans-serif";
		g.fillText(name, x0 + 80, y0 + h / 2 + 1);
		g.fillStyle = "#5d6266";
		g.font = "500 26px Inter, system-ui, sans-serif";
		g.fillText(fmtDist(dist), x0 + 80 + tw + 16, y0 + h / 2 + 2);
		L.tex.needsUpdate = true;
	}

	update(dt) {
		const app = this.app;
		if (!this.ready || !app.bike) return;
		const bp = app.bike.root.position;
		this.timer -= dt;
		if (this.timer <= 0) {
			this.timer = 0.5;
			const want = this.labels3d && !document.body.classList.contains("hide-hud") ? this.nearby(bp.x, bp.z, app.rider.s, { behind: 40, ahead: 900, maxOff: 260, limit: app.quality.name === "low" ? 4 : 6 }) : [];
			const keep = new Set(want.map((w) => w.p));
			for (const L of this.pool) if (L.place && !keep.has(L.place)) L.place = null;
			for (const [rank, w] of want.entries()) {
				let L = this.pool.find((q) => q.place === w.p);
				if (!L) {
					L = this.pool.find((q) => !q.place && q.alpha < 0.02) || (this.pool.length < 8 ? this.makeLabel() : null);
					if (!L) continue;
					L.place = w.p;
					L.y = app.ground.height(w.p.x, w.p.z);
				}
				L.rank = rank;
				this.draw(L, w.p, w.d);
			}
		}
		const cam = app.camera;
		for (const L of this.pool) {
			const p = L.place;
			let target = 0;
			if (p) {
				const d = Math.hypot(p.x - cam.position.x, p.z - cam.position.z);
				target = clamp((900 - d) / 250, 0, 1) * clamp((d - 12) / 20, 0, 1);
				const lift = 6 + (L.rank || 0) * 2.5 + clamp(d / 60, 0, 10);
				L.sp.position.set(p.x, L.y + lift, p.z);
				L.stem.position.set(p.x, L.y, p.z);
				L.stem.scale.set(1, lift, 1);
			}
			L.alpha = damp(L.alpha, target, 4, dt);
			L.sp.material.opacity = L.alpha;
			L.stem.material.opacity = L.alpha * 0.55;
			L.sp.visible = L.stem.visible = L.alpha > 0.01;
			const h = innerHeight < 600 ? 0.062 : 0.05;
			L.sp.scale.set((h * 640) / 96, h, 1);
		}
	}

	// Which 3D label (if any) is under a click.
	pick(clientX, clientY) {
		const app = this.app;
		const v = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
		this.ray.setFromCamera(v, app.camera);
		const vis = this.pool.filter((L) => L.place && L.alpha > 0.3).map((L) => L.sp);
		const hit = this.ray.intersectObjects(vis, false)[0];
		if (!hit) return null;
		const L = this.pool.find((q) => q.sp === hit.object);
		return L ? L.place : null;
	}
}
