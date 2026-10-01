// Side streets from OSM drawn as flat asphalt ribbons on the ground near the
// route, so the cities read as street grids rather than open lawns.
import { withFog } from "./util.js";
import { groundDetail } from "./ground.js";

const CH = 50;
const ASPHALT = [0.067, 0.067, 0.07];
const WALK = [0.4, 0.38, 0.34];

export class Streets {
	constructor(route, ground, list, quality) {
		this.route = route;
		this.ground = ground;
		this.q = quality;
		this.group = new THREE.Group();
		this.byChunk = new Map();
		this.meshes = new Map();
		for (const [w, flat] of list) {
			const q = route.nearest(flat[0], flat[1], 300) || route.nearest(flat[flat.length - 2], flat[flat.length - 1], 300);
			if (!q) continue;
			const k = Math.floor(q.i / CH);
			if (!this.byChunk.has(k)) this.byChunk.set(k, []);
			this.byChunk.get(k).push([w, flat]);
		}
		this.mat = withFog(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), groundDetail, "street");
	}

	ribbon(pts, w, pos, col, idx) {
		const hw = w / 2;
		// stations: sidewalk edge, curb, asphalt ... asphalt, curb, sidewalk edge
		const us = [-hw - 2.2, -hw, -hw + 0.01, hw - 0.01, hw, hw + 2.2];
		const cs = [WALK, WALK, ASPHALT, ASPHALT, WALK, WALK];
		const hs = [0.04, 0.12, 0, 0, 0.12, 0.04];
		const base = pos.length / 3;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
			let dx = b[0] - a[0], dz = b[1] - a[1];
			const L = Math.hypot(dx, dz) || 1;
			dx /= L;
			dz /= L;
			const rx = -dz, rz = dx;
			const y = this.ground.height(pts[i][0], pts[i][1]) + 0.1;
			for (let s = 0; s < us.length; s++) {
				pos.push(pts[i][0] + rx * us[s], y + hs[s], pts[i][1] + rz * us[s]);
				col.push(cs[s][0], cs[s][1], cs[s][2]);
			}
			if (i > 0) {
				const p = base + (i - 1) * us.length, q = base + i * us.length;
				for (let s = 0; s < us.length - 1; s++) idx.push(p + s, p + s + 1, q + s, p + s + 1, q + s + 1, q + s);
			}
		}
	}

	build(k) {
		const list = this.byChunk.get(k);
		if (!list) return null;
		const pos = [], col = [], idx = [];
		for (const [w, flat] of list) {
			// resample to ~8 m
			const pts = [];
			for (let i = 0; i + 3 < flat.length; i += 2) {
				const ax = flat[i], az = flat[i + 1], bx = flat[i + 2], bz = flat[i + 3];
				const L = Math.hypot(bx - ax, bz - az);
				const n = Math.max(1, Math.ceil(L / 8));
				for (let t = 0; t < n; t++) pts.push([ax + ((bx - ax) * t) / n, az + ((bz - az) * t) / n]);
			}
			pts.push([flat[flat.length - 2], flat[flat.length - 1]]);
			// split where the street runs inside the modelled route carriageways
			let run = [];
			for (const p of pts) {
				const q = this.route.nearest(p[0], p[1], 60);
				if (q && q.d < this.ground.edge(q) + 2.6) {
					if (run.length > 1) this.ribbon(run, w, pos, col, idx);
					run = [];
				} else run.push(p);
			}
			if (run.length > 1) this.ribbon(run, w, pos, col, idx);
		}
		if (!idx.length) return null;
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
		g.setIndex(idx);
		const n = new Float32Array(pos.length);
		for (let i = 1; i < n.length; i += 3) n[i] = 1;
		g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
		const m = new THREE.Mesh(g, this.mat);
		m.receiveShadow = true;
		m.matrixAutoUpdate = false;
		return m;
	}

	update(s) {
		const r = this.route;
		const c0 = Math.max(0, Math.floor((s - 900) / r.step / CH)), c1 = Math.floor((s + this.q.ahead * 0.8) / r.step / CH);
		for (const [k, m] of this.meshes) {
			if (k < c0 || k > c1) {
				if (m) {
					this.group.remove(m);
					m.geometry.dispose();
				}
				this.meshes.delete(k);
			}
		}
		const cur = Math.floor(s / r.step / CH);
		const order = [];
		for (let k = c0; k <= c1; k++) if (!this.meshes.has(k)) order.push(k);
		order.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
		let built = 0;
		for (const k of order) {
			const m = this.build(k);
			this.meshes.set(k, m);
			if (m) this.group.add(m);
			if (++built >= 2) break;
		}
		return order.length - built;
	}
}
