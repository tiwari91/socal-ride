// A handful of simple cars sharing the road: same-direction traffic in our
// lanes and oncoming traffic on the other carriageway.
import { clamp, lerp, merge, paint, rng } from "./util.js";
import { KIND } from "./route.js";

const COLORS = ["#f2f2ef", "#1c1d21", "#8d9196", "#5a6470", "#7d1d22", "#20375e", "#c9c3b3", "#3f4a3a", "#b8b9bb", "#e8e4da"];

function box(w, h, l, x, y, z, color) {
	const g = new THREE.BoxGeometry(w, h, l);
	g.translate(x, y, z);
	return paint(g, color);
}

function carGeo(kind) {
	const p = [];
	const glass = "#20262c";
	if (kind === 0) { // sedan
		const body = new THREE.BoxGeometry(1.84, 0.62, 4.6, 1, 1, 4);
		const bp = body.attributes.position;
		for (let i = 0; i < bp.count; i++) {
			const z = bp.getZ(i), y = bp.getY(i);
			if (y > 0 && Math.abs(z) > 1.8) bp.setY(i, y - 0.12);
		}
		body.translate(0, 0.62, 0);
		p.push(paint(body, "#ffffff"));
		const cab = new THREE.BoxGeometry(1.6, 0.56, 2.4);
		const cp = cab.attributes.position;
		for (let i = 0; i < cp.count; i++) if (cp.getY(i) > 0) { cp.setZ(i, cp.getZ(i) * 0.72); cp.setX(i, cp.getX(i) * 0.92); }
		cab.translate(0, 1.2, -0.15);
		p.push(paint(cab, glass));
		p.push(box(1.42, 0.05, 1.5, 0, 1.49, -0.18, "#ffffff"));
	} else if (kind === 1) { // SUV
		p.push(box(1.92, 0.85, 4.75, 0, 0.78, 0, "#ffffff"));
		const cab = new THREE.BoxGeometry(1.78, 0.62, 3.1);
		const cp = cab.attributes.position;
		for (let i = 0; i < cp.count; i++) if (cp.getY(i) > 0 && cp.getZ(i) > 0) cp.setZ(i, cp.getZ(i) * 0.8);
		cab.translate(0, 1.5, -0.35);
		p.push(paint(cab, glass));
		p.push(box(1.7, 0.06, 2.6, 0, 1.83, -0.45, "#ffffff"));
	} else { // pickup
		p.push(box(1.95, 0.8, 5.4, 0, 0.8, 0, "#ffffff"));
		p.push(paint(new THREE.BoxGeometry(1.8, 0.65, 1.9).translate(0, 1.52, 0.55), glass));
		p.push(box(1.7, 0.06, 1.7, 0, 1.86, 0.55, "#ffffff"));
		p.push(box(1.7, 0.1, 2.0, 0, 1.12, -1.5, "#3a3a3a"));
	}
	const L = kind === 2 ? 5.4 : kind === 1 ? 4.75 : 4.6;
	const wy = kind === 0 ? 0.33 : 0.38;
	for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
		const w = new THREE.CylinderGeometry(wy, wy, 0.26, 12);
		w.rotateZ(Math.PI / 2);
		w.translate(sx * 0.86, wy, sz * (L / 2 - 0.85));
		p.push(paint(w, "#111111"));
	}
	p.push(box(0.4, 0.13, 0.05, 0.62, 0.78, L / 2, "#f6f1e0"), box(0.4, 0.13, 0.05, -0.62, 0.78, L / 2, "#f6f1e0"));
	p.push(box(0.36, 0.14, 0.05, 0.66, 0.85, -L / 2, "#b0121a"), box(0.36, 0.14, 0.05, -0.66, 0.85, -L / 2, "#b0121a"));
	return { geo: merge(p), L };
}

