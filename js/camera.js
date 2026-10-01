// Cinematic camera rig: chase, side, low wheel and drone views with smooth
// blends between them. Cruise mode cycles views on its own.
import { clamp, damp, lerp, smoothstep } from "./util.js";

export const VIEWS = ["chase", "side", "low", "drone"];
const LABEL = { chase: "Chase", side: "Side", low: "Low", drone: "Drone" };

export class CameraRig {
	constructor(camera, ground) {
		this.cam = camera;
		this.ground = ground;
		this.view = "chase";
		this.prev = null;
		this.blend = 1;
		this.timer = 0;
		this.auto = true;
		this.side = 1;
		this.pos = new THREE.Vector3();
		this.look = new THREE.Vector3();
		this.init = false;
		this.t = 0;
		this.cycle = ["chase", "side", "chase", "drone", "low", "chase", "side"];
		this.ci = 0;
		this.fov = 55;
	}

	label() {
		return LABEL[this.view];
	}

	set(view) {
		if (view === this.view) return;
		this.prev = this.view;
		this.view = view;
		this.blend = 0;
		this.timer = 0;
		if (view === "side") this.side = Math.random() < 0.5 ? 1 : -1;
	}

	next() {
		const i = VIEWS.indexOf(this.view);
		this.set(VIEWS[(i + 1) % VIEWS.length]);
	}

	pose(view, b, out) {
		const f = b.f, r = b.r, p = b.p;
		const t = this.t;
		const sp = clamp(b.v / 30, 0, 1);
		switch (view) {
			case "side": {
				const a = Math.sin(t * 0.07) * 0.5;
				const side = b.prefSide || this.side;
				out.pos.copy(p).addScaledVector(r, side * (5.2 + sp)).addScaledVector(f, 1.2 + a * 3).add({ x: 0, y: 1.25, z: 0 });
				out.look.copy(p).addScaledVector(f, 0.8).add({ x: 0, y: 0.95, z: 0 });
				out.fov = 50;
				break;
			}
			case "low": {
				out.pos.copy(p).addScaledVector(f, 3.4 + sp * 1.5).addScaledVector(r, -1.15).add({ x: 0, y: 0.42, z: 0 });
				out.look.copy(p).addScaledVector(f, -0.6).add({ x: 0, y: 0.95, z: 0 });
				out.fov = 58;
				break;
			}
			case "drone": {
				const a = t * 0.05;
				const side = Math.sin(a) * 16;
				out.pos.copy(p).addScaledVector(f, -24 + Math.cos(a) * 6).addScaledVector(r, side).add({ x: 0, y: 17, z: 0 });
				out.look.copy(p).addScaledVector(f, 16).add({ x: 0, y: 0, z: 0 });
				out.fov = 52;
				break;
			}
			default: {
				const back = 4.9 + sp * 1.1;
				out.pos.copy(p).addScaledVector(f, -back).addScaledVector(r, 0.35).add({ x: 0, y: 1.72 + sp * 0.25, z: 0 });
				out.look.copy(p).addScaledVector(f, 4.5).add({ x: 0, y: 1.0, z: 0 });
				out.fov = 54 + sp * 6;
			}
		}
		return out;
	}

	update(dt, b, cruise) {
		this.t += dt;
		this.timer += dt;
		if (cruise && this.auto && this.timer > (this.view === "chase" ? 26 : 15)) {
			this.ci = (this.ci + 1) % this.cycle.length;
			this.set(this.cycle[this.ci]);
		}
		const A = this.pose(this.view, b, (this._a = this._a || { pos: new THREE.Vector3(), look: new THREE.Vector3() }));
		let tp = A.pos, tl = A.look, fov = A.fov;
		if (this.prev && this.blend < 1) {
			this.blend = Math.min(1, this.blend + dt / 2.6);
			const Bp = this.pose(this.prev, b, (this._b = this._b || { pos: new THREE.Vector3(), look: new THREE.Vector3() }));
			const w = smoothstep(0, 1, this.blend);
			tp = Bp.pos.lerp(A.pos, w);
			tl = Bp.look.lerp(A.look, w);
			fov = lerp(Bp.fov, A.fov, w);
		}
		if (!this.init) {
			this.pos.copy(tp);
			this.look.copy(tl);
			this.init = true;
		}
		const k = this.view === "drone" ? 2.5 : 6;
		this.pos.x = damp(this.pos.x, tp.x, k, dt);
		this.pos.y = damp(this.pos.y, tp.y, k, dt);
		this.pos.z = damp(this.pos.z, tp.z, k, dt);
		this.look.x = damp(this.look.x, tl.x, 9, dt);
		this.look.y = damp(this.look.y, tl.y, 9, dt);
		this.look.z = damp(this.look.z, tl.z, 9, dt);
		// keep above the ground
		const gh = this.ground.height(this.pos.x, this.pos.z);
		if (this.pos.y < gh + 0.3) this.pos.y = gh + 0.3;
		this.cam.position.copy(this.pos);
		this.cam.up.set(0, 1, 0);
		this.cam.lookAt(this.look);
		// a touch of roll with the bike in the chase view
		if (this.view === "chase") this.cam.rotateZ(-b.lean * 0.18);
		this.fov = damp(this.fov, fov, 3, dt);
		if (Math.abs(this.cam.fov - this.fov) > 0.01) {
			this.cam.fov = this.fov;
			this.cam.updateProjectionMatrix();
		}
	}

	snap() {
		this.init = false;
	}
}
