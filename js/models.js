// Low-poly, vertex-coloured scenery models (merged into single geometries
// so each type is one instanced draw call).
import { merge, paint, rng } from "./util.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function jitter(geo, amt, seed) {
	const r = rng(seed);
	const p = geo.attributes.position;
	const map = new Map();
	for (let i = 0; i < p.count; i++) {
		const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
		if (!map.has(key)) map.set(key, [(r() - 0.5) * amt, (r() - 0.5) * amt, (r() - 0.5) * amt]);
		const j = map.get(key);
		p.setXYZ(i, p.getX(i) + j[0], p.getY(i) + j[1], p.getZ(i) + j[2]);
	}
	geo.computeVertexNormals();
	return geo;
}

function shade(geo, top, bottom, axis = 1) {
	const p = geo.attributes.position;
	const a = new THREE.Color(top), b = new THREE.Color(bottom);
	let lo = 1e9, hi = -1e9;
	for (let i = 0; i < p.count; i++) {
		const v = axis === 1 ? p.getY(i) : p.getX(i);
		lo = Math.min(lo, v);
		hi = Math.max(hi, v);
	}
	const col = new Float32Array(p.count * 3), c = new THREE.Color();
	for (let i = 0; i < p.count; i++) {
		const v = axis === 1 ? p.getY(i) : p.getX(i);
		c.copy(b).lerp(a, (v - lo) / (hi - lo || 1));
		col.set([c.r, c.g, c.b], i * 3);
	}
	geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
	return geo;
}

// Mexican fan palm (Washingtonia robusta): tall, thin, slightly curved trunk.
export function fanPalm() {
	const parts = [];
	const H = 17;
	const trunk = new THREE.CylinderGeometry(0.17, 0.3, H, 6, 6, true);
	const p = trunk.attributes.position;
	for (let i = 0; i < p.count; i++) {
		const y = p.getY(i) + H / 2;
		p.setX(i, p.getX(i) + Math.pow(y / H, 2) * 0.9);
		p.setY(i, y);
	}
	trunk.computeVertexNormals();
	parts.push(shade(trunk, "#8a7a62", "#6e604c"));
	const skirt = new THREE.CylinderGeometry(0.42, 0.62, 2.4, 8, 1, true);
	skirt.translate(0.9, H - 1.1, 0);
	parts.push(shade(skirt, "#8a7350", "#5f4c34"));
	const r = rng(7);
	for (let k = 0; k < 20; k++) {
		const fr = new THREE.CircleGeometry(2.5, 7, -0.6, 1.2);
		fr.rotateX(-Math.PI / 2);
		fr.translate(0.5, 0, 0);
		const a = (k / 20) * Math.PI * 2 + r() * 0.3;
		const tier = k % 2;
		fr.rotateZ(tier ? 0.45 + r() * 0.3 : -0.25 - r() * 0.45);
		fr.rotateY(a);
		fr.translate(0.9, H + 0.1 + tier * 0.25, 0);
		shade(fr, "#6a8a40", "#435e2c", 0);
		const fn = fr.attributes.normal;
		for (let i = 0; i < fn.count; i++) fn.setXYZ(i, 0, 1, 0);
		parts.push(fr);
	}
	return merge(parts);
}

// Queen / Canary-style feather palm: shorter, arching fronds.
export function featherPalm() {
	const parts = [];
	const H = 8.5;
	const trunk = new THREE.CylinderGeometry(0.3, 0.42, H, 7, 4, true);
	trunk.translate(0, H / 2, 0);
	parts.push(shade(trunk, "#8d8170", "#6f6354"));
	const r = rng(11);
	for (let k = 0; k < 12; k++) {
		const pts = [];
		const L = 4.2 + r() * 0.8;
		for (let s = 0; s <= 5; s++) {
			const t = s / 5;
			pts.push(V(t * L, 0.9 * Math.sin(t * Math.PI * 0.8) - t * t * 1.9, 0));
		}
		const g = new THREE.BufferGeometry();
		const pos = [];
		for (let s = 0; s < 5; s++) {
			const a = pts[s], b = pts[s + 1];
			const w0 = 0.55 * Math.sin((s / 5) * Math.PI) + 0.08, w1 = 0.55 * Math.sin(((s + 1) / 5) * Math.PI) + 0.08;
			pos.push(a.x, a.y, -w0, a.x, a.y, w0, b.x, b.y, w1, a.x, a.y, -w0, b.x, b.y, w1, b.x, b.y, -w1);
		}
		g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
		g.computeVertexNormals();
		g.rotateY((k / 12) * Math.PI * 2 + r() * 0.4);
		g.translate(0, H, 0);
		parts.push(shade(g, "#6c8a3c", "#46632c"));
	}
	return merge(parts);
}

