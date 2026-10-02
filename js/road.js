// Road surface (procedural lane markings in the shader), curbs, sidewalks,
// freeway median barriers, landscaped medians, sound walls and bridges.
// Built in chunks along the route and streamed with the rider.
import { clamp, hash2, lerp, merge, noise2, paint, withFog } from "./util.js";
import { KIND } from "./route.js";
import { NOISE_GLSL, groundDetail } from "./ground.js";

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
// Bicycle stencil (two wheels, frame and rider) painted in a bike lane, local coords in metres.
float bikeGlyph(vec2 p) {
	float w = 0.07;
	float g = 0.0;
	g = max(g, 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.02, abs(length(p - vec2(0.0, -0.55)) - 0.32)));
	g = max(g, 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.02, abs(length(p - vec2(0.0, 0.55)) - 0.32)));
	// frame: seat tube, top tube, down tube as distance to segments
	vec2 A = vec2(0.0, -0.55), Bp = vec2(0.0, 0.0), C = vec2(0.0, 0.55), D = vec2(0.0, 0.35);
	vec2 pa = p - A, ba = C - A;
	float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
	g = max(g, 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.02, length(pa - ba * h)));
	// rider: head and back
	g = max(g, 1.0 - smoothstep(0.1, 0.12, length(p - vec2(0.0, 0.25))));
	vec2 pb = p - Bp, bb = D - Bp;
	h = clamp(dot(pb, bb) / dot(bb, bb), 0.0, 1.0);
	g = max(g, 1.0 - smoothstep(0.05, 0.07, length(pb - bb * h)));
	return g;
}
vec3 roadColor(vec4 r1, vec4 r2, vec3 wpos) {
	float u = r1.x, v = r1.y, hw = r1.z, kind = r1.w;
	float gap = r2.x, R = r2.y, Lp = r2.z, bikeW = r2.w;
	bool fwy = kind < 0.5;
	bool ramp = kind > 0.5 && kind < 1.5;
	bool street = kind > 2.5 && kind < 3.5;
	float dist = length(wpos - uCam);
	float fade = 1.0 - smoothstep(120.0, 600.0, dist);
	float nearF = 1.0 - smoothstep(8.0, 45.0, dist);
	float n = vnoise(vec2(u * 0.9, v * 0.25)) * 0.6 + vnoise(vec2(u * 6.0, v * 3.0)) * 0.4;
	// asphalt: dark binder with lighter aggregate, sun-faded in large blotches
	float agg = vnoise(vLoc * vec2(31.0, 29.0)) * 0.6 + vnoise(vLoc * vec2(83.0, 79.0) + 7.0) * 0.4;
	float stones = smoothstep(0.62, 0.8, agg);
	float age = vnoise(wpos.xz * 0.035) * 0.6 + vnoise(wpos.xz * 0.15) * 0.4;
	vec3 asphalt = mix(vec3(0.24, 0.24, 0.25), vec3(0.37, 0.36, 0.35), age) * (0.88 + n * 0.22);
	asphalt *= 1.0 + (stones * 0.1 - (1.0 - agg) * 0.06) * nearF;
	asphalt *= 0.93 + 0.14 * vnoise(wpos.xz * 1.3) * (0.4 + 0.6 * fade);
	// Caltrans portland-cement concrete: pale, with longitudinal tining
	vec3 conc = vec3(0.62, 0.6, 0.56) * (0.9 + n * 0.16);
	conc *= 1.0 - 0.035 * step(0.5, fract(u * 26.0)) * nearF;
	conc *= 1.0 + (agg - 0.5) * 0.1 * nearF;
	float lanes = max(1.0, floor(2.0 * hw / 3.6 + 0.5));
	float lw = 2.0 * hw / lanes;
	float k = (u + hw) / lw;
	// freeway lanes are concrete, shoulders asphalt
	bool onSlab = fwy && u > -hw - 0.05 && u < hw + 0.05;
	bool onOppSlab = fwy && u < -hw - gap + 0.05 && u > -hw - gap - 2.0 * hw - 0.05;
	vec3 col = (onSlab || onOppSlab) ? conc : asphalt;
	// patched / older asphalt bands and utility-cut patches
	if (!(onSlab || onOppSlab)) {
		col *= 0.93 + 0.12 * vnoise(vec2(v * 0.02, u * 0.05));
		float cell = floor(v / 37.0);
		float ph = vhash(vec2(cell, floor(u / 3.6) + 17.0));
		vec2 pc = vec2(fract(v / 37.0) * 37.0 - 18.5, fract(u / 3.6) * 3.6 - 1.8);
		vec2 sz = vec2(2.0 + 6.0 * vhash(vec2(cell, 3.0)), 0.6 + 0.9 * vhash(vec2(cell, 5.0)));
		float edge = vnoise(vec2(v * 1.7, u * 1.7)) * 0.35;
		if (ph > 0.84 && abs(pc.x) < sz.x - edge && abs(pc.y) < sz.y - edge * 0.5) col *= 0.86 + 0.06 * vnoise(wpos.xz * 2.0);
	}
	// sealed cracks ("tar snakes"): transverse thermal cracks and the paving
	// seam beside lane lines, only on older stretches
	float lanesT = max(1.0, floor(2.0 * hw / 3.6 + 0.5));
	float lwT = 2.0 * hw / lanesT;
	if (!(onSlab || onOppSlab) && fade > 0.0) {
		float cellV = floor(v / 9.0);
		float hv = vhash(vec2(cellV, 4.0));
		float cv = (cellV + 0.2 + 0.6 * hv) * 9.0 + 0.35 * sin(u * 1.3 + hv * 6.0) + 0.12 * sin(u * 4.1 + hv * 17.0);
		float span = step(abs(u - (vhash(vec2(cellV, 9.0)) - 0.5) * 2.0 * hw), hw * (0.4 + 0.6 * vhash(vec2(cellV, 2.0))));
		float tar = (1.0 - smoothstep(0.035, 0.035 + fwidth(v) * 1.5, abs(v - cv))) * step(0.5, hv) * span;
		float kk = (u + hw) / lwT;
		float seamU = -hw + floor(kk + 0.5) * lwT + 0.32 + 0.07 * sin(v * 0.37) + 0.04 * sin(v * 1.13);
		tar = max(tar, (1.0 - smoothstep(0.018, 0.018 + fwidth(u) * 1.5, abs(u - seamU))) * step(0.55, vnoise(vec2(v * 0.025, 3.0))) * step(0.45, vnoise(vec2(v * 0.15, 8.0))) * 0.75);
		col = mix(col, vec3(0.1, 0.1, 0.105), tar * 0.7 * fade * step(0.42, age));
	}
	// wheel paths polished lighter, oil drip strip darker down the lane centre
	if (u > -hw && u < hw) {
		float lc = abs(fract(k) - 0.5) * lw;
		col *= 1.0 + 0.06 * smoothstep(0.35, 0.0, abs(lc - 0.85)) * fade;
		col *= 1.0 - 0.13 * smoothstep(0.45, 0.0, lc) * (0.6 + 0.4 * vnoise(vec2(v * 0.3, u))) * fade;
	}
	if (fwy) {
		// transverse slab joints
		if (onSlab || onOppSlab) col *= 1.0 - 0.25 * lineAA(fract(v / 4.6) * 4.6, 2.3, 0.05) * fade;
		// ground-in rumble strips on the shoulders
		float rs = step(0.5, fract(v / 0.6)) * fade;
		float inR = step(hw + 0.35, u) * step(u, hw + 0.75);
		float inL = step(-hw - 0.75, u) * step(u, -hw - 0.35);
		col *= 1.0 - 0.22 * rs * max(inR, inL);
	}
	vec3 white = vec3(0.92, 0.92, 0.88), yellow = vec3(0.93, 0.74, 0.18);
	float m = 0.0;
	vec3 mc = white;
	float dl = dash(v, 3.0, 12.0);
	// our lane dividers (+ raised reflective markers in the gaps on freeways)
	if (lanes > 1.5 && k > 0.5 && k < lanes - 0.5) {
		float c = -hw + floor(k + 0.5) * lw;
		m = max(m, lineAA(u, c, 0.13) * dl);
		if (fwy || ramp) {
			float rp = fract((v + 6.0) / 12.0) * 12.0;
			float rpm = (1.0 - smoothstep(0.06, 0.09, abs(rp - 1.5))) * (1.0 - smoothstep(0.06, 0.09, abs(u - c)));
			m = max(m, rpm * nearF * 1.5);
		}
	}
	// right edge line (doubles as the bike lane line)
	float edgeU = hw + 0.12;
	m = max(m, lineAA(u, edgeU, 0.15));
	if (bikeW > 0.5) {
		// bike lane: stencil every 160 m with the arrow ahead of it
		float bc = hw + 0.2 + bikeW * 0.5;
		float pv = fract(v / 160.0) * 160.0 - 80.0;
		vec2 bp = vec2(u - bc, pv) / 1.15;
		float g = bikeGlyph(vec2(bp.x, bp.y)) * step(abs(pv), 1.2);
		vec2 ap = vec2(u - bc, pv - 4.2);
		float arrow = (1.0 - smoothstep(0.05, 0.07, abs(ap.x))) * step(-0.9, ap.y) * step(ap.y, 0.3);
		arrow = max(arrow, step(0.3, ap.y) * step(ap.y, 0.9) * step(abs(ap.x), (0.9 - ap.y) * 0.45));
		m = max(m, max(g, arrow) * fade);
	}
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
	// worn thermoplastic: paint shows the aggregate through it close up
	float wear = mix(1.0, 0.7 + 0.3 * smoothstep(0.25, 0.6, agg), nearF) * (0.82 + 0.18 * vnoise(vec2(v * 0.7, u * 2.0)));
	col = mix(col, mc * (0.85 + 0.15 * n), m * 0.92 * wear);
	// beyond the pavement: sidewalk (city) or gravel shoulder (freeway)
	float ofs = max(u - R, Lp - u);
	if (ofs > 0.0) {
		if (fwy || ramp) {
			col = mix(vec3(0.52, 0.47, 0.39), vec3(0.62, 0.56, 0.45), n) ;
			col = mix(col, vec3(0.45, 0.47, 0.30), smoothstep(2.0, 4.5, ofs) * 0.8);
		} else {
			vec3 walk = vec3(0.70, 0.68, 0.64) * (0.92 + n * 0.12);
			walk *= 1.0 - 0.18 * lineAA(fract(v / 1.6) * 1.6, 0.8, 0.03) * fade;
			walk *= 1.0 - 0.06 * smoothstep(0.55, 0.75, agg) * nearF;
			vec3 curb = vec3(0.78, 0.77, 0.74);
			col = ofs < 0.25 ? curb : walk;
			col = mix(col, vec3(0.42, 0.52, 0.27) * (0.85 + n * 0.3), smoothstep(2.3, 2.6, ofs));
		}
	} else {
		// concrete gutter pan along city curbs
		if (!fwy && !ramp) {
			float g = min(R - u, u - Lp);
			col = mix(col, vec3(0.6, 0.59, 0.55) * (0.94 + 0.08 * n), smoothstep(0.62, 0.58, g));
			col *= 1.0 - 0.25 * lineAA(g, 0.6, 0.03) * fade;
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
			.replace("#include <common>", "#include <common>\nattribute vec4 aR1;\nattribute vec4 aR2;\nattribute float aVl;\nvarying vec4 vR1;\nvarying vec4 vR2;\nvarying vec3 vWpos;\nvarying vec2 vLoc;")
			.replace("#include <begin_vertex>", "#include <begin_vertex>\nvR1 = aR1; vR2 = aR2; vLoc = vec2(aR1.x, aVl);")
			.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", "#include <common>\nvarying vec4 vR1;\nvarying vec4 vR2;\nvarying vec3 vWpos;\nvarying vec2 vLoc;\nuniform vec3 uCam;\n" + NOISE_GLSL + ROAD_FRAG)
			.replace("#include <map_fragment>", "diffuseColor.rgb = roadColor(vR1, vR2, vWpos);")
			.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
			#ifdef USE_FOG
			{
				// grazing sky sheen on the asphalt, strongest at golden hour
				float ndv = abs(dot(normalize(-vViewPosition), normal));
				totalEmissiveRadiance += mix(fogColor, fogSunColor, 0.5) * pow(1.0 - ndv, 5.0) * 0.32;
			}
			#endif`);
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
		this.propMat = withFog(new THREE.MeshLambertMaterial({ vertexColors: true }), groundDetail, "prop");
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
		const pos = new Float32Array(rings * S * 3), a1 = new Float32Array(rings * S * 4), a2 = new Float32Array(rings * S * 4), vl = new Float32Array(rings * S);
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
				vl[o] = (i - i0) * r.step;
				a2[o * 4] = r.gap[i]; a2[o * 4 + 1] = R; a2[o * 4 + 2] = L; a2[o * 4 + 3] = r.bike[i];
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
		g.setAttribute("aVl", new THREE.BufferAttribute(vl, 1));
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
