// Small math, noise and geometry helpers shared by every module.
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
	const t = clamp((v - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};
export const damp = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));
export const wrapAngle = (a) => {
	while (a > Math.PI) a -= Math.PI * 2;
	while (a < -Math.PI) a += Math.PI * 2;
	return a;
};

export function rng(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s |= 0;
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function hash2(x, y) {
	let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function noise2(x, y) {
	const xi = Math.floor(x), yi = Math.floor(y);
	const xf = x - xi, yf = y - yi;
	const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
	const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
	return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}

export function fbm(x, y, oct = 4) {
	let s = 0, a = 0.5, f = 1;
	for (let i = 0; i < oct; i++) {
		s += a * noise2(x * f, y * f);
		f *= 2.03;
		a *= 0.5;
	}
	return s;
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export const store = {
	get(k, d) {
		try {
			const v = localStorage.getItem("c2s." + k);
			return v === null ? d : JSON.parse(v);
		} catch (e) {
			return d;
		}
	},
	set(k, v) {
		try {
			localStorage.setItem("c2s." + k, JSON.stringify(v));
		} catch (e) {
			/* storage unavailable */
		}
	},
};

// Paint every vertex of a geometry with one colour (for merged vertex-coloured meshes).
export function paint(geo, color) {
	const c = new THREE.Color(color);
	const n = geo.attributes.position.count;
	const arr = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		arr[i * 3] = c.r;
		arr[i * 3 + 1] = c.g;
		arr[i * 3 + 2] = c.b;
	}
	geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
	return geo;
}

// Merge non-indexed copies of geometries that all carry position/normal/color.
export function merge(geos) {
	const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
	let n = 0;
	for (const g of parts) n += g.attributes.position.count;
	const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
	let o = 0;
	for (const g of parts) {
		if (!g.attributes.normal) g.computeVertexNormals();
		pos.set(g.attributes.position.array, o * 3);
		nor.set(g.attributes.normal.array, o * 3);
		if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
		else col.fill(1, o * 3, (o + g.attributes.position.count) * 3);
		o += g.attributes.position.count;
	}
	const out = new THREE.BufferGeometry();
	out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
	out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
	out.setAttribute("color", new THREE.BufferAttribute(col, 3));
	return out;
}

// Shared uniforms injected into materials for sun-tinted haze.
export const fogUniforms = {
	fogSunView: { value: null },
	fogSunColor: { value: null },
	uTime: { value: 0 },
};

export function installFogChunks() {
	fogUniforms.fogSunView.value = new THREE.Vector3(0, 0, -1);
	fogUniforms.fogSunColor.value = new THREE.Color(1, 0.8, 0.6);
	const C = THREE.ShaderChunk;
	C.fog_pars_vertex = "#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vFogView;\n#endif";
	C.fog_vertex = "#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vFogView = mvPosition.xyz;\n#endif";
	C.fog_pars_fragment = [
		"#ifdef USE_FOG",
		" uniform vec3 fogColor;",
		" varying float vFogDepth;",
		" varying vec3 vFogView;",
		" uniform vec3 fogSunView;",
		" uniform vec3 fogSunColor;",
		" #ifdef FOG_EXP2",
		"  uniform float fogDensity;",
		" #else",
		"  uniform float fogNear;",
		"  uniform float fogFar;",
		" #endif",
		"#endif",
	].join("\n");
	C.fog_fragment = [
		"#ifdef USE_FOG",
		" #ifdef FOG_EXP2",
		"  float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );",
		" #else",
		"  float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );",
		" #endif",
		" float sunAmt = pow( max( dot( normalize( vFogView ), fogSunView ), 0.0 ), 6.0 );",
		" vec3 fogC = mix( fogColor, fogSunColor, sunAmt * 0.75 );",
		" gl_FragColor.rgb = mix( gl_FragColor.rgb, fogC, fogFactor );",
		"#endif",
	].join("\n");
}

// Attach the shared fog uniforms (plus optional extra shader edits) to a built-in material.
export function withFog(mat, edit, key = "fog") {
	const prev = mat.onBeforeCompile;
	mat.customProgramCacheKey = () => key;
	mat.onBeforeCompile = (shader, r) => {
		shader.uniforms.fogSunView = fogUniforms.fogSunView;
		shader.uniforms.fogSunColor = fogUniforms.fogSunColor;
		shader.uniforms.uTime = fogUniforms.uTime;
		if (prev && prev !== THREE.Material.prototype.onBeforeCompile) prev(shader, r);
		if (edit) edit(shader);
	};
	return mat;
}
