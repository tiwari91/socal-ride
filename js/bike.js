// The motorcycle: an original classic touring cruiser (V-twin, spoked
// whitewall wheels, leather saddlebags, windshield) and its rider.
// Local frame: +z forward, +y up, +x to the rider's left. Origin = ground contact midpoint.
import { clamp, damp, lerp } from "./util.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const PAINTS = {
	burgundy: { name: "Sunset Burgundy", main: "#5e0f1d", trim: "#efe2c4" },
	seafoam: { name: "Seafoam", main: "#4f9c93", trim: "#f2ead6" },
	midnight: { name: "Midnight", main: "#131c33", trim: "#c9ccd2" },
	citrus: { name: "Citrus", main: "#d9731e", trim: "#f6efe0" },
};

function tube(points, r, seg = 24, radial = 8) {
	return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), seg, r, radial, false);
}

function limb(a, b, r) {
	const d = new THREE.Vector3().subVectors(b, a);
	const g = new THREE.CapsuleGeometry(r, Math.max(0.01, d.length()), 4, 10);
	const m = new THREE.Mesh(g);
	m.position.copy(a).addScaledVector(d, 0.5);
	m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
	m.updateMatrix();
	g.applyMatrix4(m.matrix);
	return g;
}

export class Bike {
	constructor(envMap, paint = "burgundy") {
		this.root = new THREE.Group();
		this.lean = new THREE.Group();
		this.body = new THREE.Group();
		this.root.add(this.lean);
		this.lean.add(this.body);
		const std = (o) => new THREE.MeshStandardMaterial(Object.assign({ envMapIntensity: 1 }, o));
		void envMap;
		this.m = {
			paint: std({ color: 0xffffff, vertexColors: true, metalness: 0.35, roughness: 0.22 }),
			chrome: std({ color: 0xc9ced3, metalness: 1, roughness: 0.16 }),
			satin: std({ color: 0xb9bcc0, metalness: 0.85, roughness: 0.38 }),
			black: std({ color: 0x15161a, metalness: 0.4, roughness: 0.45 }),
			rubber: std({ color: 0x141414, metalness: 0, roughness: 0.92 }),
			white: std({ color: 0xe9e3d3, metalness: 0, roughness: 0.6 }),
			leather: std({ color: 0x5b3820, metalness: 0, roughness: 0.62 }),
			leatherDark: std({ color: 0x2c1b11, metalness: 0, roughness: 0.7 }),
			seat: std({ color: 0x2a1a12, metalness: 0, roughness: 0.55 }),
			glass: std({ color: 0xcfe3ee, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.28, depthWrite: false }),
			lens: new THREE.MeshBasicMaterial({ color: 0xfff4dc }),
			tail: new THREE.MeshBasicMaterial({ color: 0x7a0b0b }),
			amber: new THREE.MeshBasicMaterial({ color: 0xc87a12 }),
			jacket: std({ color: 0x31353c, metalness: 0.02, roughness: 0.78 }),
			panel: std({ color: 0x24272d, metalness: 0.03, roughness: 0.7 }),
			denim: std({ color: 0x33496c, metalness: 0, roughness: 0.88 }),
			boot: std({ color: 0x18120d, metalness: 0.05, roughness: 0.5 }),
			glove: std({ color: 0x17130f, metalness: 0.05, roughness: 0.55 }),
			helmet: std({ color: 0xece4d0, metalness: 0.15, roughness: 0.18 }),
			stripe: std({ color: 0xece4d0, metalness: 0.15, roughness: 0.2 }),
			visor: std({ color: 0x141a22, metalness: 0.85, roughness: 0.06 }),
			skin: std({ color: 0xc69274, metalness: 0, roughness: 0.7 }),
			goggle: std({ color: 0x2a2f36, metalness: 0.6, roughness: 0.15 }),
		};
		this.paintParts = [];
		this.build();
		this.setPaint(paint);
		this.root.traverse((o) => {
			if (o.isMesh) {
				o.castShadow = true;
				o.receiveShadow = false;
			}
		});
		this.m.glass.castShadow = false;
		this.state = { spin: 0, steer: 0, bob: 0, pitch: 0 };
	}

	add(geo, mat, parent = this.body) {
		const mesh = new THREE.Mesh(geo, mat);
		parent.add(mesh);
		return mesh;
	}

	paintable(geo, trimFn) {
		const n = geo.attributes.position.count;
		geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
		this.paintParts.push({ geo, trimFn });
		return geo;
	}