function blob(r, seed, color, dark, sx = 1, sy = 1, sz = 1, detail = 1) {
	const g = new THREE.IcosahedronGeometry(r, detail);
	g.scale(sx, sy, sz);
	jitter(g, r * 0.3, seed);
	// soft, rounded foliage lighting: normals point out from the blob centre
	const p = g.attributes.position, n = g.attributes.normal;
	const v = new THREE.Vector3(), fn = new THREE.Vector3();
	for (let i = 0; i < p.count; i++) {
		v.set(p.getX(i) / (sx * sx), p.getY(i) / (sy * sy), p.getZ(i) / (sz * sz)).normalize();
		fn.set(n.getX(i), n.getY(i), n.getZ(i));
		v.multiplyScalar(0.75).addScaledVector(fn, 0.25).normalize();
		v.y = v.y * 0.8 + 0.2;
		v.normalize();
		n.setXYZ(i, v.x, v.y, v.z);
	}
	return shade(g, color, dark);
}

export function orangeTree(lod = 0) {
	const parts = [];
	const trunk = new THREE.CylinderGeometry(0.1, 0.14, 0.9, 5, 1, true);
	trunk.translate(0, 0.45, 0);
	parts.push(paint(trunk, "#5d4a36"));
	const c = blob(1.55, 3, "#467a32", "#2c5222", 1, 0.85, 1, lod ? 0 : 1);
	c.translate(0, 2.0, 0);
	parts.push(c);
	if (!lod) {
		const r = rng(5);
		for (let k = 0; k < 9; k++) {
			const f = new THREE.OctahedronGeometry(0.13, 0);
			const a = r() * Math.PI * 2, e = (r() - 0.3) * 1.2;
			const R = 1.45;
			f.translate(Math.cos(a) * Math.cos(e) * R, 2.0 + Math.sin(e) * R * 0.85, Math.sin(a) * Math.cos(e) * R);
			parts.push(paint(f, "#f28c18"));
		}
	}
	return merge(parts);
}

export function eucalyptus() {
	const parts = [];
	const trunk = new THREE.CylinderGeometry(0.25, 0.5, 15, 6, 3, true);
	trunk.translate(0, 7.5, 0);
	parts.push(shade(trunk, "#d8d0bd", "#9c8f78"));
	const r = rng(21);
	for (let k = 0; k < 6; k++) {
		const b = blob(2.3 + r() * 1.0, 30 + k, "#93a37b", "#66765a", 1, 1.25, 1, 1);
		b.translate((r() - 0.5) * 4, 11 + r() * 8, (r() - 0.5) * 4);
		parts.push(b);
	}
	return merge(parts);
}

export function jacaranda() {
	const parts = [];
	const trunk = new THREE.CylinderGeometry(0.18, 0.3, 4, 5, 1, true);
	trunk.translate(0, 2, 0);
	parts.push(paint(trunk, "#6a5a4a"));
	const r = rng(31);
	for (let k = 0; k < 5; k++) {
		const b = blob(1.7 + r() * 0.5, 40 + k, "#b9a0ea", "#8a70c2", 1.2, 0.62, 1.2, 1);
		const a = (k / 5) * Math.PI * 2;
		b.translate(Math.cos(a) * 1.6, 5 + r() * 1.0, Math.sin(a) * 1.6);
		parts.push(b);
	}
	return merge(parts);
}

export function oak() {
	const parts = [];
	const trunk = new THREE.CylinderGeometry(0.3, 0.5, 3, 5, 1, true);
	trunk.translate(0, 1.5, 0);
	parts.push(paint(trunk, "#57483a"));
	const r = rng(51);
	for (let k = 0; k < 5; k++) {
		const b = blob(2.2 + r() * 0.7, 60 + k, "#6a7a42", "#46552c", 1.2, 0.8, 1.2, 1);
		const a = (k / 5) * Math.PI * 2;
		b.translate(Math.cos(a) * 2.2, 4.2 + r(), Math.sin(a) * 2.2);
		parts.push(b);
	}
	return merge(parts);
}

