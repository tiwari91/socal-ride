// The ride route: centre line of our carriageway sampled every few metres,
// with road attributes, a smoothed height profile, bridges at self-crossings
// and a spatial index for nearest-point queries.
import { clamp, lerp, smoothstep } from "./util.js";
import { terrainHeight } from "./world.js";

export const KIND = { freeway: 0, ramp: 1, boulevard: 2, street: 3, coast: 4 };
const CELL = 120;

export class Route {
	constructor(data) {
		const n = data.xz.length / 2;
		this.n = n;
		this.step = data.step;
		this.length = (n - 1) * data.step;
		this.X = new Float64Array(n);
		this.Z = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			this.X[i] = data.xz[2 * i];
			this.Z[i] = data.xz[2 * i + 1];
		}
		this.kind = new Uint8Array(n);
		this.lanes = new Float32Array(n);
		this.nameIdx = new Uint16Array(n);
		this.names = [];
		const nameMap = new Map();
		for (const s of data.segments) {
			const label = prettyName(s);
			if (!nameMap.has(label)) {
				nameMap.set(label, this.names.length);
				this.names.push(label);
			}
			for (let i = s.from; i <= s.to && i < n; i++) {
				this.kind[i] = KIND[s.kind] ?? 3;
				this.lanes[i] = s.lanes;
				this.nameIdx[i] = nameMap.get(label);
			}
		}
		this.chapters = data.chapters;
		this.computeFrames();
		this.computeWidths();
		this.buildIndex();
	}

	computeFrames() {
		const n = this.n;
		this.TX = new Float32Array(n);
		this.TZ = new Float32Array(n);
		this.curv = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
			const dx = this.X[b] - this.X[a], dz = this.Z[b] - this.Z[a];
			const L = Math.hypot(dx, dz) || 1;
			this.TX[i] = dx / L;
			this.TZ[i] = dz / L;
		}
		for (let i = 0; i < n; i++) {
			const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
			const h0 = Math.atan2(this.TZ[a], this.TX[a]), h1 = Math.atan2(this.TZ[b], this.TX[b]);
			let d = h1 - h0;
			while (d > Math.PI) d -= Math.PI * 2;
			while (d < -Math.PI) d += Math.PI * 2;
			this.curv[i] = d / ((b - a) * this.step);
		}
	}

	computeWidths() {
		// half width of our carriageway, smoothed so lane drops taper
		const n = this.n, raw = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const k = this.kind[i];
			let lanes = this.lanes[i];
			if (k === KIND.freeway) lanes = clamp(lanes, 3, 5);
			if (k === KIND.ramp) lanes = clamp(lanes, 1, 2);
			if (k === KIND.boulevard || k === KIND.coast) lanes = clamp(lanes, 2, 3);
			if (k === KIND.street) lanes = 1;
			raw[i] = lanes * 1.8;
		}
		this.hw = smoothArray(raw, 18);
		const kf = new Float32Array(n);
		for (let i = 0; i < n; i++) kf[i] = this.kind[i] === KIND.freeway ? 1 : 0;
		this.fwy = smoothArray(kf, 20); // 0..1 freeway-ness for blending cross sections
	}

	buildIndex() {
		this.grid = new Map();
		for (let i = 0; i < this.n; i++) {
			const key = Math.floor(this.X[i] / CELL) * 65536 + Math.floor(this.Z[i] / CELL);
			let a = this.grid.get(key);
			if (!a) this.grid.set(key, (a = []));
			a.push(i);
		}
	}

	// Nearest point on the polyline: {i, t, s, d (unsigned), lat (signed, right +)}.
	nearest(x, z, maxR = 400, skipFrom = -1, skipTo = -1) {
		const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
		const R = Math.ceil(maxR / CELL);
		let best = maxR * maxR, bi = -1, bt = 0;
		for (let i = ci - R; i <= ci + R; i++) for (let j = cj - R; j <= cj + R; j++) {
			const list = this.grid.get(i * 65536 + j);
			if (!list) continue;
			for (const k of list) {
				if (k >= skipFrom && k <= skipTo) continue;
				for (const a of [k - 1, k]) {
					if (a < 0 || a >= this.n - 1) continue;
					const dx = this.X[a + 1] - this.X[a], dz = this.Z[a + 1] - this.Z[a];
					const L2 = dx * dx + dz * dz || 1;
					const t = clamp(((x - this.X[a]) * dx + (z - this.Z[a]) * dz) / L2, 0, 1);
					const px = this.X[a] + dx * t, pz = this.Z[a] + dz * t;
					const d2 = (x - px) ** 2 + (z - pz) ** 2;
					if (d2 < best) {
						best = d2;
						bi = a;
						bt = t;
					}
				}
			}
		}
		if (bi < 0) return null;
		const tx = this.TX[bi], tz = this.TZ[bi];
		const px = this.X[bi] + (this.X[bi + 1] - this.X[bi]) * bt, pz = this.Z[bi] + (this.Z[bi + 1] - this.Z[bi]) * bt;
		const lat = (x - px) * -tz + (z - pz) * tx;
		return { i: bi, t: bt, s: (bi + bt) * this.step, d: Math.sqrt(best), lat };
	}

	computeHeights(onProgress) {
		const n = this.n;
		const raw = new Float32Array(n);
		for (let i = 0; i < n; i++) raw[i] = terrainHeight(this.X[i], this.Z[i]);
		// coast road sits on the bluff, never on the beach
		const win = new Float32Array(n);
		for (let i = 0; i < n; i++) win[i] = this.kind[i] === KIND.freeway ? 40 : this.kind[i] === KIND.ramp ? 22 : 14;
		let y = smoothVar(raw, smoothArray(win, 10));
		y = smoothVar(y, smoothArray(win, 10));
		for (let i = 0; i < n; i++) y[i] = Math.max(y[i], 3);
		// limit grade
		const g = 0.055 * this.step;
		for (let k = 0; k < 2; k++) {
			for (let i = 1; i < n; i++) y[i] = clamp(y[i], y[i - 1] - g, y[i - 1] + g);
			for (let i = n - 2; i >= 0; i--) y[i] = clamp(y[i], y[i + 1] - g, y[i + 1] + g);
		}
		this.ground = Float32Array.from(y);
		this.bridges = this.findCrossings();
		for (const b of this.bridges) {
			const R = 45;
			for (let i = b.c - R; i <= b.c + R; i++) {
				if (i < 0 || i >= n) continue;
				const f = 0.5 + 0.5 * Math.cos(((i - b.c) / R) * Math.PI);
				y[i] = Math.max(y[i], lerp(y[i], b.under + 8.2, f));
			}
		}
		this.Y = y;
		this.bridgeMask = new Float32Array(n);
		for (const b of this.bridges) for (let i = b.c - 12; i <= b.c + 12; i++) if (i >= 0 && i < n) this.bridgeMask[i] = 1;
		if (onProgress) onProgress();
	}

	findCrossings() {
		const out = [];
		const n = this.n;
		for (let i = 0; i < n - 1; i += 2) {
			const q = this.nearest(this.X[i], this.Z[i], 25, i - 160, i + 160);
			if (!q || q.d > 8) continue;
			const j = q.i;
			// angle check: real crossings, not parallel stretches
			const dot = Math.abs(this.TX[i] * this.TX[j] + this.TZ[i] * this.TZ[j]);
			if (dot > 0.85) continue;
			const pri = (k) => (this.kind[k] === KIND.freeway ? 3 : this.kind[k] === KIND.ramp ? 2 : 1);
			let top = pri(i) > pri(j) ? i : pri(j) > pri(i) ? j : Math.max(i, j);
			const bot = top === i ? j : i;
			if (out.some((b) => Math.abs(b.c - top) < 60)) continue;
			out.push({ c: top, other: bot, under: this.ground[bot] });
		}
		return out;
	}

	// Lateral road layout per sample (metres from the route line, right +):
	// R = right pavement edge, Lp = left pavement edge (negative), gap = space
	// between our lanes and the opposing lanes, med = raised landscaped median.
	computeLayout() {
		const n = this.n;
		const R = new Float32Array(n), Lp = new Float32Array(n), gap = new Float32Array(n), med = new Float32Array(n), bike = new Float32Array(n);
		const blend = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const hw = this.hw[i], k = this.kind[i];
			const zone = this.zoneAt(i * this.step);
			let r, g, opp, lpad, m = 0;
			if (k === KIND.freeway) { r = 3.0; g = 3.0; opp = 2 * hw; lpad = 3.0; }
			else if (k === KIND.ramp) { r = 2.2; g = 1.2; opp = 0; lpad = 0; }
			else if (k === KIND.street) { r = 2.4; g = 0.35; opp = 2 * hw; lpad = 2.4; }
			else {
				const wide = this.lanes[i] >= 3 && (zone === "irvine" || zone === "oc-city" || zone === "coast");
				m = wide ? 1 : 0;
				r = k === KIND.coast ? 1.9 : 1.3;
				// Class II bike lanes on PCH and Irvine's arterials
				if (k === KIND.coast || (zone === "irvine" && this.lanes[i] >= 2)) {
					bike[i] = 1.6;
					r = 2.3;
				}
				g = wide ? 5.2 : 0.4;
				opp = 2 * hw;
				lpad = r;
			}
			R[i] = hw + r;
			gap[i] = g;
			Lp[i] = -(hw + g + opp + lpad);
			med[i] = m;
			blend[i] = k === KIND.freeway ? (zone === "canyon" ? 110 : 80) : zone === "laguna" || zone === "coast" ? 55 : k === KIND.ramp ? 60 : 230;
		}
		this.R = smoothArray(R, 8);
		this.Lp = smoothArray(Lp, 8);
		this.gap = smoothArray(gap, 6);
		this.med = med;
		this.bike = bike;
		this.blend = smoothArray(blend, 25);
	}

	// Interpolated frame at distance s.
	at(s, out = {}) {
		const f = clamp(s / this.step, 0, this.n - 1.0001);
		const i = Math.floor(f), t = f - i;
		out.i = i;
		out.t = t;
		out.x = lerp(this.X[i], this.X[i + 1], t);
		out.z = lerp(this.Z[i], this.Z[i + 1], t);
		out.y = lerp(this.Y[i], this.Y[i + 1], t);
		let tx = lerp(this.TX[i], this.TX[i + 1], t), tz = lerp(this.TZ[i], this.TZ[i + 1], t);
		const L = Math.hypot(tx, tz) || 1;
		out.tx = tx / L;
		out.tz = tz / L;
		out.rx = -out.tz;
		out.rz = out.tx;
		out.curv = lerp(this.curv[i], this.curv[i + 1], t);
		out.hw = lerp(this.hw[i], this.hw[i + 1], t);
		out.kind = this.kind[t < 0.5 ? i : i + 1];
		out.grade = (this.Y[Math.min(this.n - 1, i + 2)] - this.Y[Math.max(0, i - 1)]) / (3 * this.step);
		return out;
	}

	nameAt(s) {
		const i = clamp(Math.round(s / this.step), 0, this.n - 1);
		return this.names[this.nameIdx[i]];
	}

	chapterAt(s) {
		let c = 0;
		for (let k = 0; k < this.chapters.length; k++) if (s >= this.chapters[k].s - 1) c = k;
		return c;
	}

	// Scenery style for a distance along the route.
	zoneAt(s) {
		const c = this.chapters[this.chapterAt(s)].name;
		const i = clamp(Math.round(s / this.step), 0, this.n - 1);
		const fw = this.fwy[i] > 0.5 || this.kind[i] === KIND.ramp;
		switch (c) {
			case "Redlands": return fw ? "ie-freeway" : "redlands";
			case "Riverside": return fw ? "ie-freeway" : "riverside";
			case "Santa Ana Canyon": return "canyon";
			case "Fullerton": return fw ? "oc-freeway" : "oc-city";
			case "Irvine": return fw ? "oc-freeway" : "irvine";
			case "Newport Beach": return "coast";
			default: return "laguna";
		}
	}
}

