// OSM building footprints extruded per route chunk, styled by area:
// mission-revival stucco and red tile in Redlands/Riverside, glass offices
// in Irvine, pastel beach houses at the coast. Windows are drawn in the shader
// and some of them light up at dusk.
import { clamp, hash2, withFog } from "./util.js";
import { NOISE_GLSL } from "./ground.js";

const CH = 50;
const WALLS = {
	mission: ["#efe5d0", "#eadbbd", "#f3eee4", "#e2cda6", "#e9d9c0"],
	suburb: ["#e8dcc6", "#d9ccb6", "#efe7da", "#cdbfa8", "#e3d3bb"],
	office: ["#9aa8b2", "#b9c1c4", "#d8d4cb", "#8e9ea9"],
	coast: ["#f1e9dc", "#e6efef", "#f0dccb", "#dfe7e3", "#f5f0e6", "#e9dcc9"],
};
const ROOFS = { tile: "#b2603c", tile2: "#9f5233", grey: "#6f6c66", flat: "#a7a29a", flat2: "#8c8880" };

const FRAG = `
uniform float uNight;
varying vec3 vWpos;
varying vec2 vWall;
varying float vStyle;
float wh(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 facade(vec3 base, out float lit) {
	lit = 0.0;
	float u = vWall.x, v = vWall.y, st = vStyle;
	if (st > 2.5) return base; // roof
	vec3 glass = vec3(0.16, 0.2, 0.25);
	float win = 0.0;
	vec2 cell;
	if (st > 1.5) { // office: continuous glass bands
		float fl = 3.8;
		float f = fract(v / fl);
		float band = step(0.24, f) * step(f, 0.92);
		float mull = step(0.07, fract(u / 1.6));
		win = band * mull;
		cell = vec2(floor(u / 1.6), floor(v / fl));
		glass = mix(vec3(0.2, 0.27, 0.33), vec3(0.42, 0.52, 0.6), 0.5 + 0.5 * sin(cell.x * 0.7 + cell.y));
	} else if (st > 0.5) { // shops / mission: big ground floor windows, smaller upstairs
		float fl = 3.6;
		float f = fract(v / fl);
		float floorN = floor(v / fl);
		float w = floorN < 0.5 ? step(0.18, fract(u / 4.5)) * step(fract(u / 4.5), 0.78) * step(0.22, f) * step(f, 0.82)
			: step(0.35, fract(u / 3.2)) * step(fract(u / 3.2), 0.68) * step(0.3, f) * step(f, 0.75);
		win = w;
		cell = vec2(floor(u / 3.2), floorN);
	} else { // houses
		float fl = 3.0;
		float f = fract(v / fl);
		win = step(0.55, fract(u / 4.6)) * step(fract(u / 4.6), 0.83) * step(0.35, f) * step(f, 0.78);
		cell = vec2(floor(u / 4.6), floor(v / fl));
	}
	if (v < 0.4) win = 0.0;
	float on = step(0.55, wh(cell + floor(vWpos.xz / 50.0)));
	lit = win * on * uNight;
	vec3 c = mix(base, glass, win * 0.9);
	return c;
}`;