export function shrub() {
	const parts = [];
	const b = blob(1.2, 71, "#5f8640", "#3d5a2b", 1.3, 0.9, 1.3, 1);
	b.translate(0, 0.9, 0);
	parts.push(b);
	const r = rng(73);
	for (let k = 0; k < 10; k++) {
		const f = new THREE.OctahedronGeometry(0.16, 0);
		const a = r() * Math.PI * 2;
		f.translate(Math.cos(a) * 1.3, 1.0 + r() * 0.8, Math.sin(a) * 1.3);
		parts.push(paint(f, k % 3 ? "#f2a2b8" : "#fbeff2"));
	}
	return merge(parts);
}

// Cobra-head freeway / boulevard light (arm points toward the road, -x).
export function streetLight() {
	const parts = [];
	const pole = new THREE.CylinderGeometry(0.09, 0.14, 9, 6, 1);
	pole.translate(0, 4.5, 0);
	parts.push(paint(pole, "#8e9194"));
	const arm = new THREE.CylinderGeometry(0.05, 0.06, 2.6, 5, 1);
	arm.rotateZ(Math.PI / 2 - 0.12);
	arm.translate(-1.25, 9.05, 0);
	parts.push(paint(arm, "#8e9194"));
	const head = new THREE.BoxGeometry(0.75, 0.18, 0.32);
	head.translate(-2.55, 9.15, 0);
	parts.push(paint(head, "#9a9da0"));
	return merge(parts);
}

// Black ornamental post with a globe (downtown streets).
export function lampPost() {
	const parts = [];
	const pole = new THREE.CylinderGeometry(0.07, 0.13, 4.2, 8, 1);
	pole.translate(0, 2.1, 0);
	parts.push(paint(pole, "#23272b"));
	const base = new THREE.CylinderGeometry(0.2, 0.24, 0.6, 8, 1);
	base.translate(0, 0.3, 0);
	parts.push(paint(base, "#23272b"));
	const cap = new THREE.ConeGeometry(0.2, 0.25, 8);
	cap.translate(0, 4.85, 0);
	parts.push(paint(cap, "#23272b"));
	return merge(parts);
}

// Mast-arm traffic signal (arm over the road toward -x).
export function signal() {
	const parts = [];
	const pole = new THREE.CylinderGeometry(0.16, 0.2, 6.2, 8, 1);
	pole.translate(0, 3.1, 0);
	parts.push(paint(pole, "#7c7f82"));
	const arm = new THREE.CylinderGeometry(0.08, 0.12, 9, 6, 1);
	arm.rotateZ(Math.PI / 2);
	arm.translate(-4.5, 5.9, 0);
	parts.push(paint(arm, "#7c7f82"));
	for (const x of [-3.6, -7.2]) {
		const box = new THREE.BoxGeometry(0.36, 1.05, 0.32);
		box.translate(x, 5.3, 0);
		parts.push(paint(box, "#c9a227"));
	}
	return merge(parts);
}

// The three lenses on each signal head (coloured per instance at runtime).
export function signalLenses() {
	const parts = [];
	for (const x of [-3.6, -7.2]) {
		for (let k = 0; k < 3; k++) {
			const l = new THREE.CircleGeometry(0.11, 8);
			l.rotateY(Math.PI / 2);
			l.translate(x + 0.19, 5.62 - k * 0.33, 0);
			parts.push(paint(l, k === 0 ? "#ff3b2f" : k === 1 ? "#ffb21e" : "#3cff8a"));
		}
	}
	return merge(parts);
}

// Small suburban house with a hip roof, used behind freeway sound walls.
export function house() {
	const parts = [];
	const w = new THREE.BoxGeometry(12, 3.2, 9);
	w.translate(0, 1.6, 0);
	parts.push(paint(w, "#e7dcc7"));
	const roof = new THREE.ConeGeometry(8.6, 2.2, 4, 1);
	roof.rotateY(Math.PI / 4);
	roof.scale(1, 1, 0.78);
	roof.translate(0, 4.3, 0);
	parts.push(paint(roof, "#a8603f"));
	return merge(parts);
}

export function rock() {
	const g = blob(1.2, 91, "#a3927a", "#776a58", 1.4, 0.7, 1.1, 0);
	return g;
}
