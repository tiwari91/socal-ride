// Trees, groves, street furniture and suburban rooftops placed procedurally
// along the route by zone, streamed in 300 m chunks into instanced meshes.
import { clamp, hash2, lerp, noise2, rng, withFog } from "./util.js";
import { KIND } from "./route.js";
import * as M from "./models.js";

const CH = 50;
const TYPES = {
	fanPalm: { make: M.fanPalm, cap: 2600, shadow: true },
	featherPalm: { make: M.featherPalm, cap: 1600, shadow: true },
	orange: { make: () => M.orangeTree(0), cap: 9000 },
	orangeLod: { make: () => M.orangeTree(1), cap: 16000 },
	eucalyptus: { make: M.eucalyptus, cap: 2600, shadow: true },
	jacaranda: { make: M.jacaranda, cap: 1600, shadow: true },
	oak: { make: M.oak, cap: 4000, shadow: true },
	shrub: { make: M.shrub, cap: 6000 },
	streetLight: { make: M.streetLight, cap: 900 },
	lampPost: { make: M.lampPost, cap: 700 },
	signal: { make: M.signal, cap: 120 },
	lenses: { make: M.signalLenses, cap: 120, basic: true },
	house: { make: M.house, cap: 5000 },
	rock: { make: M.rock, cap: 1500 },
};
const ZONE_TREES = {
	redlands: [["fanPalm", 0.4], ["jacaranda", 0.15], ["oak", 0.45]],
	riverside: [["fanPalm", 0.6], ["oak", 0.25], ["jacaranda", 0.15]],
	"oc-city": [["fanPalm", 0.45], ["featherPalm", 0.2], ["oak", 0.25], ["eucalyptus", 0.1]],
	irvine: [["jacaranda", 0.45], ["eucalyptus", 0.2], ["featherPalm", 0.15], ["oak", 0.2]],
	coast: [["featherPalm", 0.45], ["fanPalm", 0.35], ["oak", 0.2]],
	laguna: [["featherPalm", 0.35], ["fanPalm", 0.3], ["eucalyptus", 0.1], ["oak", 0.25]],
};
const SPACING = { redlands: 15, riverside: 13, "oc-city": 19, irvine: 17, coast: 19, laguna: 17 };

function pick(list, r) {
	let t = r * list.reduce((a, b) => a + b[1], 0);
	for (const [k, w] of list) if ((t -= w) <= 0) return k;
	return list[0][0];
}