	setPaint(key) {
		const P = PAINTS[key] || PAINTS.burgundy;
		this.paintKey = key;
		const main = new THREE.Color(P.main), trim = new THREE.Color(P.trim);
		// the helmet is painted to match the bike, with a trim-colour stripe
		this.m.helmet.color.copy(main);
		this.m.stripe.color.copy(trim);
		for (const { geo, trimFn } of this.paintParts) {
			const p = geo.attributes.position, c = geo.attributes.color;
			for (let i = 0; i < p.count; i++) {
				const t = trimFn ? trimFn(p.getX(i), p.getY(i), p.getZ(i)) : 0;
				const col = t > 0.5 ? trim : main;
				c.setXYZ(i, col.r, col.g, col.b);
			}
			c.needsUpdate = true;
		}
	}

	wheel(R, front) {
		const g = new THREE.Group();
		const m = this.m;
		const tire = new THREE.TorusGeometry(R - 0.065, 0.065, 12, 40);
		tire.rotateY(Math.PI / 2);
		g.add(new THREE.Mesh(tire, m.rubber));
		for (const sx of [-1, 1]) {
			const ww = new THREE.TorusGeometry(R - 0.085, 0.026, 6, 40);
			ww.rotateY(Math.PI / 2);
			ww.translate(sx * 0.045, 0, 0);
			g.add(new THREE.Mesh(ww, m.white));
		}
		const rim = new THREE.TorusGeometry(R - 0.125, 0.017, 6, 40);
		rim.rotateY(Math.PI / 2);
		g.add(new THREE.Mesh(rim, m.chrome));
		const hub = new THREE.CylinderGeometry(0.065, 0.065, 0.16, 16);
		hub.rotateZ(Math.PI / 2);
		g.add(new THREE.Mesh(hub, m.chrome));
		// laced spokes
		const spokes = [];
		const n = 40;
		for (let k = 0; k < n; k++) {
			const a = (k / n) * Math.PI * 2;
			const side = k % 2 ? 1 : -1;
			const a2 = a + side * 0.35;
			const p0 = V(side * 0.065, Math.sin(a2) * 0.055, Math.cos(a2) * 0.055);
			const p1 = V(side * 0.012, Math.sin(a) * (R - 0.13), Math.cos(a) * (R - 0.13));
			spokes.push(limbCyl(p0, p1, 0.0045));
		}
		g.add(new THREE.Mesh(mergeGeos(spokes), m.chrome));
		if (front) {
			const disc = new THREE.CylinderGeometry(0.15, 0.15, 0.007, 28);
			disc.rotateZ(Math.PI / 2);
			disc.translate(0.085, 0, 0);
			g.add(new THREE.Mesh(disc, m.satin));
		} else {
			const pulley = new THREE.CylinderGeometry(0.15, 0.15, 0.02, 28);
			pulley.rotateZ(Math.PI / 2);
			pulley.translate(0.1, 0, 0);
			g.add(new THREE.Mesh(pulley, m.satin));
		}
		return g;
	}