function prettyName(s) {
	const ref = s.ref || "";
	const nm = s.name || "";
	if (s.kind === "freeway" && ref) {
		const r = ref.split(";")[0];
		const map = { "I 10": "I-10 San Bernardino Fwy", "I 215": "I-215", "CA 91": "CA-91 Riverside Fwy", "CA 57": "CA-57 Orange Fwy", "I 5": "I-5 Santa Ana Fwy", "CA 55": "CA-55 Costa Mesa Fwy", "I 405": "I-405 San Diego Fwy" };
		return map[r] || r.replace(" ", "-");
	}
	if (s.kind === "coast") return "Pacific Coast Highway";
	if (s.kind === "ramp") return nm || "Ramp";
	if (/^(US|CA) /.test(nm) || !nm) return ref.includes("US 99") ? "Redlands Boulevard" : nm || "Local road";
	return nm.replace(/^(North|South|East|West) /, "");
}

export function smoothArray(a, r) {
	const n = a.length, out = new Float32Array(n);
	const pre = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
	for (let i = 0; i < n; i++) {
		const lo = Math.max(0, i - r), hi = Math.min(n, i + r + 1);
		out[i] = (pre[hi] - pre[lo]) / (hi - lo);
	}
	return out;
}

function smoothVar(a, win) {
	const n = a.length, out = new Float32Array(n);
	const pre = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
	for (let i = 0; i < n; i++) {
		const r = Math.round(win[i]);
		const lo = Math.max(0, i - r), hi = Math.min(n, i + r + 1);
		out[i] = (pre[hi] - pre[lo]) / (hi - lo);
	}
	return out;
}

export { smoothstep };
