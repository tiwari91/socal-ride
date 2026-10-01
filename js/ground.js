// Ground near the route: streamed height-field tiles shaped around the road
// (flat verges, embankments, cuts, bridges), coloured by zone and OSM land use.
// The static far terrain discards fragments wherever a near tile is present.
import { clamp, fbm, lerp, noise2, smoothstep, withFog } from "./util.js";
import { coastDistance, terrainHeight, world } from "./world.js";

export const TILE = 500;
const C = (h) => new THREE.Color(h);
const PAL = {
	lawn: C("#6f8c45"), lawnDry: C("#9a9a58"), urban: C("#a49d8b"), dirt: C("#a58e6a"),
	gold: C("#c4a86c"), gold2: C("#b39557"), chap: C("#626a3d"), chap2: C("#77784a"),
	sage: C("#8f9468"), sand: C("#e3d2a3"), wet: C("#b7a47c"), rock: C("#a28f73"), cliff: C("#b69a73"),
	green: C("#5f9441"), golf: C("#5d9a3f"), farm: C("#8f7752"), orchard: C("#5d5b38"), wood: C("#4f5e35"),
	water: C("#4d7c80"), seabed: C("#3d5f60"), forest: C("#41532f"), peak: C("#8f877b"),
};
const ZONE_BASE = {
	redlands: ["lawn", "urban", 0.45], riverside: ["lawn", "urban", 0.5], "ie-freeway": ["gold", "chap2", 0.35],
	canyon: ["gold", "chap", 0.45], "oc-city": ["lawn", "urban", 0.55], "oc-freeway": ["lawnDry", "urban", 0.4],
	irvine: ["lawn", "green", 0.5], coast: ["sage", "lawn", 0.4], laguna: ["sage", "chap2", 0.45],
};

export class Ground {
	constructor(route, scenery, quality) {
		this.route = route;
		this.q = quality;
		this.tiles = new Map();
		this.queue = [];
		this.group = new THREE.Group();
		this.buildLand(scenery.landuse || []);
		this.mat = withFog(new THREE.MeshLambertMaterial({ vertexColors: true }), groundDetail, "ground");
		const b = world.bounds;
		this.maskTX = Math.floor(b.x0 / TILE);
		this.maskTZ = Math.floor(b.z0 / TILE);
		this.maskW = Math.ceil(b.x1 / TILE) - this.maskTX + 1;
		this.maskH = Math.ceil(b.z1 / TILE) - this.maskTZ + 1;
		this.maskData = new Uint8Array(this.maskW * this.maskH * 4);
		this.mask = new THREE.DataTexture(this.maskData, this.maskW, this.maskH, THREE.RGBAFormat, THREE.UnsignedByteType);
		this.mask.magFilter = this.mask.minFilter = THREE.NearestFilter;
		this.mask.needsUpdate = true;
	}