	build() {
		const m = this.m, B = this.body;
		const RF = 0.335, RR = 0.325;
		const zF = 0.82, zR = -0.8;
		// ---- rear wheel and drive ----
		this.rearWheel = this.wheel(RR, false);
		this.rearWheel.position.set(0, RR, zR);
		B.add(this.rearWheel);
		const belt = tube([V(0.1, 0.42, -0.12), V(0.1, 0.47, -0.45), V(0.1, RR + 0.15, zR), V(0.1, RR - 0.15, zR), V(0.1, 0.3, -0.45), V(0.1, 0.36, -0.12)], 0.012, 30, 4);
		this.add(belt, m.black);
		// swingarm + shocks
		for (const sx of [-1, 1]) {
			this.add(tube([V(sx * 0.11, 0.4, -0.22), V(sx * 0.12, RR + 0.02, zR)], 0.022, 6, 8), m.black);
			this.add(limb(V(sx * 0.13, RR + 0.04, zR + 0.12), V(sx * 0.13, 0.78, -0.48), 0.026), m.chrome);
		}
		// ---- frame ----
		const head = V(0, 0.97, 0.56);
		this.add(tube([head, V(0, 0.9, 0.3), V(0, 0.84, -0.05), V(0, 0.76, -0.4), V(0, 0.68, -0.82)], 0.028), m.black);
		for (const sx of [-1, 1]) {
			this.add(tube([V(sx * 0.03, 0.92, 0.52), V(sx * 0.09, 0.5, 0.36), V(sx * 0.1, 0.24, 0.12), V(sx * 0.1, 0.24, -0.15), V(sx * 0.1, 0.42, -0.25), V(sx * 0.1, 0.72, -0.4)], 0.022, 30, 8), m.black);
		}
		// ---- engine: V-twin ----
		const crank = new THREE.CylinderGeometry(0.17, 0.17, 0.26, 24);
		crank.rotateZ(Math.PI / 2);
		crank.scale(1, 0.95, 1.2);
		crank.translate(0, 0.4, 0.02);
		this.add(crank, m.satin);
		const cover = new THREE.CylinderGeometry(0.13, 0.13, 0.03, 24);
		cover.rotateZ(Math.PI / 2);
		cover.translate(0.145, 0.4, 0.06);
		this.add(cover, m.chrome);
		const prim = new THREE.CapsuleGeometry(0.1, 0.32, 4, 12);
		prim.rotateX(Math.PI / 2 - 0.1);
		prim.translate(0.15, 0.33, -0.12);
		this.add(prim, m.chrome);
		for (const [ang, z0] of [[0.42, 0.1], [-0.42, -0.06]]) {
			const cyl = new THREE.Group();
			cyl.position.set(0, 0.5, z0);
			cyl.rotation.x = ang;
			for (let f = 0; f < 8; f++) {
				const fin = new THREE.CylinderGeometry(0.105 - f * 0.003, 0.105 - f * 0.003, 0.012, 20);
				fin.translate(0, 0.03 + f * 0.032, 0);
				cyl.add(new THREE.Mesh(fin, m.satin));
			}
			const core = new THREE.CylinderGeometry(0.07, 0.075, 0.27, 16);
			core.translate(0, 0.14, 0);
			cyl.add(new THREE.Mesh(core, m.black));
			const rocker = new THREE.CapsuleGeometry(0.075, 0.07, 4, 12);
			rocker.rotateX(Math.PI / 2);
			rocker.translate(0, 0.31, 0);
			cyl.add(new THREE.Mesh(rocker, m.chrome));
			B.add(cyl);
		}
		const pushrods = limb(V(-0.05, 0.42, 0.02), V(-0.05, 0.75, 0.05), 0.012);
		this.add(pushrods, m.chrome);
		const air = new THREE.CylinderGeometry(0.11, 0.11, 0.06, 28);
		air.rotateZ(Math.PI / 2);
		air.translate(-0.15, 0.62, 0.02);
		this.add(air, m.chrome);
		// ---- exhaust (right side, two pipes into slash-cut mufflers) ----
		this.add(tube([V(-0.04, 0.78, 0.26), V(-0.12, 0.66, 0.38), V(-0.17, 0.36, 0.34), V(-0.19, 0.27, 0.1), V(-0.2, 0.27, -0.3), V(-0.2, 0.3, -0.55)], 0.032, 30, 10), m.chrome);
		this.add(tube([V(-0.05, 0.76, -0.2), V(-0.15, 0.62, -0.25), V(-0.21, 0.42, -0.35), V(-0.23, 0.42, -0.62)], 0.032, 24, 10), m.chrome);
		for (const [y, z] of [[0.3, -0.55], [0.42, -0.62]]) {
			const muf = new THREE.CylinderGeometry(0.055, 0.05, 0.6, 18);
			muf.rotateX(Math.PI / 2);
			muf.translate(-0.21, y + 0.01, z - 0.28);
			this.add(muf, m.chrome);
		}
		// ---- tank (two-tone teardrop) ----
		const tank = new THREE.SphereGeometry(0.2, 36, 20);
		const tp = tank.attributes.position;
		for (let i = 0; i < tp.count; i++) {
			let x = tp.getX(i), y = tp.getY(i), z = tp.getZ(i);
			z *= 1.65;
			const taper = 1 - clamp(-z / 0.36, 0, 1) * 0.35;
			x *= 0.95 * taper;
			y = (y > 0 ? y * 0.75 : y * 0.55) * (1 - clamp(z / 0.33, 0, 1) * 0.15);
			tp.setXYZ(i, x, y, z);
		}
		tank.computeVertexNormals();
		tank.translate(0, 0.99, 0.2);
		this.paintable(tank, (x, y, z) => (Math.abs(x) > 0.1 && y < 1.0 && y > 0.93 && z > 0.04 && z < 0.42 ? 1 : 0));
		this.add(tank, m.paint);
		const cap = new THREE.CylinderGeometry(0.035, 0.035, 0.02, 16);
		cap.translate(0.06, 1.14, 0.24);
		this.add(cap, m.chrome);
		const dash = new THREE.BoxGeometry(0.07, 0.015, 0.26);
		dash.translate(0, 1.14, 0.18);
		this.add(dash, m.chrome);
		// ---- seat (rider + pillion) ----
		const seat = new THREE.CapsuleGeometry(0.15, 0.32, 6, 16);
		seat.rotateX(Math.PI / 2);
		seat.scale(1.0, 0.42, 1);
		seat.translate(0, 0.86, -0.18);
		this.add(seat, m.seat);
		const pill = new THREE.CapsuleGeometry(0.12, 0.16, 6, 14);
		pill.rotateX(Math.PI / 2);
		pill.scale(1, 0.4, 1);
		pill.translate(0, 0.9, -0.58);
		this.add(pill, m.seat);
		// ---- fenders ----
		const rf = new THREE.CylinderGeometry(RR + 0.06, RR + 0.06, 0.2, 30, 1, true, -0.25, 2.55);
		rf.rotateZ(Math.PI / 2);
		rf.translate(0, RR, zR);
		this.paintable(rf, null);
		this.add(rf, Object.assign(this.m.paint.clone(), { side: THREE.DoubleSide }));
		// ---- saddlebags ----
		for (const sx of [-1, 1]) {
			const bag = new THREE.CapsuleGeometry(0.15, 0.22, 6, 12);
			bag.rotateX(Math.PI / 2);
			bag.scale(0.52, 1.05, 1.05);
			bag.translate(sx * 0.26, 0.6, -0.72);
			this.add(bag, m.leather);
			const flap = new THREE.CapsuleGeometry(0.15, 0.2, 4, 10, );
			flap.rotateX(Math.PI / 2);
			flap.scale(0.56, 0.5, 1.02);
			flap.translate(sx * 0.262, 0.7, -0.72);
			this.add(flap, m.leatherDark);
			for (const dz of [-0.12, 0.12]) {
				const strap = new THREE.BoxGeometry(0.012, 0.2, 0.035);
				strap.translate(sx * 0.345, 0.66, -0.72 + dz);
				this.add(strap, m.leatherDark);
				const buckle = new THREE.BoxGeometry(0.012, 0.035, 0.045);
				buckle.translate(sx * 0.352, 0.6, -0.72 + dz);
				this.add(buckle, m.chrome);
			}
		}
		// rear rail, tail light, plate
		this.add(tube([V(0.17, 0.85, -0.45), V(0.17, 0.9, -0.85), V(0, 0.9, -1.0), V(-0.17, 0.9, -0.85), V(-0.17, 0.85, -0.45)], 0.012, 20, 6), m.chrome);
		const tl = new THREE.SphereGeometry(0.045, 14, 10);
		tl.scale(1.4, 0.8, 0.6);
		tl.translate(0, 0.74, -1.13);
		this.tailMesh = this.add(tl, m.tail);
		const plate = new THREE.BoxGeometry(0.2, 0.11, 0.01);
		plate.translate(0, 0.62, -1.12);
		this.add(plate, m.black);
		for (const sx of [-1, 1]) {
			const sig = new THREE.CapsuleGeometry(0.02, 0.05, 4, 8);
			sig.rotateX(Math.PI / 2);
			sig.translate(sx * 0.14, 0.72, -1.06);
			this.add(sig, m.amber);
			this.add(new THREE.CapsuleGeometry(0.02, 0.05, 4, 8).rotateX(Math.PI / 2).translate(sx * 0.2, 0.86, 0.78), m.amber);
		}
		// footboards
		for (const sx of [-1, 1]) {
			const fb = new THREE.BoxGeometry(0.12, 0.025, 0.3);
			fb.translate(sx * 0.27, 0.3, 0.28);
			this.add(fb, m.chrome);
			const rub = new THREE.BoxGeometry(0.1, 0.012, 0.26);
			rub.translate(sx * 0.27, 0.318, 0.28);
			this.add(rub, m.rubber);
		}
		// ---- front end, rotates about the steering axis ----
		const rake = 0.5;
		this.steerAxis = new THREE.Group();
		this.steerAxis.position.copy(head);
		this.steerAxis.rotation.x = rake;
		B.add(this.steerAxis);
		this.steer = new THREE.Group();
		this.steerAxis.add(this.steer);
		const front = new THREE.Group();
		// parts are built in bike coordinates: front = inverse(steerAxis)
		const inv = new THREE.Matrix4().copy(new THREE.Matrix4().compose(head, new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), rake), V(1, 1, 1))).invert();
		front.matrixAutoUpdate = false;
		front.matrix.copy(inv);
		this.steer.add(front);
		this.frontWheel = this.wheel(RF, true);
		this.frontWheel.position.set(0, RF, zF);
		front.add(this.frontWheel);
		const ffend = new THREE.CylinderGeometry(RF + 0.055, RF + 0.055, 0.19, 30, 1, true, 0.6, 1.9);
		ffend.rotateZ(Math.PI / 2);
		ffend.translate(0, RF, zF);
		this.paintable(ffend, null);
		this.add(ffend, Object.assign(this.m.paint.clone(), { side: THREE.DoubleSide }), front);
		// fork legs along the steering axis
		const axisDir = V(0, Math.cos(rake), -Math.sin(rake)).normalize();
		for (const sx of [-1, 1]) {
			const a = V(sx * 0.095, RF, zF);
			const b = a.clone().addScaledVector(axisDir, 0.74);
			this.add(limb(a, a.clone().addScaledVector(axisDir, 0.34), 0.03), m.chrome, front);
			this.add(limb(a.clone().addScaledVector(axisDir, 0.3), b, 0.022), m.chrome, front);
		}
		const top = V(0, RF, zF).addScaledVector(axisDir, 0.8);
		const clamp1 = new THREE.BoxGeometry(0.26, 0.04, 0.08);
		clamp1.translate(top.x, top.y, top.z);
		this.add(clamp1, m.chrome, front);
		// headlight nacelle
		const hl = new THREE.CylinderGeometry(0.115, 0.1, 0.16, 28, 1);
		hl.rotateX(Math.PI / 2);
		hl.translate(0, top.y - 0.12, top.z + 0.16);
		this.add(hl, m.chrome, front);
		const lens = new THREE.CircleGeometry(0.1, 28);
		lens.translate(0, top.y - 0.12, top.z + 0.241);
		this.lensMesh = this.add(lens, m.lens, front);
		this.headPos = V(0, top.y - 0.12, top.z + 0.26);
		for (const sx of [-1, 1]) {
			const pl = new THREE.CylinderGeometry(0.055, 0.048, 0.08, 20);
			pl.rotateX(Math.PI / 2);
			pl.translate(sx * 0.17, top.y - 0.3, top.z + 0.17);
			this.add(pl, m.chrome, front);
			const pll = new THREE.CircleGeometry(0.047, 18);
			pll.translate(sx * 0.17, top.y - 0.3, top.z + 0.211);
			this.add(pll, m.lens, front);
		}
		const pbar = limb(V(-0.17, top.y - 0.3, top.z + 0.12), V(0.17, top.y - 0.3, top.z + 0.12), 0.012);
		this.add(pbar, m.chrome, front);
		// pull-back bars, grips, levers, mirrors
		const gy = top.y + 0.1, gz = top.z - 0.2;
		this.add(tube([V(0.4, gy, gz), V(0.3, gy + 0.03, gz + 0.04), V(0.18, gy + 0.08, top.z + 0.02), V(0, gy + 0.02, top.z + 0.03), V(-0.18, gy + 0.08, top.z + 0.02), V(-0.3, gy + 0.03, gz + 0.04), V(-0.4, gy, gz)], 0.014, 30, 8), m.chrome, front);
		for (const sx of [-1, 1]) {
			this.add(limb(V(sx * 0.36, gy, gz + 0.01), V(sx * 0.46, gy - 0.005, gz - 0.01), 0.02), m.rubber, front);
			this.add(tube([V(sx * 0.28, gy + 0.03, gz + 0.05), V(sx * 0.3, gy + 0.22, gz + 0.02), V(sx * 0.33, gy + 0.3, gz)], 0.006, 8, 5), m.chrome, front);
			const mir = new THREE.CylinderGeometry(0.05, 0.05, 0.015, 18);
			mir.rotateX(Math.PI / 2 - 0.2);
			mir.translate(sx * 0.33, gy + 0.33, gz);
			this.add(mir, m.chrome, front);
		}
		// windshield
		const ws = new THREE.CylinderGeometry(0.55, 0.55, 0.42, 24, 1, true, -0.5, 1.0);
		ws.scale(0.62, 1, 0.3);
		ws.rotateX(-0.32);
		ws.translate(0, gy + 0.2, top.z - 0.08);
		this.add(ws, m.glass, front).castShadow = false;
		this.buildRider(gy, gz, front);
	}

	// Articulated rider: lathe-turned limbs posed each frame with two-bone IK so
	// the hands follow the bars, the torso hangs into turns, the head looks
	// through the corner and the left boot goes down when the bike stops.
	buildRider(gy, gz, front) {
		const m = this.m;
		const R = new THREE.Group();
		this.rider = R;
		this.body.add(R);
		const mesh = (g, mat, parent = R) => {
			const o = new THREE.Mesh(g, mat);
			parent.add(o);
			return o;
		};
		// pelvis sits in the saddle
		this.pelvis = new THREE.Group();
		this.pelvis.position.set(0, 0.97, -0.22);
		R.add(this.pelvis);
		const seatG = new THREE.SphereGeometry(1, 24, 14);
		seatG.scale(0.165, 0.11, 0.15);
		mesh(seatG, m.denim, this.pelvis);
		// torso: a turned jacket with chest depth, belt line and zip
		this.torso = new THREE.Group();
		this.torso.position.set(0, 0.02, 0.0);
		this.pelvis.add(this.torso);
		const prof = [[0, -0.03], [0.12, -0.025], [0.152, 0.03], [0.148, 0.12], [0.158, 0.22], [0.178, 0.32], [0.186, 0.39], [0.176, 0.44], [0.13, 0.49], [0.075, 0.52], [0.0, 0.53]];
		const tg = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 28);
		tg.scale(1.06, 1, 0.74);
		mesh(tg, m.jacket, this.torso);
		const hem = new THREE.TorusGeometry(0.15, 0.018, 8, 28);
		hem.rotateX(Math.PI / 2);
		hem.scale(1.06, 1, 0.76);
		hem.translate(0, 0.0, 0);
		mesh(hem, m.leatherDark, this.torso);
		const zip = new THREE.BoxGeometry(0.012, 0.42, 0.01);
		zip.translate(0.02, 0.24, 0.118);
		zip.rotateX(-0.03);
		mesh(zip, m.satin, this.torso);
		// back protector and shoulder armour under the leather
		const back = new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2);
		back.rotateX(-Math.PI / 2);
		back.scale(0.12, 0.17, 0.035);
		back.translate(0, 0.28, -0.122);
		mesh(back, m.panel, this.torso);
		// reflective piping around the chest, like a touring jacket
		const pipe = new THREE.TorusGeometry(0.168, 0.006, 6, 36);
		pipe.rotateX(Math.PI / 2);
		pipe.scale(1.07, 1, 0.76);
		pipe.translate(0, 0.27, 0);
		mesh(pipe, m.satin, this.torso);
		this.shoulders = [];
		for (const sx of [-1, 1]) {
			const cap = new THREE.SphereGeometry(0.068, 16, 12);
			cap.scale(1, 0.9, 1.05);
			cap.translate(sx * 0.178, 0.43, -0.005);
			mesh(cap, m.panel, this.torso);
			const a = new THREE.Object3D();
			a.position.set(sx * 0.185, 0.425, 0.0);
			this.torso.add(a);
			this.shoulders.push(a);
		}
		// neck and full-face helmet
		this.neck = new THREE.Group();
		this.neck.position.set(0, 0.5, 0.0);
		this.torso.add(this.neck);
		mesh(new THREE.CylinderGeometry(0.052, 0.06, 0.12, 14).translate(0, 0.05, 0.005), m.leatherDark, this.neck);
		const collar = new THREE.CylinderGeometry(0.075, 0.09, 0.06, 18, 1, true);
		collar.translate(0, 0.0, 0.0);
		mesh(collar, Object.assign(m.jacket.clone(), { side: THREE.DoubleSide }), this.neck);
		this.head = new THREE.Group();
		this.head.position.set(0, 0.18, 0.03);
		this.neck.add(this.head);
		const shell = new THREE.SphereGeometry(0.145, 32, 22);
		shell.scale(0.9, 1.0, 1.08);
		mesh(shell, m.helmet, this.head);
		const visor = new THREE.SphereGeometry(0.148, 28, 10, Math.PI / 2 - 1.0, 2.0, 0.98, 0.6);
		visor.scale(0.91, 1.0, 1.09);
		mesh(visor, m.visor, this.head);
		// chin vent and the rubber visor seal
		const vent = new THREE.BoxGeometry(0.05, 0.022, 0.02);
		vent.translate(0, -0.095, 0.148);
		mesh(vent, m.black, this.head);
		const seal = new THREE.TorusGeometry(0.143, 0.006, 6, 30, 2.0);
		seal.rotateX(Math.PI / 2);
		seal.rotateY(Math.PI / 2 - 1.0);
		seal.scale(0.91, 1, 1.09);
		seal.translate(0, -0.046, 0);
		mesh(seal, m.black, this.head);
		const stripe = new THREE.SphereGeometry(0.1465, 24, 16, Math.PI * 1.5 - 0.09, 0.18, 0.05, 2.0);
		stripe.scale(0.9, 1.0, 1.08);
		mesh(stripe, m.stripe, this.head);
		// limbs: unit-oriented segments along +y, posed every frame
		const seg = (L, r0, r1, bulge, mat) => mesh(limbLathe(L, r0, r1, bulge), mat);
		this.arms = [];
		this.legs = [];
		const grip = (sx) => {
			const o = new THREE.Object3D();
			o.position.set(sx * 0.405, gy + 0.012, gz + 0.004);
			front.add(o);
			return o;
		};
		for (const sx of [-1, 1]) {
			const arm = {
				sx, grip: grip(sx), l1: 0.29, l2: 0.27,
				up: seg(0.29, 0.064, 0.052, 0.12, m.jacket),
				lo: seg(0.27, 0.053, 0.042, 0.1, m.jacket),
				cuff: mesh(new THREE.CylinderGeometry(0.043, 0.04, 0.05, 12).translate(0, 0.27, 0), m.glove),
				hand: mesh(handGeo(), m.glove),
			};
			arm.cuff.matrixAutoUpdate = true;
			this.arms.push(arm);
			const leg = {
				sx, l1: 0.45, l2: 0.43,
				hip: new THREE.Vector3(sx * 0.105, 0.95, -0.2),
				board: new THREE.Vector3(sx * 0.27, 0.405, 0.27),
				ground: new THREE.Vector3(sx * 0.4, 0.085, 0.05),
				up: seg(0.45, 0.082, 0.062, 0.08, m.denim),
				lo: seg(0.43, 0.06, 0.05, 0.06, m.denim),
				boot: mesh(bootGeo(sx), m.boot),
			};
			this.legs.push(leg);
		}
		this.pose = { foot: 0, yaw: 0, t: 0 };
		this._d = new THREE.Vector3();
		this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
	}

	// Two-bone IK: from joint a towards target t, bending towards pole.
	solve(a, t, l1, l2, pole, mid, end) {
		const d = this._d.subVectors(t, a);
		const L = clamp(d.length(), Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.002);
		d.normalize();
		const x = (l1 * l1 - l2 * l2 + L * L) / (2 * L);
		const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
		mid.subVectors(pole, a);
		mid.addScaledVector(d, -mid.dot(d)).normalize();
		mid.multiplyScalar(h).addScaledVector(d, x).add(a);
		end.copy(a).addScaledVector(d, L);
	}

	place(meshObj, a, b) {
		meshObj.position.copy(a);
		const dir = this._v[4].subVectors(b, a).normalize();
		meshObj.quaternion.setFromUnitVectors(UP, dir);
	}

	updateRider(dt, speed, lean, steer) {
		const P = this.pose;
		P.t += dt;
		const [a, mid, end, tmp] = this._v;
		P.foot = damp(P.foot, speed < 0.7 ? 1 : 0, speed < 0.7 ? 3.2 : 6, dt);
		const tuck = clamp(speed / 30, 0, 1);
		// cruiser posture: upright, a little forward into the wind at speed, hang into turns
		this.torso.rotation.set(0.05 + 0.07 * tuck + Math.sin(P.t * 1.7) * 0.004, 0, lean * 0.14);
		this.torso.scale.set(1, 1, 1 + Math.sin(P.t * 1.6) * 0.012);
		// look through the corner; keep the eyes nearer level than the bike
		const glance = Math.sin(P.t * 0.23) * 0.35 * clamp(1 - speed / 12, 0, 1);
		P.yaw = damp(P.yaw, clamp(-lean * 0.9 - steer * 0.5, -0.6, 0.6) + glance, 4, dt);
		this.neck.rotation.set(-0.06 - 0.05 * tuck, P.yaw * 0.4, -lean * 0.3);
		this.head.rotation.set(-0.03 * tuck, P.yaw * 0.6, -lean * 0.25);
		this.rider.updateMatrixWorld(true);
		// arms reach the grips (which move with the steering)
		for (const arm of this.arms) {
			this.shoulders[arm.sx > 0 ? 1 : 0].getWorldPosition(a);
			this.rider.worldToLocal(a);
			arm.grip.getWorldPosition(tmp);
			this.rider.worldToLocal(tmp);
			const pole = this._pole || (this._pole = new THREE.Vector3());
			pole.set(arm.sx * 0.75, a.y - 0.55, a.z - 0.35);
			this.solve(a, tmp, arm.l1, arm.l2, pole, mid, end);
			this.place(arm.up, a, mid);
			this.place(arm.lo, mid, end);
			arm.cuff.position.copy(mid);
			arm.cuff.quaternion.copy(arm.lo.quaternion);
			arm.hand.position.copy(end);
			arm.hand.quaternion.copy(arm.lo.quaternion);
		}
		// legs: boots on the footboards, left boot down at a stop
		for (const leg of this.legs) {
			const down = leg.sx > 0 ? P.foot : 0;
			tmp.lerpVectors(leg.board, leg.ground, down);
			const pole = this._lp || (this._lp = new THREE.Vector3());
			pole.set(leg.sx * (0.42 + down * 0.15), 1.25, 1.0);
			this.solve(leg.hip, tmp, leg.l1, leg.l2, pole, mid, end);
			this.place(leg.up, leg.hip, mid);
			this.place(leg.lo, mid, end);
			leg.boot.position.copy(end);
			leg.boot.rotation.set(0, leg.sx * 0.12, 0);
		}
	}

	// Headlight on at dusk: brighter lens, glowing tail light.
	setLights(on) {
		this.m.lens.color.setScalar(on ? 4.0 : 1.1).multiply(new THREE.Color(1, 0.96, 0.86));
		this.m.tail.color.set(on ? 0xff2a1a : 0x7a0b0b);
	}

	update(dt, speed, lean, steer, bump, rpm) {
		const st = this.state;
		st.t = (st.t || 0) + dt;
		st.spin += (speed / 0.33) * dt;
		this.frontWheel.rotation.x = st.spin;
		this.rearWheel.rotation.x = st.spin * (0.335 / 0.325);
		// a touch of lean onto the side stand foot when stopped
		this.lean.rotation.z = lean - 0.055 * (this.pose ? this.pose.foot : 0);
		this.steer.rotation.y = lerp(this.steer.rotation.y, steer, 1 - Math.exp(-dt * 8));
		// suspension: small bobbing with speed and road bumps, engine shake at idle
		const t = st.t;
		const shake = Math.sin(t * rpm * 0.105) * 0.0012 * clamp(1 - speed / 8, 0.15, 1);
		st.bob = lerp(st.bob, bump, 1 - Math.exp(-dt * 6));
		this.body.position.y = st.bob + shake;
		this.body.rotation.x = st.pitch;
		this.rider.position.y = Math.sin(t * 2.1) * 0.003 + st.bob * 0.4;
		this.updateRider(dt, speed, lean, this.steer.rotation.y);
	}
}