export class Scenery {
	constructor(route, ground, roads, scenery, quality) {
		this.route = route;
		this.ground = ground;
		this.roads = roads;
		this.q = quality;
		this.group = new THREE.Group();
		this.chunks = new Map();
		this.dirty = true;
		this.mat = withFog(new THREE.MeshLambertMaterial({ vertexColors: true }), null, "inst");
		this.basicMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
		this.pools = {};
		for (const [k, T] of Object.entries(TYPES)) {
			const geo = T.make();
			const cap = Math.round(T.cap * (k === "orange" || k === "orangeLod" || k === "shrub" || k === "house" ? Math.max(0.5, quality.density) : 1));
			const mesh = new THREE.InstancedMesh(geo, T.basic ? this.basicMat : this.mat, cap);
			mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			mesh.count = 0;
			mesh.frustumCulled = false;
			mesh.castShadow = false;
			mesh.receiveShadow = false;
			mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
			this.pools[k] = { mesh, cap };
			this.group.add(mesh);
		}
		this.indexStreets(scenery.streets || []);
		this.indexBuildings(scenery.buildings || []);
		this.findIntersections(scenery.streets || []);
		// soft contact shadows under trees (cheap, no shadow map)
		const disc = new THREE.CircleGeometry(1, 14);
		disc.rotateX(-Math.PI / 2);
		this.discCap = 9000;
		this.disc = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ color: 0x101408, transparent: true, opacity: 0.26, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), this.discCap);
		this.disc.frustumCulled = false;
		this.disc.count = 0;
		this.disc.renderOrder = 1;
		this.group.add(this.disc);
		this.sunDir = new THREE.Vector3(0.3, 0.8, 0.3);
		// glow sprites for lamps at dusk
		this.glowGeo = new THREE.BufferGeometry();
		this.glowGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 2000), 3));
		this.glowGeo.setDrawRange(0, 0);
		this.glow = new THREE.Points(this.glowGeo, new THREE.PointsMaterial({ size: 3.2, map: glowTexture(), color: 0xffc779, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: true }));
		this.glow.frustumCulled = false;
		this.group.add(this.glow);
		this.tmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color(), up: new THREE.Vector3(0, 1, 0) };
	}

	indexStreets(list) {
		this.streets = new Map();
		for (const [w, flat] of list) {
			for (let i = 0; i + 3 < flat.length; i += 2) {
				const seg = [flat[i], flat[i + 1], flat[i + 2], flat[i + 3], w / 2];
				const x0 = Math.floor(Math.min(seg[0], seg[2]) / 40), x1 = Math.floor(Math.max(seg[0], seg[2]) / 40);
				const z0 = Math.floor(Math.min(seg[1], seg[3]) / 40), z1 = Math.floor(Math.max(seg[1], seg[3]) / 40);
				for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) {
					const k = a * 65536 + b;
					if (!this.streets.has(k)) this.streets.set(k, []);
					this.streets.get(k).push(seg);
				}
			}
		}
	}

	onStreet(x, z, margin) {
		const list = this.streets.get(Math.floor(x / 40) * 65536 + Math.floor(z / 40));
		if (!list) return false;
		for (const s of list) {
			const dx = s[2] - s[0], dz = s[3] - s[1];
			const L2 = dx * dx + dz * dz || 1;
			const t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / L2, 0, 1);
			if (Math.hypot(x - s[0] - dx * t, z - s[1] - dz * t) < s[4] + margin) return true;
		}
		return false;
	}

	indexBuildings(list) {
		this.blds = new Map();
		for (const b of list) {
			let r = 0;
			const ring = b[4];
			for (let i = 0; i < ring.length; i += 2) r = Math.max(r, Math.hypot(ring[i], ring[i + 1]) / 2);
			const k = Math.floor(b[0] / 40) * 65536 + Math.floor(b[1] / 40);
			if (!this.blds.has(k)) this.blds.set(k, []);
			this.blds.get(k).push([b[0], b[1], r]);
		}
	}

	inBuilding(x, z, margin) {
		const ci = Math.floor(x / 40), cj = Math.floor(z / 40);
		for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) {
			const list = this.blds.get(a * 65536 + b);
			if (!list) continue;
			for (const B of list) if (Math.hypot(x - B[0], z - B[1]) < B[2] + margin) return true;
		}
		return false;
	}

	findIntersections(list) {
		const r = this.route;
		const hits = [];
		for (const [w, flat] of list) {
			if (w < 9) continue;
			for (const end of [0, flat.length - 2]) {
				const q = r.nearest(flat[end], flat[end + 1], 40);
				if (!q || q.d > 30) continue;
				const k = r.kind[q.i];
				if (k === KIND.freeway || k === KIND.ramp) continue;
				hits.push(q.s);
			}
		}
		hits.sort((a, b) => a - b);
		this.inters = [];
		for (const s of hits) if (!this.inters.length || s - this.inters[this.inters.length - 1] > 45) this.inters.push(s);
	}

	// Can a tree stand here?  Clear of every road, street and building.
	free(x, z, own, margin = 1.5) {
		const r = this.route;
		const q = r.nearest(x, z, 80);
		if (q) {
			if (own && (q.i < own[0] - 2 || q.i > own[1] + 2) && q.d < 120) return null;
			const edge = this.ground.edge(q);
			if (q.d < edge + margin) return null;
		}
		if (this.onStreet(x, z, margin)) return null;
		if (this.inBuilding(x, z, margin)) return null;
		return q || { d: 999, lat: 999, i: own ? own[0] : 0, t: 0 };
	}

	add(out, type, x, z, rot, sc, col, yOff = 0) {
		const y = this.ground.height(x, z) + yOff;
		(out[type] || (out[type] = [])).push(x, y, z, rot, sc, col);
	}

	buildChunk(k) {
		const r = this.route, out = {};
		const i0 = k * CH, i1 = Math.min(r.n - 1, (k + 1) * CH);
		const R = rng(k * 7919 + 13);
		const dens = this.q.density;
		const P = {};
		// --- along-road placement ---
		for (let i = i0; i < i1; i++) {
			const s = i * r.step;
			const zone = r.zoneAt(s);
			const kind = r.kind[i];
			const city = ZONE_TREES[zone] && kind !== KIND.freeway && kind !== KIND.ramp;
			r.at(s, P);
			for (const side of [1, -1]) {
				const edge = side > 0 ? r.R[i] : -r.Lp[i];
				const place = (e, jit = 0.6) => {
					const u = side * (edge + e);
					const x = P.x + P.rx * u + P.tx * (R() - 0.5) * jit, z = P.z + P.rz * u + P.tz * (R() - 0.5) * jit;
					return [x, z];
				};
				if (city) {
					const sp = SPACING[zone];
					if (Math.floor(s / sp) !== Math.floor((s + r.step) / sp) && R() < 0.9) {
						const [x, z] = place(3.7, 0.8);
						if (this.free(x, z, [i0, i1], 1.0)) {
							const t = pick(ZONE_TREES[zone], hash2(Math.floor(s / 90), side * 3 + 7) * 0.6 + R() * 0.4);
							const sc = t === "fanPalm" || t === "featherPalm" ? 0.85 + R() * 0.35 : 0.7 + R() * 0.25;
							this.add(out, t, x, z, R() * 6.28, sc, treeTint(t, R));
						}
					}
					// lamps
					const downtown = (zone === "redlands" && s < 4200) || (zone === "riverside" && kind !== KIND.ramp);
					const lsp = downtown ? 28 : 48;
					if (Math.floor((s + side * 11) / lsp) !== Math.floor((s + side * 11 + r.step) / lsp) && (downtown || side > 0)) {
						const [x, z] = place(0.7, 0);
						const yaw = Math.atan2(-P.rx * side, -P.rz * side) - Math.PI / 2;
						this.add(out, downtown ? "lampPost" : "streetLight", x, z, Math.atan2(P.rz * side, -P.rx * side) * 0 + yawToRoad(P, side), 1, 0xffffff);
						void yaw;
					}
					// yards and parks behind the sidewalk
					if (R() < 0.35 * dens) {
						const e = 9 + R() * 70;
						const [x, z] = place(e, 4);
						if (this.free(x, z, [i0, i1], 2)) {
							const t = pick(ZONE_TREES[zone], R());
							this.add(out, R() < 0.25 ? "shrub" : t, x, z, R() * 6.28, 0.8 + R() * 0.4, treeTint(t, R));
						}
					}
				} else if (kind === KIND.freeway || kind === KIND.ramp) {
					const wall = this.roads.wallMask[i] > 0;
					// tall lights at intervals (not in the canyon)
					if (side > 0 && zone !== "canyon" && kind === KIND.freeway && Math.floor(s / 64) !== Math.floor((s + r.step) / 64) && noise2(s / 900, 2) > -0.1) {
						const [x, z] = place(1.0, 0);
						this.add(out, "streetLight", x, z, yawToRoad(P, side), 1.15, 0xffffff);
					}
					if (R() < (zone === "canyon" ? 0.5 : 0.28) * dens) {
						const e = wall ? 10 + R() * 30 : 6 + R() * 60;
						const [x, z] = place(e, 5);
						if (this.free(x, z, [i0, i1], 2)) {
							let t;
							if (zone === "canyon") t = R() < 0.55 ? "shrub" : R() < 0.75 ? "oak" : "rock";
							else t = R() < 0.35 ? "eucalyptus" : R() < 0.6 ? "fanPalm" : R() < 0.8 ? "oak" : "shrub";
							this.add(out, t, x, z, R() * 6.28, 0.75 + R() * 0.5, treeTint(t, R));
						}
					}
					// eucalyptus windbreak rows
					if (zone === "ie-freeway" && !wall && noise2(s / 700, side * 9) > 0.35 && Math.floor(s / 7) !== Math.floor((s + r.step) / 7)) {
						const [x, z] = place(26 + noise2(s / 300, side) * 6, 1.5);
						if (this.free(x, z, [i0, i1], 2)) this.add(out, "eucalyptus", x, z, R() * 6.28, 0.9 + R() * 0.3, treeTint("eucalyptus", R));
					}
				}
			}
			// median trees
			if (r.med[i] && r.gap[i] > 3 && Math.floor(s / 21) !== Math.floor((s + r.step) / 21)) {
				const u = -r.hw[i] - r.gap[i] / 2;
				const t = zone === "irvine" ? (R() < 0.6 ? "jacaranda" : "featherPalm") : R() < 0.5 ? "featherPalm" : "fanPalm";
				const x = P.x + P.rx * u, z = P.z + P.rz * u;
				(out[t] || (out[t] = [])).push(x, r.Y[i] + 0.2, z, R() * 6.28, t === "jacaranda" ? 0.7 : 0.9, treeTint(t, R));
			}
		}
		// --- signals at boulevard intersections ---
		for (const s of this.inters) {
			if (s < i0 * r.step || s >= i1 * r.step) continue;
			const ss = Math.max(0, s - 14);
			r.at(ss, P);
			const i = Math.round(ss / r.step);
			const u = r.R[i] + 0.8;
			const x = P.x + P.rx * u, z = P.z + P.rz * u;
			const yaw = yawToRoad(P, 1);
			this.add(out, "signal", x, z, yaw, 1, 0xffffff);
			this.add(out, "lenses", x, z, yaw, 1, 0xffffff);
		}
		// --- area placement: groves, suburbs, chaparral ---
		this.areaFill(k, i0, i1, out, R);
		return out;
	}

	areaFill(k, i0, i1, out, R) {
		const r = this.route;
		let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
		for (let i = i0; i <= i1; i++) {
			x0 = Math.min(x0, r.X[i]); x1 = Math.max(x1, r.X[i]);
			z0 = Math.min(z0, r.Z[i]); z1 = Math.max(z1, r.Z[i]);
		}
		const pad = 170;
		const G = 7;
		const dens = this.q.density;
		for (let gx = Math.floor((x0 - pad) / G); gx <= Math.ceil((x1 + pad) / G); gx++) {
			for (let gz = Math.floor((z0 - pad) / G); gz <= Math.ceil((z1 + pad) / G); gz++) {
				const x = gx * G, z = gz * G;
				const q = r.nearest(x, z, pad);
				if (!q || q.i < i0 || q.i >= i1) continue;
				const e = q.d - this.ground.edge(q);
				if (e < 9) continue;
				const s = q.s;
				const zone = r.zoneAt(s);
				const lu = this.ground.landAt(x, z);
				const groveZone = (zone === "ie-freeway" && ((s > 5200 && s < 13000) || (s > 26500 && s < 42000))) || (zone === "redlands" && s > 2600);
				const grove = lu === "orchard" || (groveZone && lu !== "green" && lu !== "golf" && noise2(x / 520, z / 520) > 0.12 && e > 14 && e < 125 && !this.roads.wallMask[q.i]);
				if (grove) {
					if (hash2(gx, gz) > 0.93) continue;
					if (!this.free(x, z, null, 2.5)) continue;
					const near = e < 60;
					const t = near ? "orange" : "orangeLod";
					if (!near && hash2(gx * 3, gz) > 0.75 * dens + 0.2) continue;
					this.add(out, t, x + (hash2(gx, gz * 7) - 0.5), z + (hash2(gx * 5, gz) - 0.5), hash2(gx, gz * 3) * 6.28, 0.85 + hash2(gz, gx) * 0.3, treeTint("orange", R));
					continue;
				}
				// suburban rooftops behind sound walls and along OC/IE freeways
				const wall = this.roads.wallMask[q.i] > 0;
				if ((wall || zone === "oc-freeway") && e > 14 && e < 150 && gx % 3 === 0 && gz % 2 === 0 && !lu) {
					if (hash2(gx, gz * 11) < 0.78 && this.free(x, z, null, 4)) {
						const yaw = Math.atan2(r.TX[q.i], r.TZ[q.i]) + (hash2(gz, gx) > 0.5 ? 0 : Math.PI / 2);
						const c = this.tmp.c.setHSL(0.09 + hash2(gx, 3) * 0.05, 0.25, 0.82 + hash2(gz, 5) * 0.12).getHex();
						this.add(out, "house", x, z, yaw, 0.85 + hash2(gx, gz) * 0.3, c);
						if (hash2(gx * 13, gz) < 0.4) {
							const tx = x + 9, tz = z + 6;
							if (this.free(tx, tz, null, 3)) this.add(out, hash2(gx, gz * 17) < 0.5 ? "fanPalm" : "oak", tx, tz, 0, 0.7 + hash2(gz, 9) * 0.5, treeTint("oak", R));
						}
					}
					continue;
				}
				// chaparral and oaks on canyon and coastal hills
				if ((zone === "canyon" || zone === "laguna" || zone === "coast") && e > 12 && hash2(gx, gz) < (zone === "canyon" ? 0.05 : 0.03) * dens) {
					if (lu === "sand" || lu === "water") continue;
					const cd = 1;
					void cd;
					if (!this.free(x, z, null, 2)) continue;
					const t = hash2(gz, gx) < 0.7 ? "shrub" : "oak";
					this.add(out, t, x, z, hash2(gx, 1) * 6.28, 0.6 + hash2(gz, 2) * 0.7, treeTint(t, R));
				}
			}
		}
	}

	update(s, camPos) {
		const r = this.route;
		const c0 = Math.max(0, Math.floor((s - 700) / r.step / CH)), c1 = Math.min(Math.floor((r.n - 2) / CH), Math.floor((s + this.q.ahead * 0.85) / r.step / CH));
		for (const k of this.chunks.keys()) if (k < c0 || k > c1) {
			this.chunks.delete(k);
			this.dirty = true;
		}
		let built = 0;
		const t0 = performance.now();
		// nearest chunks first
		const cur = Math.floor(s / r.step / CH);
		const order = [];
		for (let k = c0; k <= c1; k++) if (!this.chunks.has(k)) order.push(k);
		order.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
		for (const k of order) {
			this.chunks.set(k, this.buildChunk(k));
			this.dirty = true;
			built++;
			if (performance.now() - t0 > this.q.budget * 1.5) break;
		}
		if (this.dirty) this.rebuild(camPos);
		return order.length - built;
	}

	rebuild() {
		this.dirty = false;
		const counts = {};
		for (const k of Object.keys(this.pools)) counts[k] = 0;
		const { m, q, p, s, c, up } = this.tmp;
		const glow = this.glowGeo.attributes.position.array;
		let g = 0;
		let nd = 0;
		const DISC = { orange: [1.7, 1.6], orangeLod: [1.7, 1.6], oak: [3.6, 4], jacaranda: [3.2, 5], eucalyptus: [3.4, 13], fanPalm: [1.9, 16], featherPalm: [2.6, 8], shrub: [1.3, 1] };
		const sd = this.sunDir;
		const el = Math.max(0.12, sd.y);
		const hl = Math.hypot(sd.x, sd.z) || 1;
		const shx = -sd.x / hl, shz = -sd.z / hl;
		const lenK = Math.min(2.2, Math.sqrt(1 - el * el) / el);
		for (const data of this.chunks.values()) {
			for (const [type, arr] of Object.entries(data)) {
				const pool = this.pools[type];
				if (!pool) continue;
				for (let o = 0; o < arr.length; o += 6) {
					const n = counts[type];
					if (n >= pool.cap) break;
					p.set(arr[o], arr[o + 1], arr[o + 2]);
					q.setFromAxisAngle(up, arr[o + 3]);
					s.setScalar(arr[o + 4]);
					m.compose(p, q, s);
					pool.mesh.setMatrixAt(n, m);
					c.setHex(arr[o + 5]);
					pool.mesh.setColorAt(n, c);
					counts[type] = n + 1;
					const D = DISC[type];
					if (D && nd < this.discCap) {
						const sc = arr[o + 4];
						const off = Math.min(D[1] * sc * lenK * 0.55, 9);
						p.set(arr[o] + shx * off, arr[o + 1] + 0.12, arr[o + 2] + shz * off);
						q.identity();
						s.set(D[0] * sc * (1 + lenK * 0.25), 1, D[0] * sc);
						m.compose(p, q, s);
						this.disc.setMatrixAt(nd++, m);
					}
					if ((type === "streetLight" || type === "lampPost") && g < 2000) {
						const sc = arr[o + 4];
						if (type === "streetLight") {
							const a = arr[o + 3];
							glow[g * 3] = arr[o] - Math.cos(a) * 2.55 * sc;
							glow[g * 3 + 1] = arr[o + 1] + 9.0 * sc;
							glow[g * 3 + 2] = arr[o + 2] + Math.sin(a) * 2.55 * sc;
						} else {
							glow[g * 3] = arr[o]; glow[g * 3 + 1] = arr[o + 1] + 4.6; glow[g * 3 + 2] = arr[o + 2];
						}
						g++;
					}
				}
			}
		}
		for (const [type, pool] of Object.entries(this.pools)) {
			pool.mesh.count = counts[type];
			pool.mesh.instanceMatrix.needsUpdate = true;
			if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
		}
		this.disc.count = nd;
		this.disc.instanceMatrix.needsUpdate = true;
		this.glowGeo.setDrawRange(0, g);
		this.glowGeo.attributes.position.needsUpdate = true;
		this.counts = counts;
	}

	setNight(night) {
		this.glow.material.opacity = clamp(night * 1.2, 0, 1);
		this.glow.visible = night > 0.02;
		this.basicMat.color.setScalar(lerp(0.75, 1.6, night));
	}
}

// Rotation that points a pole's -x arm toward the road centre.
function yawToRoad(P, side) {
	// arm local -x should map to world direction -side * right
	const dx = -side * P.rx, dz = -side * P.rz;
	return Math.atan2(dz, -dx);
}

function treeTint(t, R) {
	const c = new THREE.Color();
	const v = 0.85 + R() * 0.3;
	if (t === "jacaranda") c.setRGB(v, v * (0.92 + R() * 0.1), v);
	else if (t === "eucalyptus") c.setRGB(v * 0.95, v, v * (0.95 + R() * 0.1));
	else c.setRGB(v, v * (0.95 + R() * 0.1), v * 0.92);
	return c.getHex();
}

function glowTexture() {
	const cv = document.createElement("canvas");
	cv.width = cv.height = 64;
	const g = cv.getContext("2d");
	const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
	gr.addColorStop(0, "rgba(255,240,210,1)");
	gr.addColorStop(0.25, "rgba(255,200,120,0.6)");
	gr.addColorStop(1, "rgba(255,160,80,0)");
	g.fillStyle = gr;
	g.fillRect(0, 0, 64, 64);
	const t = new THREE.CanvasTexture(cv);
	t.encoding = THREE.sRGBEncoding;
	return t;
}