	// ---------- land use polygons ----------
	buildLand(list) {
		this.land = [];
		this.landGrid = new Map();
		const G = 400;
		list.forEach(([type, flat]) => {
			let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
			for (let i = 0; i < flat.length; i += 2) {
				x0 = Math.min(x0, flat[i]); x1 = Math.max(x1, flat[i]);
				z0 = Math.min(z0, flat[i + 1]); z1 = Math.max(z1, flat[i + 1]);
			}
			const k = this.land.length;
			this.land.push({ type, p: flat, box: [x0, z0, x1, z1] });
			for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++)
				for (let j = Math.floor(z0 / G); j <= Math.floor(z1 / G); j++) {
					const key = i * 65536 + j;
					if (!this.landGrid.has(key)) this.landGrid.set(key, []);
					this.landGrid.get(key).push(k);
				}
		});
	}

	landAt(x, z) {
		const list = this.landGrid.get(Math.floor(x / 400) * 65536 + Math.floor(z / 400));
		if (!list) return null;
		let found = null;
		for (const k of list) {
			const L = this.land[k];
			if (x < L.box[0] || x > L.box[2] || z < L.box[1] || z > L.box[3]) continue;
			const p = L.p;
			let inside = false;
			for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
				if (p[i + 1] > z !== p[j + 1] > z && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
			}
			if (inside) {
				if (!found || L.type === "golf" || L.type === "green") found = L.type;
			}
		}
		return found;
	}

	// ---------- height ----------
	edge(q) {
		const r = this.route, i = q.i;
		return q.lat >= 0 ? lerp(r.R[i], r.R[i + 1], q.t) : -lerp(r.Lp[i], r.Lp[i + 1], q.t);
	}

	partHeight(q, H) {
		const r = this.route, i = q.i;
		const e = q.d - this.edge(q);
		const ref = r.bridgeMask[i] ? lerp(r.ground[i], r.ground[i + 1], q.t) : lerp(r.Y[i], r.Y[i + 1], q.t);
		const B = r.blend[i];
		const t = smoothstep(7, B, e);
		return { h: lerp(ref - 0.35, H, t), e };
	}

	// Ground height at (x,z). cands: optional candidate list for speed.
	height(x, z, H) {
		if (H === undefined) H = terrainHeight(x, z);
		const r = this.route;
		const q1 = r.nearest(x, z, 700);
		if (!q1) return H;
		const a = this.partHeight(q1, H);
		const q2 = r.nearest(x, z, 700, q1.i - 60, q1.i + 60);
		if (!q2) return a.h;
		const b = this.partHeight(q2, H);
		const wa = 1 / Math.pow(Math.max(a.e, 0.5) + 2, 3), wb = 1 / Math.pow(Math.max(b.e, 0.5) + 2, 3);
		return (a.h * wa + b.h * wb) / (wa + wb);
	}

	info(x, z) {
		const H = terrainHeight(x, z);
		const q = this.route.nearest(x, z, 700);
		return { h: this.height(x, z, H), H, q };
	}

	// ---------- colour ----------
	color(x, z, h, slope, q, cd, out) {
		const r = this.route;
		let zone = "ie-freeway", e = 1e4;
		if (q) {
			zone = r.zoneAt(q.s);
			e = q.d - this.edge(q);
		}
		const zb = ZONE_BASE[zone] || ZONE_BASE["ie-freeway"];
		const n1 = fbm(x / 140, z / 140, 3), n2 = noise2(x / 23, z / 23);
		out.copy(PAL[zb[0]]).lerp(PAL[zb[1]], clamp(zb[2] + n1 * 0.9, 0, 1));
		const city = zone === "redlands" || zone === "riverside" || zone === "oc-city" || zone === "irvine";
		if (city && e < 160) out.lerp(PAL.urban, clamp(0.25 + noise2(x / 60, z / 60) * 0.6, 0, 0.65));
		if (!city && e > 20 && e < 140 && (zone === "ie-freeway" || zone === "oc-freeway")) out.lerp(PAL.urban, 0.25);
		const lu = this.landAt(x, z);
		if (lu && PAL[lu]) out.lerp(PAL[lu], 0.85);
		// slopes: chaparral on shady faces, bare dirt on the steepest
		if (slope > 0.12) out.lerp(PAL.chap, smoothstep(0.12, 0.35, slope) * 0.7);
		if (slope > 0.45) out.lerp(PAL.rock, smoothstep(0.45, 0.9, slope) * 0.8);
		if (h > 1500) out.lerp(PAL.forest, smoothstep(1500, 2000, h) * 0.8);
		if (h > 2900) out.lerp(PAL.peak, smoothstep(2900, 3200, h));
		// coast
		if (cd < 1e5) {
			if (cd < 70 && h < 6) out.lerp(PAL.sand, smoothstep(70, 30, cd) * 0.95);
			if (cd < 16) out.lerp(PAL.wet, smoothstep(16, 0, cd));
			if (cd < 0) out.copy(PAL.seabed);
			if (cd > 15 && cd < 140 && slope > 0.5) out.lerp(PAL.cliff, 0.8);
		}
		if (e < 7) out.lerp(PAL.dirt, 0.5);
		const v = 1 + n2 * 0.06 + n1 * 0.05;
		out.r *= v; out.g *= v; out.b *= v;
		return out;
	}

	// ---------- tile streaming ----------
	wanted(s, ahead, behind) {
		const r = this.route, set = new Map();
		const i0 = Math.max(0, Math.floor((s - behind) / r.step)), i1 = Math.min(r.n - 1, Math.ceil((s + ahead) / r.step));
		const pad = 640;
		for (let i = i0; i <= i1; i += 8) {
			const x = r.X[i], z = r.Z[i];
			for (let tx = Math.floor((x - pad) / TILE); tx <= Math.floor((x + pad) / TILE); tx++)
				for (let tz = Math.floor((z - pad) / TILE); tz <= Math.floor((z + pad) / TILE); tz++) {
					const cx = clamp(x, tx * TILE, tx * TILE + TILE), cz = clamp(z, tz * TILE, tz * TILE + TILE);
					const d = Math.hypot(cx - x, cz - z);
					if (d > pad) continue;
					const key = tx * 65536 + tz;
					const fine = d < 170 ? 1 : 0;
					set.set(key, Math.max(set.get(key) || 0, fine));
				}
		}
		return set;
	}

	update(s, budgetMs) {
		const want = this.wanted(s, this.q.ahead, 1300);
		for (const [key, t] of this.tiles) {
			if (!want.has(key)) {
				if (t.mesh) {
					this.group.remove(t.mesh);
					t.mesh.geometry.dispose();
				}
				this.setMask(key, 0);
				this.tiles.delete(key);
			}
		}
		for (const [key, fine] of want) {
			const t = this.tiles.get(key);
			if (!t) {
				this.tiles.set(key, { key, fine, gen: null, mesh: null });
			}
		}
		// build nearest tiles first
		const pos = this.route.at(s);
		const pending = [...this.tiles.values()].filter((t) => !t.mesh);
		pending.sort((a, b) => tileDist(a.key, pos) - tileDist(b.key, pos));
		const t0 = performance.now();
		for (const t of pending) {
			if (!t.gen) t.gen = this.buildTile(t);
			while (performance.now() - t0 < budgetMs) {
				const r = t.gen.next();
				if (r.done) break;
			}
			if (performance.now() - t0 >= budgetMs) break;
		}
		return pending.length;
	}

	pendingCount() {
		let n = 0;
		for (const t of this.tiles.values()) if (!t.mesh) n++;
		return n;
	}

	setMask(key, v) {
		const tx = Math.floor(key / 65536 + 0.5), tz = key - tx * 65536;
		const ix = tx - this.maskTX, iz = tz - this.maskTZ;
		if (ix < 0 || iz < 0 || ix >= this.maskW || iz >= this.maskH) return;
		this.maskData.fill(v, (iz * this.maskW + ix) * 4, (iz * this.maskW + ix) * 4 + 4);
		this.mask.needsUpdate = true;
	}

	*buildTile(t) {
		const tx = Math.floor(t.key / 65536 + 0.5), tz = t.key - tx * 65536;
		const sp = t.fine ? this.q.fine : this.q.coarse;
		const n = Math.round(TILE / sp);
		const N = n + 3; // one extra ring for normals
		const x0 = tx * TILE, z0 = tz * TILE;
		const H = new Float32Array(N * N);
		const Q = new Array(N * N);
		const CD = new Float32Array(N * N);
		for (let j = 0; j < N; j++) {
			for (let i = 0; i < N; i++) {
				const x = x0 + (i - 1) * sp, z = z0 + (j - 1) * sp;
				const cd = coastDistance(x, z);
				const h0 = terrainHeight(x, z, cd);
				H[j * N + i] = this.height(x, z, h0);
				CD[j * N + i] = cd;
				if (i >= 1 && j >= 1 && i <= n + 1 && j <= n + 1) Q[j * N + i] = this.route.nearest(x, z, 700);
			}
			if (j % 3 === 2) yield;
		}
		const verts = (n + 1) * (n + 1);
		const skirt = 4 * (n + 1);
		const pos = new Float32Array((verts + skirt) * 3), nor = new Float32Array((verts + skirt) * 3), col = new Float32Array((verts + skirt) * 3);
		const c = new THREE.Color();
		let k = 0;
		for (let j = 0; j <= n; j++) {
			for (let i = 0; i <= n; i++) {
				const a = (j + 1) * N + (i + 1);
				const x = x0 + i * sp, z = z0 + j * sp, h = H[a];
				const dx = (H[a + 1] - H[a - 1]) / (2 * sp), dz = (H[a + N] - H[a - N]) / (2 * sp);
				const L = Math.hypot(dx, 1, dz);
				pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
				nor[k * 3] = -dx / L; nor[k * 3 + 1] = 1 / L; nor[k * 3 + 2] = -dz / L;
				this.color(x, z, h, Math.hypot(dx, dz), Q[a], CD[a], c);
				col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
				k++;
			}
			if (j % 6 === 5) yield;
		}
		const idx = [];
		for (let j = 0; j < n; j++)
			for (let i = 0; i < n; i++) {
				const a = j * (n + 1) + i, b = a + 1, d = a + n + 1, e = d + 1;
				idx.push(a, d, b, b, d, e);
			}
		// skirts hang below the four edges to hide cracks between LODs
		const edges = [];
		for (let i = 0; i <= n; i++) edges.push([i, 0], [i, n], [0, i], [n, i]);
		const skirtIdx = new Map();
		for (const [i, j] of edges) {
			const src = j * (n + 1) + i;
			const keyS = src;
			if (skirtIdx.has(keyS)) continue;
			skirtIdx.set(keyS, k);
			pos[k * 3] = pos[src * 3]; pos[k * 3 + 1] = pos[src * 3 + 1] - 25; pos[k * 3 + 2] = pos[src * 3 + 2];
			nor[k * 3 + 1] = 1;
			col[k * 3] = col[src * 3]; col[k * 3 + 1] = col[src * 3 + 1]; col[k * 3 + 2] = col[src * 3 + 2];
			k++;
		}
		const side = (a, b) => {
			const sa = skirtIdx.get(a), sb = skirtIdx.get(b);
			idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb);
		};
		for (let i = 0; i < n; i++) {
			side(i, i + 1);
			side(n * (n + 1) + i, n * (n + 1) + i + 1);
			side(i * (n + 1), (i + 1) * (n + 1));
			side(i * (n + 1) + n, (i + 1) * (n + 1) + n);
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, k * 3), 3));
		g.setAttribute("normal", new THREE.BufferAttribute(nor.subarray(0, k * 3), 3));
		g.setAttribute("color", new THREE.BufferAttribute(col.subarray(0, k * 3), 3));
		g.setIndex(idx);
		g.computeBoundingSphere();
		const mesh = new THREE.Mesh(g, this.mat);
		mesh.receiveShadow = true;
		mesh.matrixAutoUpdate = false;
		t.mesh = mesh;
		if (this.tiles.get(t.key) === t) {
			this.group.add(mesh);
			this.setMask(t.key, 255);
		}
	}
}