const UP = new THREE.Vector3(0, 1, 0);

// Limb segment from y=0 to y=L with rounded ends, tapering r0 -> r1 with a soft muscle bulge.
function limbLathe(L, r0, r1, bulge) {
	const pts = [];
	for (let k = 0; k <= 4; k++) {
		const a = -Math.PI / 2 + (k / 4) * (Math.PI / 2);
		pts.push(new THREE.Vector2(Math.max(1e-4, r0 * Math.cos(a)), r0 * Math.sin(a)));
	}
	for (let k = 1; k < 8; k++) {
		const t = k / 8;
		pts.push(new THREE.Vector2(lerp(r0, r1, t) * (1 + bulge * Math.sin(Math.PI * Math.pow(t, 0.8))), t * L));
	}
	for (let k = 0; k <= 4; k++) {
		const a = (k / 4) * (Math.PI / 2);
		pts.push(new THREE.Vector2(Math.max(1e-4, r1 * Math.cos(a)), L + r1 * Math.sin(a)));
	}
	return new THREE.LatheGeometry(pts, 14);
}

// Gloved fist wrapped around the grip, built along +y (forearm direction).
function handGeo() {
	const fist = new THREE.SphereGeometry(1, 14, 10);
	fist.scale(0.045, 0.06, 0.04);
	fist.translate(0, 0.035, 0);
	const thumb = new THREE.CapsuleGeometry(0.014, 0.04, 4, 8);
	thumb.rotateZ(0.5);
	thumb.translate(0.02, 0.05, 0.03);
	return mergeGeos([fist, thumb]);
}

