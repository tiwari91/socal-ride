// Road surface (procedural lane markings in the shader), curbs, sidewalks,
// freeway median barriers, landscaped medians, sound walls and bridges.
// Built in chunks along the route and streamed with the rider.
import { clamp, hash2, lerp, merge, noise2, paint, withFog } from "./util.js";
import { KIND } from "./route.js";
import { NOISE_GLSL } from "./ground.js";

const CH = 50; // samples per chunk (300 m)

const ROAD_FRAG = `
float lineAA(float u, float c, float w) {
	float d = abs(u - c);
	float aa = max(fwidth(u), 0.002) * 0.75;
	return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, d);
}
float dash(float v, float on, float period) {
	float f = fract(v / period) * period;
	float aa = max(fwidth(v), 0.01);
	return smoothstep(0.0, aa, f) * (1.0 - smoothstep(on - aa, on, f));
}
vec3 roadColor(vec4 r1, vec4 r2, vec3 wpos) {
	float u = r1.x, v = r1.y, hw = r1.z, kind = r1.w;
	float gap = r2.x, R = r2.y, Lp = r2.z;
	bool fwy = kind < 0.5;
	bool ramp = kind > 0.5 && kind < 1.5;
	bool street = kind > 2.5 && kind < 3.5;
	float n = vnoise(vec2(u * 0.9, v * 0.25)) * 0.6 + vnoise(vec2(u * 6.0, v * 3.0)) * 0.4;
	vec3 asphalt = vec3(0.30, 0.30, 0.315) * (0.86 + n * 0.25);
	vec3 conc = vec3(0.60, 0.585, 0.55) * (0.9 + n * 0.16);
	vec3 col = fwy ? conc : asphalt;
	// patched / older asphalt bands
	if (!fwy) col *= 0.93 + 0.12 * vnoise(vec2(v * 0.02, u * 0.05));
	float dist = length(wpos - cameraPosition);
	float fade = 1.0 - smoothstep(120.0, 600.0, dist);
	float lanes = max(1.0, floor(2.0 * hw / 3.6 + 0.5));
	float lw = 2.0 * hw / lanes;
	// wheel-track wear inside each of our lanes
	float k = (u + hw) / lw;
	if (u > -hw && u < hw) {
		float lc = abs(fract(k) - 0.5) * lw;
		col *= 1.0 - 0.07 * smoothstep(0.35, 0.0, abs(lc - 0.85)) * fade;
	}
	if (fwy) {
		// transverse slab joints
		col *= 1.0 - 0.25 * lineAA(fract(v / 4.6) * 4.6, 2.3, 0.05) * fade;
	}
	vec3 white = vec3(0.92, 0.92, 0.88), yellow = vec3(0.93, 0.74, 0.18);
	float m = 0.0;
	vec3 mc = white;
	float dl = fwy ? dash(v, 3.0, 12.0) : dash(v, 3.0, 12.0);
	// our lane dividers
	if (lanes > 1.5 && k > 0.5 && k < lanes - 0.5) {
		float c = -hw + floor(k + 0.5) * lw;
		m = max(m, lineAA(u, c, 0.13) * dl);
	}
	// right edge
	m = max(m, lineAA(u, hw + 0.12, 0.15));
	float oppIn = -hw - gap;
	if (fwy || ramp) {
		float y = lineAA(u, -hw - 0.12, 0.15);
		if (y > 0.0) { mc = mix(mc, yellow, step(m, y)); m = max(m, y); }
	} else {
		float c = -hw - gap * 0.5;
		float y = max(lineAA(u, c - 0.14, 0.11), lineAA(u, c + 0.14, 0.11));
		if (gap > 2.0) y = max(lineAA(u, -hw - 0.15, 0.12), lineAA(u, oppIn + 0.15, 0.12));
		if (y > 0.0) { mc = mix(mc, yellow, step(m, y)); m = max(m, y); }
	}
	if (!ramp) {
		float ko = (oppIn - u) / lw;
		if (lanes > 1.5 && ko > 0.5 && ko < lanes - 0.5) {
			float c = oppIn - floor(ko + 0.5) * lw;
			m = max(m, lineAA(u, c, 0.13) * dash(v + 5.0, 3.0, 12.0));
		}
		m = max(m, lineAA(u, oppIn - 2.0 * hw - 0.12, 0.15));
		if (fwy) {
			float y = lineAA(u, oppIn + 0.12, 0.15);
			if (y > 0.0) { mc = mix(mc, yellow, step(m, y)); m = max(m, y); }
		}
	}
	col = mix(col, mc * (0.85 + 0.15 * n), m * 0.92);
	// beyond the pavement: sidewalk (city) or gravel shoulder (freeway)
	float ofs = max(u - R, Lp - u);
	if (ofs > 0.0) {
		if (fwy || ramp) {
			col = mix(vec3(0.52, 0.47, 0.39), vec3(0.62, 0.56, 0.45), n) ;
			col = mix(col, vec3(0.45, 0.47, 0.30), smoothstep(2.0, 4.5, ofs) * 0.8);
		} else {
			vec3 walk = vec3(0.70, 0.68, 0.64) * (0.92 + n * 0.12);
			walk *= 1.0 - 0.18 * lineAA(fract(v / 1.6) * 1.6, 0.8, 0.03) * fade;
			vec3 curb = vec3(0.78, 0.77, 0.74);
			col = ofs < 0.25 ? curb : walk;
			col = mix(col, vec3(0.42, 0.52, 0.27) * (0.85 + n * 0.3), smoothstep(2.3, 2.6, ofs));
		}
	} else {
		// gutter band along city curbs
		if (!fwy && !ramp) {
			float g = min(R - u, u - Lp);
			col = mix(col, vec3(0.55, 0.54, 0.51), smoothstep(0.6, 0.5, g));
		}
	}
	return pow(col, vec3(2.2));
}
`;

