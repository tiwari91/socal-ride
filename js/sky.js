// Sky dome, sun and ambient light, haze and time of day.
import { clamp, fogUniforms, lerp, smoothstep } from "./util.js";

const KEYS = [
	// sun elevation (deg), zenith, horizon, sun light, light intensity, hemi sky, hemi ground, hemi intensity, glow
	[-16, "#03060f", "#0b1022", "#334066", 0.0, "#1b2442", "#0a0a10", 0.25, "#000000"],
	[-7, "#0e1638", "#4a3a5e", "#5a5590", 0.05, "#3a3f6a", "#1a1620", 0.35, "#5a2c46"],
	[-2, "#24356c", "#e07a5a", "#ff7a40", 0.35, "#6a6a98", "#3a2a26", 0.5, "#ff6a35"],
	[2, "#3a5a9c", "#ffad6a", "#ff9850", 1.25, "#8a92b8", "#5a4632", 0.6, "#ff8a3c"],
	[7, "#4a73b8", "#f4c995", "#ffc283", 2.1, "#9fb0cc", "#6d5a42", 0.7, "#ffb066"],
	[16, "#4f86cc", "#d6dfdc", "#ffe7c4", 2.6, "#a8bfd8", "#7a6a50", 0.75, "#ffd9a0"],
	[40, "#3d7ccf", "#bcd5e6", "#fff6ea", 2.9, "#b0c8e2", "#80725a", 0.8, "#ffe8c0"],
];
const KC = KEYS.map((k) => k.map((v) => (typeof v === "string" ? new THREE.Color(v) : v)));

const SKY_VS = `
varying vec3 vDir;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
	vDir = position;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	#include <logdepthbuf_vertex>
}`;
const SKY_FS = `
uniform vec3 uZenith, uHorizon, uGlow, uSunDir, uSunColor, uGround;
uniform float uStars, uTime, uGloom, uSunVis;
varying vec3 vDir;
#include <common>
#include <logdepthbuf_pars_fragment>
float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n2(p); p *= 2.07; a *= 0.5; } return s; }
void main() {
	vec3 d = normalize(vDir);
	float h = d.y;
	float t = pow(1.0 - clamp(h, 0.0, 1.0), 3.2);
	vec3 col = mix(uZenith, uHorizon, t);
	float sd = max(dot(d, uSunDir), 0.0);
	col += uGlow * (pow(sd, 6.0) * 0.55 + pow(sd, 32.0) * 0.6) * (0.35 + 0.65 * t);
	col += uGlow * 0.25 * pow(sd, 2.0) * t;
	// cirrus streaks
	vec2 cp = d.xz / (h + 0.18);
	float c = fbm(cp * vec2(0.9, 2.4) + vec2(uTime * 0.004, 0.0));
	float cl = smoothstep(0.52, 0.86, c) * smoothstep(0.0, 0.12, h) * (1.0 - uGloom);
	vec3 cloudCol = mix(uHorizon * 1.15 + 0.04, uGlow * 1.2 + uHorizon * 0.4, pow(sd, 3.0) * 0.8);
	col = mix(col, cloudCol, cl * 0.55);
	// sun disc
	float disc = smoothstep(0.99955, 0.99975, dot(d, uSunDir));
	col += uSunColor * disc * 12.0 * uSunVis * (1.0 - uGloom * 0.9);
	// stars
	if (uStars > 0.01 && h > 0.0) {
		vec2 g = floor(d.xz / (h + 0.4) * 260.0);
		float s = h21(g);
		col += vec3(smoothstep(0.9975, 1.0, s)) * uStars * 1.5 * smoothstep(0.0, 0.25, h);
	}
	// marine layer: flat grey overcast
	vec3 grey = mix(vec3(0.62, 0.65, 0.68), uHorizon, 0.35) * (0.4 + 0.6 * clamp(uSunVis + 0.3, 0.0, 1.0));
	col = mix(col, grey * (0.92 + 0.12 * fbm(cp * 0.6)), uGloom * smoothstep(-0.05, 0.25, h + 0.1));
	// below horizon fade into haze/ground
	col = mix(col, uGround, smoothstep(0.0, -0.08, h));
	gl_FragColor = vec4(col, 1.0);
	#include <logdepthbuf_fragment>
	#include <tonemapping_fragment>
	#include <encodings_fragment>
}`;