function tileDist(key, p) {
	const tx = Math.floor(key / 65536 + 0.5), tz = key - tx * 65536;
	return Math.hypot(tx * TILE + TILE / 2 - p.x, tz * TILE + TILE / 2 - p.z);
}

// Fragment-level colour breakup so large triangles never look flat.
export function groundDetail(shader) {
	shader.vertexShader = shader.vertexShader
		.replace("#include <common>", "#include <common>\nvarying vec3 vWpos;")
		.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
	shader.fragmentShader = shader.fragmentShader
		.replace("#include <common>", "#include <common>\nvarying vec3 vWpos;\n" + NOISE_GLSL)
		.replace(
			"#include <color_fragment>",
			`#include <color_fragment>
			{
				vec2 p = vWpos.xz;
				float n = vnoise(p * 0.11) * 0.5 + vnoise(p * 0.43) * 0.3 + vnoise(p * 1.7) * 0.2;
				float far = smoothstep(150.0, 900.0, length(vWpos - cameraPosition));
				diffuseColor.rgb *= mix(0.86 + n * 0.28, 1.0, far * 0.6);
			}`
		);
}

export const NOISE_GLSL = `
float vhash(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(vhash(i), vhash(i + vec2(1.0, 0.0)), u.x), mix(vhash(i + vec2(0.0, 1.0)), vhash(i + vec2(1.0, 1.0)), u.x), u.y);
}`;