export class Buildings {
	constructor(route, ground, list, quality) {
		this.route = route;
		this.ground = ground;
		this.q = quality;
		this.group = new THREE.Group();
		this.byChunk = new Map();
		this.meshes = new Map();
		for (const b of list) {
			const q = route.nearest(b[0], b[1], 260);
			if (!q) continue;
			const k = Math.floor(q.i / CH);
			if (!this.byChunk.has(k)) this.byChunk.set(k, []);
			this.byChunk.get(k).push(b);
		}
		this.uNight = { value: 0 };
		const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
		this.mat = withFog(mat, (sh) => {
			sh.uniforms.uNight = this.uNight;
			sh.vertexShader = sh.vertexShader
				.replace("#include <common>", "#include <common>\nattribute vec3 aWall;\nvarying vec3 vWpos;\nvarying vec2 vWall;\nvarying float vStyle;")
				.replace("#include <begin_vertex>", "#include <begin_vertex>\nvWall = aWall.xy; vStyle = aWall.z;")
				.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
			sh.fragmentShader = sh.fragmentShader
				.replace("#include <common>", "#include <common>\n" + NOISE_GLSL + FRAG)
				.replace("#include <color_fragment>", "#include <color_fragment>\nfloat litW;\ndiffuseColor.rgb = facade(diffuseColor.rgb, litW);")
				.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.62, 0.3) * litW * 0.32;");
		}, "bld");
	}

	styleFor(zone, type, area, h) {
		if (zone === "irvine" && (type === 4 || area > 1200 || h > 14)) return "office";
		if (type === 4 && h > 10) return "office";
		if (zone === "redlands" || zone === "riverside") return "mission";
		if (zone === "coast" || zone === "laguna") return "coast";
		return "suburb";
	}

	build(k) {
		const list = this.byChunk.get(k);
		if (!list) return null;
		const r = this.route;
		const pos = [], col = [], wall = [], idx = [];
		const c = new THREE.Color(), cr = new THREE.Color();
		const push = (x, y, z, color, u, v, st) => {
			pos.push(x, y, z);
			col.push(color.r, color.g, color.b);
			wall.push(u, v, st);
			return pos.length / 3 - 1;
		};
		for (const b of list) {
			const [cx, cz, hTag, type, ring] = b;
			const n = ring.length / 2;
			const pts = [];
			for (let i = 0; i < n; i++) pts.push([cx + ring[2 * i] / 2, cz + ring[2 * i + 1] / 2]);
			let area = 0;
			for (let i = 0; i < n; i++) {
				const a = pts[i], bb = pts[(i + 1) % n];
				area += a[0] * bb[1] - bb[0] * a[1];
			}
			area = Math.abs(area) / 2;
			const q = r.nearest(cx, cz, 260);
			const zone = q ? r.zoneAt(q.s) : "suburb";
			const hsh = hash2(Math.round(cx), Math.round(cz));
			let h = hTag;
			if (!h) {
				if (type === 8) h = 3;
				else if (type === 4) h = zone === "irvine" ? 18 + hsh * 40 : 12;
				else if (type === 5) h = 13 + hsh * 6;
				else if (type === 2) h = 9 + hsh * 4;
				else if (type === 6) h = 10;
				else if (type === 7) h = 12;
				else if (type === 1) h = area > 260 ? 7 : 4.8;
				else h = area < 160 ? 4.8 : area < 700 ? 6.5 + hsh * 2 : area < 3000 ? 8 + hsh * 3 : zone === "irvine" ? 14 + hsh * 22 : 10;
			}
			h = clamp(h, 3, 120);
			const style = this.styleFor(zone, type, area, h);
			const pal = WALLS[style];
			c.set(pal[Math.floor(hsh * pal.length) % pal.length]);
			const house = (type === 1 || (type === 0 && area < 320)) && h < 9;
			const st = style === "office" ? 2 : house ? 0 : 1;
			// base sits at the lowest ground under the footprint
			let base = 1e9;
			for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4))) base = Math.min(base, this.ground.height(pts[i][0], pts[i][1]));
			base = Math.min(base, this.ground.height(cx, cz));
			const y0 = base - 1.5, y1 = base + h;
			let u = 0;
			for (let i = 0; i < n; i++) {
				const a = pts[i], bb = pts[(i + 1) % n];
				const L = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
				const v0 = push(a[0], y0, a[1], c, u, -1.5, st);
				const v1 = push(bb[0], y0, bb[1], c, u + L, -1.5, st);
				const v2 = push(bb[0], y1, bb[1], c, u + L, h, st);
				const v3 = push(a[0], y1, a[1], c, u, h, st);
				idx.push(v0, v2, v1, v0, v3, v2);
				u += L;
			}
			// roof
			const tile = style === "mission" || (house && hsh > 0.35) || (style === "coast" && hsh > 0.55);
			cr.set(tile ? (hsh > 0.7 ? ROOFS.tile2 : ROOFS.tile) : house ? ROOFS.grey : hsh > 0.5 ? ROOFS.flat : ROOFS.flat2);
			if (house) {
				const rise = Math.min(2.2, Math.sqrt(area) * 0.18);
				const inner = pts.map((p) => [cx + (p[0] - cx) * 0.25, cz + (p[1] - cz) * 0.25]);
				const ov = 1.08;
				for (let i = 0; i < n; i++) {
					const a = pts[i], bb = pts[(i + 1) % n];
					const ai = inner[i], bi = inner[(i + 1) % n];
					const A = push(cx + (a[0] - cx) * ov, y1 - 0.15, cz + (a[1] - cz) * ov, cr, 0, 0, 3);
					const Bv = push(cx + (bb[0] - cx) * ov, y1 - 0.15, cz + (bb[1] - cz) * ov, cr, 0, 0, 3);
					const C2 = push(bi[0], y1 + rise, bi[1], cr, 0, 0, 3);
					const D = push(ai[0], y1 + rise, ai[1], cr, 0, 0, 3);
					idx.push(A, C2, Bv, A, D, C2);
				}
				const ctr = push(cx, y1 + rise, cz, cr, 0, 0, 3);
				for (let i = 0; i < n; i++) {
					const a = push(inner[i][0], y1 + rise, inner[i][1], cr, 0, 0, 3);
					const bb = push(inner[(i + 1) % n][0], y1 + rise, inner[(i + 1) % n][1], cr, 0, 0, 3);
					idx.push(ctr, bb, a);
				}
			} else {
				const ctr = push(cx, y1, cz, cr, 0, 0, 3);
				for (let i = 0; i < n; i++) {
					const a = push(pts[i][0], y1, pts[i][1], cr, 0, 0, 3);
					const bb = push(pts[(i + 1) % n][0], y1, pts[(i + 1) % n][1], cr, 0, 0, 3);
					idx.push(ctr, bb, a);
				}
				if (style === "mission" && h < 16) {
					// Spanish tile pent roof along the parapet
					const tc = new THREE.Color(ROOFS.tile);
					for (let i = 0; i < n; i++) {
						const a = pts[i], bb = pts[(i + 1) % n];
						const out = (p, f) => [cx + (p[0] - cx) * f, cz + (p[1] - cz) * f];
						const s = Math.sqrt(area);
						const fo = 1 + 0.7 / s, fi = 1 - 1.4 / s;
						const ao = out(a, fo), bo = out(bb, fo), ai = out(a, fi), bi = out(bb, fi);
						const A = push(ao[0], y1 - 0.35, ao[1], tc, 0, 0, 3);
						const Bv = push(bo[0], y1 - 0.35, bo[1], tc, 0, 0, 3);
						const C2 = push(bi[0], y1 + 0.55, bi[1], tc, 0, 0, 3);
						const D = push(ai[0], y1 + 0.55, ai[1], tc, 0, 0, 3);
						idx.push(A, C2, Bv, A, D, C2);
					}
				}
			}
		}
		if (!idx.length) return null;
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
		g.setAttribute("aWall", new THREE.Float32BufferAttribute(wall, 3));
		g.setIndex(idx);
		const ng = g.toNonIndexed();
		ng.computeVertexNormals();
		const mesh = new THREE.Mesh(ng, this.mat);
		mesh.matrixAutoUpdate = false;
		mesh.receiveShadow = true;
		mesh.castShadow = false;
		return mesh;
	}

	update(s) {
		const r = this.route;
		const c0 = Math.max(0, Math.floor((s - 900) / r.step / CH)), c1 = Math.floor((s + this.q.ahead * 0.9) / r.step / CH);
		for (const [k, m] of this.meshes) {
			if (k < c0 || k > c1) {
				if (m) {
					this.group.remove(m);
					m.geometry.dispose();
				}
				this.meshes.delete(k);
			}
		}
		let built = 0;
		const cur = Math.floor(s / r.step / CH);
		const order = [];
		for (let k = c0; k <= c1; k++) if (!this.meshes.has(k)) order.push(k);
		order.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
		for (const k of order) {
			const m = this.build(k);
			this.meshes.set(k, m);
			if (m) this.group.add(m);
			if (++built >= 2) break;
		}
		return order.length - built;
	}

	setNight(n) {
		this.uNight.value = n;
	}
}
