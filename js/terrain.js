// Static far terrain covering the whole ETOPO1 extent. It hides itself
// (fragment discard) wherever a detailed near tile is currently built.
import { clamp, smoothstep, withFog } from "./util.js";
import { coastDistance, terrainHeight, world } from "./world.js";
import { NOISE_GLSL, TILE } from "./ground.js";

export function buildFarTerrain(ground, quality, onRow) {
	const b = world.bounds;
	const sp = quality.far;
	const nx = Math.ceil((b.x1 - b.x0) / sp), nz = Math.ceil((b.z1 - b.z0) / sp);
	const H = new Float32Array((nx + 1) * (nz + 1));
	const CD = new Float32Array((nx + 1) * (nz + 1));
	for (let j = 0; j <= nz; j++) {
		for (let i = 0; i <= nx; i++) {
			const x = b.x0 + i * sp, z = b.z0 + j * sp;
			const cd = coastDistance(x, z, 2500);
			CD[j * (nx + 1) + i] = cd;
			H[j * (nx + 1) + i] = terrainHeight(x, z, cd);
		}
		if (onRow && j % 20 === 0) onRow(j / nz);
	}
	const pos = new Float32Array(H.length * 3), nor = new Float32Array(H.length * 3), col = new Float32Array(H.length * 3);
	const c = new THREE.Color();
	const W = nx + 1;
	for (let j = 0; j <= nz; j++)
		for (let i = 0; i <= nx; i++) {
			const k = j * W + i;
			const h = H[k];
			const hl = H[j * W + Math.max(0, i - 1)], hr = H[j * W + Math.min(nx, i + 1)];
			const hu = H[Math.max(0, j - 1) * W + i], hd = H[Math.min(nz, j + 1) * W + i];
			const dx = (hr - hl) / (2 * sp), dz = (hd - hu) / (2 * sp);
			const L = Math.hypot(dx, 1, dz);
			pos[k * 3] = b.x0 + i * sp; pos[k * 3 + 1] = h; pos[k * 3 + 2] = b.z0 + j * sp;
			nor[k * 3] = -dx / L; nor[k * 3 + 1] = 1 / L; nor[k * 3 + 2] = -dz / L;
			const q = h > -5 && h < 700 ? ground.route.nearest(pos[k * 3], pos[k * 3 + 2], 650) : null;
			ground.color(pos[k * 3], pos[k * 3 + 2], h, Math.hypot(dx, dz) * 1.6, q, CD[k], c);
			if (!q && h > 0) {
				// distant basins read as hazy suburbs; hills as dry chaparral
				const basin = 1 - smoothstep(0.03, 0.12, Math.hypot(dx, dz));
				c.lerp(new THREE.Color("#a39b84"), basin * (h < 650 ? 0.55 : 0.2));
			}
			col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
		}
	const idx = new Uint32Array(nx * nz * 6);
	let o = 0;
	for (let j = 0; j < nz; j++)
		for (let i = 0; i < nx; i++) {
			const a = j * W + i, bb = a + 1, d = a + W, e = d + 1;
			idx[o++] = a; idx[o++] = d; idx[o++] = bb; idx[o++] = bb; idx[o++] = d; idx[o++] = e;
		}
	const g = new THREE.BufferGeometry();
	g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
	g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
	g.setAttribute("color", new THREE.BufferAttribute(col, 3));
	g.setIndex(new THREE.BufferAttribute(idx, 1));
	g.computeBoundingSphere();
	const uniforms = {
		uMask: { value: ground.mask },
		uMaskInfo: { value: new THREE.Vector4(ground.maskTX * TILE, ground.maskTZ * TILE, ground.maskW, ground.maskH) },
	};
	const mat = withFog(new THREE.MeshLambertMaterial({ vertexColors: true }), (shader) => {
		shader.uniforms.uMask = uniforms.uMask;
		shader.uniforms.uMaskInfo = uniforms.uMaskInfo;
		shader.vertexShader = shader.vertexShader
			.replace("#include <common>", "#include <common>\nvarying vec3 vWpos;")
			.replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", "#include <common>\nvarying vec3 vWpos;\nuniform sampler2D uMask;\nuniform vec4 uMaskInfo;\n" + NOISE_GLSL)
			.replace(
				"#include <clipping_planes_fragment>",
				`#include <clipping_planes_fragment>
				{
					vec2 cell = floor((vWpos.xz - uMaskInfo.xy) / ${TILE.toFixed(1)});
					vec2 uv = (cell + 0.5) / uMaskInfo.zw;
					if (texture2D(uMask, uv).r > 0.5) discard;
				}`
			)
			.replace(
				"#include <color_fragment>",
				`#include <color_fragment>
				{
					vec2 p = vWpos.xz;
					float n = vnoise(p * 0.004) * 0.5 + vnoise(p * 0.02) * 0.3 + vnoise(p * 0.09) * 0.2;
					diffuseColor.rgb *= 0.88 + n * 0.24;
				}`
			);
	}, "far");
	const mesh = new THREE.Mesh(g, mat);
	mesh.matrixAutoUpdate = false;
	mesh.receiveShadow = false;
	return { mesh, H, nx, nz, sp };
}

export { clamp };