export function roadMaterial() {
	const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
	mat.extensions = { derivatives: true };
	return withFog(mat, (shader) => {
		shader.vertexShader = shader.vertexShader
			.replace("#include <common>", "#include <common>\nattribute vec4 aR1;\nattribute vec4 aR2;\nvarying vec4 vR1;\nvarying vec4 vR2;\nvarying vec3 vWpos;")
			.replace("#include <begin_vertex>", "#include <begin_vertex>\nvR1 = aR1; vR2 = aR2;")
			.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", "#include <common>\nvarying vec4 vR1;\nvarying vec4 vR2;\nvarying vec3 vWpos;\n" + NOISE_GLSL + ROAD_FRAG)
			.replace("#include <map_fragment>", "diffuseColor.rgb = roadColor(vR1, vR2, vWpos);");
	}, "road");
}

export class Roads {
	constructor(route, ground, quality) {
		this.route = route;
		this.ground = ground;
		this.q = quality;
		this.group = new THREE.Group();
		this.chunks = new Map();
		this.mat = roadMaterial();
		this.propMat = withFog(new THREE.MeshLambertMaterial({ vertexColors: true }), null, "prop");
		this.wallMask = this.computeWalls();
	}

	computeWalls() {
		const r = this.route, n = r.n;
		const m = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			const z = r.zoneAt(i * r.step);
			if (r.kind[i] !== KIND.freeway || r.fwy[i] < 0.9) continue;
			if (z !== "ie-freeway" && z !== "oc-freeway") continue;
			// walls come and go in long runs
			const v = noise2(i / 260, 3.7) + (z === "oc-freeway" ? 0.35 : 0.1);
			if (v > 0.05) m[i] = 1;
		}
		for (const b of r.bridges) for (let i = b.c - 60; i <= b.c + 60; i++) if (i >= 0 && i < n) m[i] = 0;
		return m;
	}

	update(s) {
		const r = this.route;
		const c0 = Math.max(0, Math.floor((s - 1200) / r.step / CH)), c1 = Math.min(Math.floor((r.n - 2) / CH), Math.floor((s + this.q.ahead) / r.step / CH));
		for (const [k, ch] of this.chunks) {
			if (k < c0 || k > c1) {
				this.group.remove(ch);
				ch.traverse((o) => o.geometry && o.geometry.dispose());
				this.chunks.delete(k);
			}
		}
		let built = 0;
		for (let k = c0; k <= c1 && built < 2; k++) {
			if (this.chunks.has(k)) continue;
			const g = this.buildChunk(k);
			this.chunks.set(k, g);
			this.group.add(g);
			built++;
		}
		return built;
	}

	ensure(s) {
		while (this.update(s) > 0);
	}

	buildChunk(k) {
		const r = this.route;
		const i0 = k * CH, i1 = Math.min(r.n - 1, (k + 1) * CH);
		const group = new THREE.Group();
		group.add(this.buildSurface(i0, i1));
		const props = this.buildProps(i0, i1);
		if (props) group.add(props);
		return group;
	}

	buildSurface(i0, i1) {
		const r = this.route;
		const S = 10;
		const rings = i1 - i0 + 1;
		const pos = new Float32Array(rings * S * 3), a1 = new Float32Array(rings * S * 4), a2 = new Float32Array(rings * S * 4);
		for (let i = i0, ring = 0; i <= i1; i++, ring++) {
			const x = r.X[i], z = r.Z[i], y = r.Y[i];
			const rx = -r.TZ[i], rz = r.TX[i];
			const R = r.R[i], L = r.Lp[i];
			const k = r.kind[i];
			const city = k === KIND.boulevard || k === KIND.street || k === KIND.coast;
			const cb = city ? 0.15 : 0.02;
			const br = r.bridgeMask[i] > 0;
			let us = [L - 6, L - 4.5, L - 2.4, L - 0.001, L, R, R + 0.001, R + 2.4, R + 4.5, R + 6];
			let hs = [-0.35, 0.05, cb, cb, 0, 0, cb, cb, 0.05, -0.35];
			if (br) {
				us = [L - 0.6, L - 0.6, L - 0.6, L - 0.3, L, R, R + 0.3, R + 0.6, R + 0.6, R + 0.6];
				hs = [-1.6, -1.6, -1.6, 0.0, 0, 0, 0.0, -1.6, -1.6, -1.6];
			}
			for (let s = 0; s < S; s++) {
				const o = (ring * S + s);
				pos[o * 3] = x + rx * us[s];
				pos[o * 3 + 1] = y + hs[s];
				pos[o * 3 + 2] = z + rz * us[s];
				a1[o * 4] = us[s]; a1[o * 4 + 1] = i * r.step; a1[o * 4 + 2] = r.hw[i]; a1[o * 4 + 3] = k;
				a2[o * 4] = r.gap[i]; a2[o * 4 + 1] = R; a2[o * 4 + 2] = L; a2[o * 4 + 3] = cb;
			}
		}
		const idx = [];
		for (let ring = 0; ring < rings - 1; ring++)
			for (let s = 0; s < S - 1; s++) {
				const a = ring * S + s, b = a + 1, c = a + S, d = c + 1;
				idx.push(a, b, c, b, d, c);
			}
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
		g.setAttribute("aR1", new THREE.BufferAttribute(a1, 4));
		g.setAttribute("aR2", new THREE.BufferAttribute(a2, 4));
		g.setIndex(idx);
		g.computeVertexNormals();
		// keep the driving surface normals straight up for even shading
		const nr = g.attributes.normal;
		for (let o = 0; o < nr.count; o++) {
			const s = o % S;
			if (s >= 3 && s <= 6) nr.setXYZ(o, 0, 1, 0);
		}
		const mesh = new THREE.Mesh(g, this.mat);
		mesh.receiveShadow = true;
		mesh.matrixAutoUpdate = false;
		return mesh;
	}

	// Profile swept along the route between samples i0..i1 at lateral offset fn(i).
	sweep(i0, i1, profile, offset, color, mask) {
		const r = this.route;
		const P = profile.length;
		const pos = [], idx = [];
		let ring = 0;
		let started = false;
		for (let i = i0; i <= i1; i++) {
			if (mask && !mask(i)) {
				started = false;
				continue;
			}
			const x = r.X[i], z = r.Z[i], y = r.Y[i];
			const rx = -r.TZ[i], rz = r.TX[i];
			const off = offset(i);
			for (const [du, dy] of profile) pos.push(x + rx * (off + du), y + dy, z + rz * (off + du));
			if (started) {
				const a = (ring - 1) * P, b = ring * P;
				for (let p = 0; p < P - 1; p++) idx.push(a + p, a + p + 1, b + p, a + p + 1, b + p + 1, b + p);
			}
			started = true;
			ring++;
		}
		if (idx.length === 0) return null;
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
		g.setIndex(idx);
		const ng = g.toNonIndexed();
		ng.computeVertexNormals();
		return paint(ng, color);
	}

	buildProps(i0, i1) {
		const r = this.route;
		const parts = [];
		const fwy = (i) => r.kind[i] === KIND.freeway && r.fwy[i] > 0.6;
		// concrete median barrier (Jersey profile)
		const jersey = [[-0.3, -0.05], [-0.28, 0.08], [-0.12, 0.3], [-0.09, 0.82], [0.09, 0.82], [0.12, 0.3], [0.28, 0.08], [0.3, -0.05]];
		const b = this.sweep(i0, i1, jersey, (i) => -r.hw[i] - r.gap[i] * 0.5, "#b3ada2", fwy);
		if (b) parts.push(b);
		// landscaped medians on wide boulevards
		const med = (i) => r.med[i] > 0 && r.gap[i] > 3;
		const mL = this.sweep(i0, i1, [[0, 0], [0, 0.18], [0.25, 0.2]], (i) => -r.hw[i] - r.gap[i] + 0.25, "#c9c6bd", med);
		const mR = this.sweep(i0, i1, [[-0.25, 0.2], [0, 0.18], [0, 0]], (i) => -r.hw[i] - 0.25, "#c9c6bd", med);
		if (mL) parts.push(mL);
		if (mR) parts.push(mR);
		const grass = this.sweepMedianGrass(i0, i1, med);
		if (grass) parts.push(grass);
		// sound walls on the outer edges of urban freeways
		const wallP = [[0, -3], [0, 4.6], [0.25, 4.75], [0.5, 4.6], [0.5, -3]];
		const wm = (i) => this.wallMask[i] > 0;
		const wR = this.sweep(i0, i1, wallP, (i) => r.R[i] + 7.5, "#cdbb98", wm);
		const wallPL = wallP.map(([u, y]) => [-u, y]).reverse();
		const wL = this.sweep(i0, i1, wallPL, (i) => r.Lp[i] - 7.5, "#c7b593", wm);
		if (wR) parts.push(wR);
		if (wL) parts.push(wL);
		// steel guard rail on ramps and freeway edges outside walls
		const railP = [[0, 0.55], [0.05, 0.62], [0.05, 0.88], [0, 0.95]];
		const rail = (i) => (r.kind[i] === KIND.ramp || (fwy(i) && !this.wallMask[i] && r.zoneAt(i * r.step) === "canyon")) && hash2(Math.floor(i / 40), 7) > 0.35;
		const gr = this.sweep(i0, i1, railP, (i) => r.R[i] + 1.2, "#a9adb0", rail);
		if (gr) parts.push(gr);
		// bridges: parapets and piers
		for (const br of r.bridges) {
			if (br.c + 14 < i0 || br.c - 14 > i1) continue;
			const bm = (i) => Math.abs(i - br.c) <= 13;
			const pp = [[0, 0], [0, 1.0], [0.35, 1.0], [0.35, -1.6]];
			const pR = this.sweep(Math.max(i0, br.c - 13), Math.min(i1, br.c + 13), pp, (i) => r.R[i] + 0.25, "#bdb6aa", bm);
			const pL = this.sweep(Math.max(i0, br.c - 13), Math.min(i1, br.c + 13), pp.map(([u, y]) => [-u, y]).reverse(), (i) => r.Lp[i] - 0.25, "#bdb6aa", bm);
			if (pR) parts.push(pR);
			if (pL) parts.push(pL);
			if (br.c >= i0 && br.c <= i1) {
				for (const off of [-1, 1]) {
					const i = br.c + off * 3;
					const x = r.X[i], z = r.Z[i];
					const top = r.Y[i] - 1.6, bot = r.ground[i] - 2;
					const mid = (r.R[i] + r.Lp[i]) / 2;
					const geo = new THREE.BoxGeometry(1.4, top - bot, Math.abs(r.R[i] - r.Lp[i]) * 0.8);
					geo.rotateY(-Math.atan2(r.TZ[i], r.TX[i]));
					geo.translate(x - r.TZ[i] * mid, (top + bot) / 2, z + r.TX[i] * mid);
					parts.push(paint(geo, "#a8a197"));
				}
			}
		}
		if (!parts.length) return null;
		const mesh = new THREE.Mesh(merge(parts), this.propMat);
		mesh.receiveShadow = true;
		mesh.castShadow = false;
		mesh.matrixAutoUpdate = false;
		return mesh;
	}

	sweepMedianGrass(i0, i1, mask) {
		const r = this.route;
		const pos = [], col = [], idx = [];
		let ring = 0, started = false;
		const c = new THREE.Color();
		for (let i = i0; i <= i1; i++) {
			if (!mask(i)) {
				started = false;
				continue;
			}
			const x = r.X[i], z = r.Z[i], y = r.Y[i] + 0.2;
			const rx = -r.TZ[i], rz = r.TX[i];
			const a = -r.hw[i] - r.gap[i] + 0.25, b = -r.hw[i] - 0.25;
			for (let s = 0; s <= 4; s++) {
				const u = lerp(a, b, s / 4);
				pos.push(x + rx * u, y + 0.04 * Math.sin(s * 1.3), z + rz * u);
				c.set("#5f8c3f").multiplyScalar(0.85 + 0.3 * hash2(i, s));
				col.push(c.r, c.g, c.b);
			}
			if (started) {
				const A = (ring - 1) * 5, B = ring * 5;
				for (let p = 0; p < 4; p++) idx.push(A + p, A + p + 1, B + p, A + p + 1, B + p + 1, B + p);
			}
			started = true;
			ring++;
		}
		if (!idx.length) return null;
		const g = new THREE.BufferGeometry();
		g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
		g.setIndex(idx);
		const ng = g.toNonIndexed();
		ng.computeVertexNormals();
		return ng;
	}
}

export { clamp };
