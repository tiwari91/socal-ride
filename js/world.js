// Terrain height field (NOAA ETOPO1 grid + procedural detail), coastline
// signed distance (OSM coastline) and helpers to convert lat/lon to metres.
import { clamp, fbm, lerp, noise2, smoothstep } from "./util.js";

export const world = {
	origin: null,
	grid: null,
	coast: null,
	bumps: [],
};

export function toXZ(lat, lon) {
	const o = world.origin;
	return [(lon - o.lon) * o.kx, -(lat - o.lat) * o.kz];
}

export function toLatLon(x, z) {
	const o = world.origin;
	return [o.lat - z / o.kz, o.lon + x / o.kx];
}

export function initWorld(route, terrainMeta, terrainBuf) {
	world.origin = route.origin;
	const g = terrainMeta;
	world.grid = {
		rows: g.rows,
		cols: g.cols,
		north: g.north,
		west: g.west,
		dlat: (g.north - g.south) / (g.rows - 1),
		dlon: (g.east - g.west) / (g.cols - 1),
		h: new Int16Array(terrainBuf),
	};
	const [x0, z0] = toXZ(g.north, g.west);
	const [x1, z1] = toXZ(g.south, g.east);
	world.bounds = { x0, z0, x1, z1 };
	// Mount Rubidoux and Box Springs are too small for a 1' grid; add them back.
	world.bumps = [
		{ p: toXZ(33.9839, -117.3931), h: 140, r: 380 },
		{ p: toXZ(33.9925, -117.3965), h: 70, r: 500 },
	];
	buildCoast(route.coast);
}

function cell(r, c) {
	const g = world.grid;
	r = clamp(r, 0, g.rows - 1);
	c = clamp(c, 0, g.cols - 1);
	return g.h[r * g.cols + c];
}

function cubic(p0, p1, p2, p3, t) {
	return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

// Smooth bicubic sample of the raw grid (metres).
export function baseHeight(x, z) {
	const g = world.grid;
	const [lat, lon] = toLatLon(x, z);
	const fr = (g.north - lat) / g.dlat;
	const fc = (lon - g.west) / g.dlon;
	const r = Math.floor(fr), c = Math.floor(fc);
	const tr = fr - r, tc = fc - c;
	const rowv = [];
	for (let i = -1; i <= 2; i++) {
		rowv.push(cubic(cell(r + i, c - 1), cell(r + i, c), cell(r + i, c + 1), cell(r + i, c + 2), tc));
	}
	return cubic(rowv[0], rowv[1], rowv[2], rowv[3], tr);
}

// ---------- coastline signed distance ----------
const CC = 400;
function buildCoast(lines) {
	const segs = [];
	for (const L of lines || []) {
		for (let i = 0; i + 3 < L.length; i += 2) segs.push([L[i], L[i + 1], L[i + 2], L[i + 3]]);
	}
	const map = new Map();
	let bx0 = 1e9, bz0 = 1e9, bx1 = -1e9, bz1 = -1e9;
	segs.forEach((s, k) => {
		const ax = Math.floor(Math.min(s[0], s[2]) / CC), bx = Math.floor(Math.max(s[0], s[2]) / CC);
		const az = Math.floor(Math.min(s[1], s[3]) / CC), bz = Math.floor(Math.max(s[1], s[3]) / CC);
		for (let i = ax; i <= bx; i++) for (let j = az; j <= bz; j++) {
			const key = i * 100003 + j;
			if (!map.has(key)) map.set(key, []);
			map.get(key).push(k);
		}
		bx0 = Math.min(bx0, s[0]); bx1 = Math.max(bx1, s[0]);
		bz0 = Math.min(bz0, s[1]); bz1 = Math.max(bz1, s[1]);
	});
	world.coast = { segs, map, box: [bx0 - 6000, bz0 - 6000, bx1 + 6000, bz1 + 6000] };
}

// Positive on land, negative at sea (metres). Returns 1e5 when far from any coast.
export function coastDistance(x, z, maxR = 4000) {
	const C = world.coast;
	if (!C || !C.segs.length) return 1e5;
	if (x < C.box[0] || x > C.box[2] || z < C.box[1] || z > C.box[3]) return 1e5;
	const ci = Math.floor(x / CC), cj = Math.floor(z / CC);
	let best = 1e10, sign = 1;
	const R = Math.ceil(maxR / CC);
	for (let ring = 0; ring <= R; ring++) {
		for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) {
			if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
			const list = C.map.get(i * 100003 + j);
			if (!list) continue;
			for (const k of list) {
				const s = C.segs[k];
				const dx = s[2] - s[0], dz = s[3] - s[1];
				const L2 = dx * dx + dz * dz || 1;
				const t = clamp(((x - s[0]) * dx + (z - s[1]) * dz) / L2, 0, 1);
				const px = s[0] + dx * t, pz = s[1] + dz * t;
				const d2 = (x - px) ** 2 + (z - pz) ** 2;
				if (d2 < best) {
					best = d2;
					// OSM: land on the left of the way. With z pointing south, left of (dx,dz) is (dz,-dx).
					const cr = (x - s[0]) * dz - (z - s[1]) * dx;
					sign = cr >= 0 ? 1 : -1;
				}
			}
		}
		if (best < ((ring) * CC) ** 2) break;
	}
	if (best > 1e9) return 1e5;
	return Math.sqrt(best) * sign;
}

// Full natural terrain height (no road shaping).
export function terrainHeight(x, z, cd) {
	let h = baseHeight(x, z);
	// procedural relief that grows with altitude so mountains get ridges
	const rough = 8 + 70 * smoothstep(250, 900, h) + 160 * smoothstep(900, 2400, h);
	const ridged = 1 - Math.abs(noise2(x / 2300, z / 2300));
	h += rough * (fbm(x / 1500 + 11, z / 1500 - 7, 4) * 0.8 + (ridged - 0.5) * 0.7);
	h += 3 * noise2(x / 180, z / 180);
	for (const b of world.bumps) {
		const d2 = (x - b.p[0]) ** 2 + (z - b.p[1]) ** 2;
		h += b.h * Math.exp(-d2 / (b.r * b.r)) * (0.85 + 0.15 * noise2(x / 90, z / 90));
	}
	if (cd === undefined) cd = coastDistance(x, z);
	if (cd < 1e5) {
		if (cd < 0) {
			h = Math.min(h, -2.5 + cd * 0.06);
			h = Math.max(h, -400);
		} else {
			const land = Math.max(h, 1.5 + cd * 0.025);
			h = lerp(0.9 + cd * 0.02, land, smoothstep(24, 95, cd));
		}
	}
	return h;
}