export class Sky {
	constructor(scene, renderer, quality) {
		this.scene = scene;
		this.renderer = renderer;
		this.uniforms = {
			uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
			uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 0.9, 0.8) }, uGround: { value: new THREE.Color() },
			uStars: { value: 0 }, uTime: { value: 0 }, uGloom: { value: 0 }, uSunVis: { value: 1 },
		};
		const mat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false });
		this.dome = new THREE.Mesh(new THREE.SphereGeometry(90000, 48, 24), mat);
		this.dome.frustumCulled = false;
		this.dome.renderOrder = -10;
		scene.add(this.dome);

		this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
		this.sun.castShadow = quality.shadows;
		const sc = this.sun.shadow.camera;
		sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 260;
		this.sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
		this.sun.shadow.bias = -0.0004;
		this.sun.shadow.normalBias = 0.03;
		scene.add(this.sun, this.sun.target);
		this.hemi = new THREE.HemisphereLight(0xb0c8e2, 0x80725a, 0.8);
		scene.add(this.hemi);
		scene.fog = new THREE.FogExp2(0xbcd5e6, 2.2e-5);
		this.state = { el: 30, az: 180, hour: 9, gloom: 0, night: 0 };

		// environment map for chrome and paint, regenerated as the light changes
		this.pmrem = new THREE.PMREMGenerator(renderer);
		this.envScene = new THREE.Scene();
		this.envDome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat);
		this.envScene.add(this.envDome);
		this.envTarget = null;
		this.lastEnv = { el: -999, gloom: -1 };
		this.tmp = { a: new THREE.Color(), b: new THREE.Color() };
	}

	sunAt(hour) {
		const rise = 6.75, set = 17.0;
		const f = (hour - rise) / (set - rise);
		let el = 37 * Math.sin(Math.PI * f);
		if (f < 0 || f > 1) el = -Math.min(18, Math.abs(f < 0 ? f : f - 1) * 80);
		const az = lerp(115, 245, clamp(f, -0.15, 1.15));
		return { el, az };
	}

	set(hour, gloom, focus, dt) {
		const { el, az } = this.sunAt(hour);
		const st = this.state;
		st.hour = hour;
		st.el = el;
		st.az = az;
		st.gloom = gloom;
		const e = THREE.MathUtils.degToRad(el), a = THREE.MathUtils.degToRad(az);
		const dir = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
		this.uniforms.uSunDir.value.copy(dir);
		// palette interpolation
		let k = 0;
		while (k < KC.length - 2 && el > KC[k + 1][0]) k++;
		const A = KC[k], B = KC[k + 1];
		const t = clamp((el - A[0]) / (B[0] - A[0]), 0, 1);
		const mix = (i, out) => out.copy(A[i]).lerp(B[i], t);
		const U = this.uniforms;
		mix(1, U.uZenith.value);
		mix(2, U.uHorizon.value);
		mix(8, U.uGlow.value);
		U.uSunVis.value = smoothstep(-1.5, 1.0, el);
		U.uGloom.value = gloom;
		U.uStars.value = smoothstep(-5, -12, el) * (1 - gloom);
		U.uSunColor.value.copy(A[3]).lerp(B[3], t).multiplyScalar(1.4);
		const hz = U.uHorizon.value;
		const grey = this.tmp.a.set("#a6adb2");
		U.uGround.value.copy(hz).lerp(grey, gloom * 0.6).multiplyScalar(0.92);
		// lights
		this.sun.color.copy(A[3]).lerp(B[3], t);
		this.sun.intensity = lerp(A[4], B[4], t) * 0.62 * (1 - gloom * 0.72);
		this.hemi.color.copy(A[5]).lerp(B[5], t).lerp(grey, gloom * 0.5);
		this.hemi.groundColor.copy(A[6]).lerp(B[6], t);
		this.hemi.intensity = lerp(A[7], B[7], t) * lerp(1.0, 0.75, smoothstep(2, 20, el)) * (1 + gloom * 0.35);
		// haze colour follows the horizon; sun-side haze glows warm
		const fog = this.scene.fog;
		fog.color.copy(hz).lerp(grey, gloom * 0.7);
		fog.density = lerp(2.3e-5, 3.0e-5, smoothstep(12, 0, el)) + gloom * 1.9e-4;
		fogUniforms.fogSunColor.value.copy(U.uGlow.value).lerp(hz, 0.3).multiplyScalar(1 - gloom * 0.8);
		st.night = smoothstep(2, -6, el);
		// shadow light follows the rider
		if (focus) {
			const L = 120;
			this.sun.position.set(focus.x + dir.x * L, focus.y + Math.max(dir.y, 0.08) * L, focus.z + dir.z * L);
			this.sun.target.position.copy(focus);
			this.sun.target.updateMatrixWorld();
		}
		U.uTime.value += dt || 0;
	}

	updateFogView(camera) {
		const v = fogUniforms.fogSunView.value.copy(this.uniforms.uSunDir.value).transformDirection(camera.matrixWorldInverse);
		return v;
	}

	maybeEnv(force) {
		const st = this.state;
		if (!force && Math.abs(st.el - this.lastEnv.el) < 1.5 && Math.abs(st.gloom - this.lastEnv.gloom) < 0.08) return null;
		this.lastEnv = { el: st.el, gloom: st.gloom };
		const old = this.envTarget;
		this.envTarget = this.pmrem.fromScene(this.envScene, 0.02);
		if (old) old.dispose();
		return this.envTarget.texture;
	}
}