export class Traffic {
	constructor(route, quality, count) {
		this.route = route;
		this.group = new THREE.Group();
		this.types = [0, 1, 2].map((k) => carGeo(k));
		this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
		this.meshes = this.types.map((t) => {
			const m = new THREE.InstancedMesh(t.geo, this.mat, count);
			m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
			m.frustumCulled = false;
			m.castShadow = quality.shadows;
			m.count = 0;
			this.group.add(m);
			return m;
		});
		const R = rng(99);
		this.cars = [];
		for (let i = 0; i < count; i++) {
			this.cars.push({ s: -1e9, lane: 0, v: 0, dir: i % 5 < 3 ? 1 : -1, type: R() < 0.55 ? 0 : R() < 0.6 ? 1 : 2, color: new THREE.Color(COLORS[Math.floor(R() * COLORS.length)]), d: 0, wobble: R() * 10 });
		}
		this.R = R;
		// headlight / taillight glows for dusk
		const mk = (color, size) => {
			const g = new THREE.BufferGeometry();
			g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 6), 3));
			const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, map: dotTexture() }));
			pts.frustumCulled = false;
			this.group.add(pts);
			return pts;
		};
		this.heads = mk(0xfff0d0, 1.4);
		this.tails = mk(0xff2a1a, 0.9);
		this.m = new THREE.Matrix4();
		this.q = new THREE.Quaternion();
		this.P = {};
		this.night = 0;
	}

	laneD(i, lane, dir) {
		const r = this.route;
		const hw = r.hw[i];
		const lanes = Math.max(1, Math.round((2 * hw) / 3.6));
		const lw = (2 * hw) / lanes;
		const l = Math.min(lane, lanes - 1);
		if (dir > 0) return hw - lw * (l + 0.5);
		const oppIn = -hw - r.gap[i];
		return oppIn - lw * (l + 0.5);
	}

	spawn(c, bikeS, initial) {
		const r = this.route;
		const R = this.R;
		for (let tries = 0; tries < 6; tries++) {
			let s;
			if (c.dir > 0) s = bikeS + (initial ? -200 + R() * 1100 : R() < 0.75 ? 650 + R() * 250 : -260 - R() * 60);
			else s = bikeS + (initial ? -100 + R() * 1000 : 800 + R() * 200);
			if (s < 10 || s > r.length - 10) continue;
			const i = Math.round(s / r.step);
			const k = r.kind[i];
			if (c.dir < 0 && k === KIND.ramp) continue;
			const lanes = Math.max(1, Math.round((2 * r.hw[i]) / 3.6));
			c.lane = Math.floor(R() * lanes);
			c.s = s;
			c.v = this.speedFor(k) * (0.85 + R() * 0.3);
			c.vt = c.v;
			c.type = R() < 0.55 ? 0 : R() < 0.6 ? 1 : 2;
			c.color.set(COLORS[Math.floor(R() * COLORS.length)]);
			return;
		}
		c.s = -1e9;
	}

	speedFor(k) {
		return k === KIND.freeway ? 30 : k === KIND.ramp ? 17 : k === KIND.coast ? 19 : k === KIND.boulevard ? 17 : 11;
	}

	update(dt, bike) {
		const r = this.route;
		const counts = [0, 0, 0];
		const hp = this.heads.geometry.attributes.position.array, tp = this.tails.geometry.attributes.position.array;
		let nh = 0, nt = 0;
		let lead = null;
		for (const c of this.cars) {
			if (c.s < -1e8) this.spawn(c, bike.s, true);
			if (c.s < -1e8) continue;
			const rel = c.s - bike.s;
			if (rel < -320 || rel > 1000) {
				this.spawn(c, bike.s, false);
				continue;
			}
			const i = clamp(Math.round(c.s / r.step), 0, r.n - 1);
			c.vt = this.speedFor(r.kind[i]) * (0.9 + 0.15 * Math.sin(c.wobble));
			// keep distance from whatever is ahead in the same lane
			let gapAhead = 1e9, vAhead = 0;
			for (const o of this.cars) {
				if (o === c || o.dir !== c.dir || o.lane !== c.lane) continue;
				const g = (o.s - c.s) * c.dir;
				if (g > 0 && g < gapAhead) {
					gapAhead = g;
					vAhead = o.v;
				}
			}
			const d = this.laneD(i, c.lane, c.dir);
			c.d = lerp(c.d || d, d, 1 - Math.exp(-dt * 1.5));
			if (c.dir > 0 && Math.abs(c.d - bike.d) < 1.7) {
				const g = bike.s - c.s;
				if (g > 0 && g < gapAhead) {
					gapAhead = g;
					vAhead = bike.v;
				}
				if (-g > 0 && -g < 60 && (!lead || -g < lead.gap)) lead = { gap: -g - 2.5, v: c.v };
			}
			let v = c.vt;
			if (gapAhead < 60) v = Math.min(v, vAhead + (gapAhead - 14) * 0.3);
			c.v = Math.max(0, lerp(c.v, v, 1 - Math.exp(-dt * 1.2)));
			c.s += c.v * c.dir * dt;
			if (c.s < 5 || c.s > r.length - 5) {
				c.s = -1e9;
				continue;
			}
			const P = r.at(c.s, this.P);
			if (c.dir < 0 && P.kind === KIND.ramp) continue;
			const x = P.x + P.rx * c.d, z = P.z + P.rz * c.d;
			const yaw = Math.atan2(P.tx, P.tz) + (c.dir < 0 ? Math.PI : 0);
			this.q.setFromEuler(new THREE.Euler(-Math.atan(P.grade) * c.dir, yaw, 0, "YXZ"));
			this.m.compose(new THREE.Vector3(x, P.y, z), this.q, new THREE.Vector3(1, 1, 1));
			const mesh = this.meshes[c.type];
			const n = counts[c.type]++;
			mesh.setMatrixAt(n, this.m);
			mesh.setColorAt(n, c.color);
			if (this.night > 0.05) {
				const L = this.types[c.type].L / 2;
				const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -fz, rz = fx;
				for (const sx of [-0.62, 0.62]) {
					hp.set([x + fx * (L + 0.1) + rx * sx, P.y + 0.78, z + fz * (L + 0.1) + rz * sx], nh * 3);
					nh++;
					tp.set([x - fx * (L + 0.1) + rx * sx, P.y + 0.85, z - fz * (L + 0.1) + rz * sx], nt * 3);
					nt++;
				}
			}
		}
		this.meshes.forEach((m, k) => {
			m.count = counts[k];
			m.instanceMatrix.needsUpdate = true;
			if (m.instanceColor) m.instanceColor.needsUpdate = true;
		});
		this.heads.geometry.setDrawRange(0, nh);
		this.tails.geometry.setDrawRange(0, nt);
		this.heads.geometry.attributes.position.needsUpdate = true;
		this.tails.geometry.attributes.position.needsUpdate = true;
		this.heads.material.opacity = this.tails.material.opacity = clamp(this.night * 1.3, 0, 1);
		return lead;
	}

	reset() {
		for (const c of this.cars) c.s = -1e9;
	}
}

let _dot = null;
function dotTexture() {
	if (_dot) return _dot;
	const cv = document.createElement("canvas");
	cv.width = cv.height = 32;
	const g = cv.getContext("2d");
	const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
	gr.addColorStop(0, "rgba(255,255,255,1)");
	gr.addColorStop(0.3, "rgba(255,255,255,0.5)");
	gr.addColorStop(1, "rgba(255,255,255,0)");
	g.fillStyle = gr;
	g.fillRect(0, 0, 32, 32);
	_dot = new THREE.CanvasTexture(cv);
	return _dot;
}