// Riding boot: shaft plus toe box pointing forward (+z).
function bootGeo(sx) {
	const shaft = new THREE.CylinderGeometry(0.052, 0.05, 0.16, 14);
	shaft.translate(0, 0.02, -0.01);
	const foot = new THREE.CapsuleGeometry(0.045, 0.16, 4, 12);
	foot.rotateX(Math.PI / 2);
	foot.scale(1.05, 0.85, 1);
	foot.translate(0, -0.055, 0.07);
	const heel = new THREE.BoxGeometry(0.08, 0.03, 0.06);
	heel.translate(0, -0.09, -0.03);
	void sx;
	return mergeGeos([shaft, foot, heel]);
}

function limbCyl(a, b, r) {
	const d = new THREE.Vector3().subVectors(b, a);
	const g = new THREE.CylinderGeometry(r, r, d.length(), 4, 1, true);
	const m = new THREE.Mesh(g);
	m.position.copy(a).addScaledVector(d, 0.5);
	m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
	m.updateMatrix();
	g.applyMatrix4(m.matrix);
	return g;
}

function mergeGeos(list) {
	let n = 0;
	const parts = list.map((g) => g.toNonIndexed());
	for (const g of parts) n += g.attributes.position.count;
	const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
	let o = 0;
	for (const g of parts) {
		pos.set(g.attributes.position.array, o * 3);
		nor.set(g.attributes.normal.array, o * 3);
		o += g.attributes.position.count;
	}
	const out = new THREE.BufferGeometry();
	out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
	out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
	return out;
}
