// Pacific Ocean surface and an animated surf band along the OSM coastline.
import { fogUniforms } from "./util.js";

const WATER_VS = `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec3 vW;
void main() {
	vec4 wp = modelMatrix * vec4(position, 1.0);
	vW = wp.xyz;
	vec4 mvPosition = viewMatrix * wp;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <fog_vertex>
}`;
const WATER_FS = `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uDeep;
uniform float uTime, uGloom;
varying vec3 vW;
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
float waves(vec2 p) {
	float t = uTime;
	float h = 0.0;
	h += sin(dot(p, vec2(0.021, 0.034)) + t * 0.9) * 0.5;
	h += sin(dot(p, vec2(-0.043, 0.027)) + t * 1.3) * 0.3;
	h += (n2(p * 0.11 + vec2(t * 0.15, t * 0.08)) - 0.5) * 0.7;
	h += (n2(p * 0.37 - vec2(t * 0.22, -t * 0.1)) - 0.5) * 0.35;
	return h;
}
void main() {
	vec3 V = normalize(cameraPosition - vW);
	float dist = length(cameraPosition - vW);
	vec2 p = vW.xz;
	float e = 0.6;
	float hx = waves(p + vec2(e, 0.0)) - waves(p - vec2(e, 0.0));
	float hz = waves(p + vec2(0.0, e)) - waves(p - vec2(0.0, e));
	float k = 0.35 * (1.0 - smoothstep(200.0, 4000.0, dist));
	vec3 N = normalize(vec3(-hx * k, 1.0, -hz * k));
	vec3 R = reflect(-V, N);
	float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
	vec3 sky = mix(uHorizon, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.6));
	vec3 col = mix(uDeep, sky * 0.78, clamp(fres, 0.0, 1.0) * 0.8);
	float sd = max(dot(R, uSunDir), 0.0);
	col += uSunColor * (pow(sd, 900.0) * 6.0 + pow(sd, 60.0) * 0.5) * (1.0 - uGloom * 0.85);
	gl_FragColor = vec4(col, 1.0);
	#include <logdepthbuf_fragment>
	#include <tonemapping_fragment>
	#include <encodings_fragment>
	#include <fog_fragment>
}`;

const SURF_FS = `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform vec3 uLight;
varying vec2 vUv;
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n1(float x) { float i = floor(x), f = fract(x); return mix(h21(vec2(i, 1.0)), h21(vec2(i + 1.0, 1.0)), f * f * (3.0 - 2.0 * f)); }
void main() {
	float w = vUv.y;
	float a = vUv.x;
	float jitter = n1(a * 0.02) * 1.6 + n1(a * 0.11) * 0.4;
	float ph = w * 3.2 + uTime * 0.11 + jitter;
	float band = fract(ph);
	float crest = smoothstep(0.78, 0.92, band) * (1.0 - smoothstep(0.92, 1.0, band));
	float broken = 0.55 + 0.45 * n1(a * 0.35 + floor(ph) * 7.0);
	float foam = crest * broken * (1.0 - smoothstep(0.2, 0.95, w));
	float swash = smoothstep(0.12, 0.0, w + 0.03 * sin(uTime * 0.7 + a * 0.05)) * (0.7 + 0.3 * n1(a * 0.2 + uTime));
	foam = max(foam, swash);
	vec3 shallow = vec3(0.24, 0.52, 0.50);
	vec3 col = mix(shallow, vec3(0.95, 0.97, 0.96), foam) * uLight;
	float alpha = max(foam * 0.95, (1.0 - smoothstep(0.0, 1.0, w)) * 0.45);
	gl_FragColor = vec4(col, alpha);
	#include <logdepthbuf_fragment>
	#include <tonemapping_fragment>
	#include <encodings_fragment>
	#include <fog_fragment>
}`;
const SURF_VS = `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
	vUv = uv;
	vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <fog_vertex>
}`;

export class Ocean {
	constructor(scene, sky, coast) {
		const U = sky.uniforms;
		this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
		Object.assign(this.uniforms, {
			uSunDir: U.uSunDir, uSunColor: U.uSunColor, uZenith: U.uZenith, uHorizon: U.uHorizon,
			uDeep: { value: new THREE.Color("#0d3a4c") }, uTime: { value: 0 }, uGloom: U.uGloom,
			fogSunView: fogUniforms.fogSunView, fogSunColor: fogUniforms.fogSunColor,
		});
		const mat = new THREE.ShaderMaterial({ vertexShader: WATER_VS, fragmentShader: WATER_FS, uniforms: this.uniforms, fog: true });
		const geo = new THREE.PlaneGeometry(260000, 260000, 8, 8);
		geo.rotateX(-Math.PI / 2);
		this.mesh = new THREE.Mesh(geo, mat);
		this.mesh.position.set(-60000, 0, 60000);
		this.mesh.frustumCulled = false;
		scene.add(this.mesh);

		this.surfU = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
		Object.assign(this.surfU, { uTime: this.uniforms.uTime, uLight: { value: new THREE.Color(1, 1, 1) },
			fogSunView: fogUniforms.fogSunView, fogSunColor: fogUniforms.fogSunColor });
		const smat = new THREE.ShaderMaterial({ vertexShader: SURF_VS, fragmentShader: SURF_FS, uniforms: this.surfU, fog: true, transparent: true, depthWrite: false });
		this.surf = new THREE.Mesh(buildSurf(coast), smat);
		this.surf.renderOrder = 2;
		this.surf.frustumCulled = false;
		scene.add(this.surf);
	}

	update(dt, sky) {
		this.uniforms.uTime.value += dt;
		const L = sky.sun.intensity * 0.32 + sky.hemi.intensity * 0.55;
		this.surfU.uLight.value.setScalar(Math.min(1.1, L)).lerp(sky.sun.color, 0.2);
		this.uniforms.uDeep.value.set("#0d3a4c").multiplyScalar(Math.min(1, 0.25 + L * 0.6));
	}
}

function buildSurf(lines) {
	const pos = [], uv = [], idx = [];
	const W = 70;
	for (const L of lines || []) {
		const n = L.length / 2;
		if (n < 2) continue;
		let along = 0;
		const base = pos.length / 3;
		for (let i = 0; i < n; i++) {
			const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
			const dx = L[2 * b] - L[2 * a], dz = L[2 * b + 1] - L[2 * a + 1];
			const len = Math.hypot(dx, dz) || 1;
			const sx = -dz / len, sz = dx / len; // sea side (right of the way)
			if (i > 0) along += Math.hypot(L[2 * i] - L[2 * i - 2], L[2 * i + 1] - L[2 * i - 1]);
			const x = L[2 * i], z = L[2 * i + 1];
			pos.push(x - sx * 4, 0.12, z - sz * 4, x + sx * W, 0.06, z + sz * W);
			uv.push(along, 0, along, 1);
			if (i > 0) {
				const p = base + (i - 1) * 2, q = base + i * 2;
				idx.push(p, p + 1, q, p + 1, q + 1, q);
			}
		}
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
	g.setIndex(idx);
	return g;
}
