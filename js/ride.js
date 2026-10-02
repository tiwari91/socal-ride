// Motion along the road: Cruise autopilot and Ride (player) dynamics,
// gears/RPM, lean and the input sources (keyboard, touch, gamepad).
import { clamp, damp, lerp } from "./util.js";
import { KIND } from "./route.js";

const G = 9.81;
const GEARS = [0, 7.5, 12.5, 18, 23.5, 28.5, 99]; // top speed (m/s) per gear
const MPH = 2.23694;

export function cruiseSpeed(kind, zone) {
	if (kind === KIND.freeway) return zone === "canyon" ? 28.5 : 29;
	if (kind === KIND.ramp) return 17;
	if (kind === KIND.coast) return 20;
	if (kind === KIND.boulevard) return zone === "irvine" ? 19 : 17;
	return 12;
}

export class Rider {
	constructor(route) {
		this.route = route;
		this.s = 0;
		this.d = 1.8;
		this.psi = 0;
		this.v = 0;
		this.lean = 0;
		this.steerVis = 0;
		this.gear = 1;
		this.rpm = 900;
		this.throttle = 0;
		this.mode = "cruise";
		this.input = { throttle: 0, brake: 0, steer: 0 };
		this.P = {};
		this.shift = 0;
		this.lead = null;
		this.finished = false;
		this.pace = 1;
	}

	laneTarget(i) {
		const r = this.route;
		const hw = r.hw[i];
		const lanes = Math.max(1, Math.round((2 * hw) / 3.6));
		const lw = (2 * hw) / lanes;
		const k = r.kind[i];
		// freeways: second lane from the right; elsewhere: right lane
		const idx = k === KIND.freeway && lanes >= 3 ? lanes - 2 : lanes - 1;
		return -hw + lw * (idx + 0.5);
	}

	limits(i) {
		const r = this.route;
		const k = r.kind[i];
		const right = r.R[i] - 0.7;
		const left = k === KIND.freeway || k === KIND.ramp ? -r.hw[i] - 0.6 : -r.hw[i] + 0.5;
		return [left, right];
	}

	jump(s) {
		this.s = clamp(s, 0, this.route.length - 2);
		const i = Math.round(this.s / this.route.step);
		this.d = this.laneTarget(i);
		this.psi = 0;
		this.v = Math.min(this.v, 10);
		this.finished = false;
	}

	update(dt) {
		const r = this.route, P = r.at(this.s, this.P);
		const i = P.i;
		const zone = r.zoneAt(this.s);
		let accel = 0, psiDot = 0;
		if (this.mode === "cruise") {
			// target speed with curvature look-ahead and a gentle stop at the end
			let vt = cruiseSpeed(P.kind, zone) * this.pace;
			const look = Math.max(40, this.v * this.v / 3 + 40);
			for (let a = 0; a < look; a += 12) {
				const j = Math.min(r.n - 1, i + Math.round(a / r.step));
				const k = Math.abs(r.curv[j]);
				if (k > 1e-4) vt = Math.min(vt, Math.sqrt(2.6 / k) + a * 0.06);
				vt = Math.min(vt, cruiseSpeed(r.kind[j], zone) * this.pace + a * 0.05);
			}
			const left = r.length - 40 - this.s;
			if (left < 400) vt = Math.min(vt, left < 1.5 ? 0 : Math.max(2.2, Math.sqrt(left * 1.4)));
			if (this.lead) vt = Math.min(vt, this.lead.v + (this.lead.gap - 18) * 0.25);
			vt = Math.max(0, vt);
			accel = clamp((vt - this.v) * (left < 6 ? 2 : 0.6), -3.5, 1.6);
			this.throttle = clamp((vt - this.v) * 0.4 + 0.25, 0, 1);
			const dT = this.laneTarget(i);
			const want = clamp((dT - this.d) * 0.5, -1.1, 1.1);
			const psiT = Math.asin(clamp(want / Math.max(this.v, 2), -0.4, 0.4));
			psiDot = (psiT - this.psi) * 3;
			if (left < 3 && this.v < 0.5) {
				this.v = Math.max(0, this.v - dt * 2);
				this.finished = true;
			}
		} else {
			const inp = this.input;
			const v = this.v;
			const drive = inp.throttle * 4.2 * clamp(1 - v / 52, 0, 1) * (v < 5 ? 1.15 : 1);
			const brake = inp.brake * 8.5;
			const drag = 0.0011 * v * v + (inp.throttle < 0.05 ? 0.45 : 0.1);
			accel = drive - brake - drag;
			this.throttle = inp.throttle;
			if (this.lead && this.lead.gap < 6 && this.v > this.lead.v) accel = Math.min(accel, (this.lead.v - this.v) * 4);
			const kmax = Math.min(0.09, 7 / (v * v + 25));
			const st = inp.steer;
			psiDot = v * st * kmax * 1.4 - (1 - Math.abs(st)) * 1.8 * this.psi;
		}
		this.v = Math.max(0, this.v + accel * dt);
		this.psi = clamp(this.psi + psiDot * dt, -0.6, 0.6);
		this.d += this.v * Math.sin(this.psi) * dt;
		const [lo, hi] = this.limits(i);
		if (this.d < lo || this.d > hi) {
			this.d = clamp(this.d, lo, hi);
			this.psi *= 0.3;
			if (this.mode === "ride") this.v *= 1 - 0.6 * dt;
		}
		this.s = clamp(this.s + this.v * Math.cos(this.psi) * dt, 0, r.length - 1);
		// lean into the path curvature
		const kPath = P.curv + (this.v > 1 ? psiDot / this.v : 0);
		const leanT = clamp(Math.atan((this.v * this.v * kPath) / G), -0.62, 0.62);
		this.lean = damp(this.lean, leanT, 5, dt);
		this.steerVis = damp(this.steerVis, clamp(kPath * 1.7 + (this.v < 4 ? this.psi * 0.8 : 0), -0.45, 0.45), 6, dt);
		this.accel = accel;
		this.gears(dt);
	}

	gears(dt) {
		const v = this.v;
		let g = this.gear;
		if (v > GEARS[g] * 0.97 && g < 6) g++;
		else if (g > 1 && v < GEARS[g - 1] * 0.7) g--;
		if (g !== this.gear) {
			this.shift = g > this.gear ? 1 : -1;
			this.gear = g;
		}
		const lo = g === 1 ? 0 : GEARS[g - 1] * 0.7, hi = GEARS[g === 6 ? 5 : g] * (g === 6 ? 1.35 : 1);
		const f = clamp((v - lo) / (hi - lo), 0, 1);
		const target = v < 0.5 ? 900 : lerp(1900, 4900, f) + this.throttle * 250;
		this.rpm = damp(this.rpm, target, 7, dt);
	}

	get mph() {
		return this.v * MPH;
	}
}

// ---------- input ----------
export class Input {
	constructor() {
		this.keys = new Set();
		this.touch = { throttle: 0, brake: 0, steer: 0 };
		this.state = { throttle: 0, brake: 0, steer: 0 };
		this.onKey = null;
		window.addEventListener("keydown", (e) => {
			if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
			// while the explore map is open, keys pan the map instead of riding
			if (document.body.classList.contains("exploring")) {
				if (this.onKey && (e.code === "Escape" || e.code === "KeyG")) this.onKey(e);
				return;
			}
			this.keys.add(e.code);
			if (this.onKey) this.onKey(e);
			if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
		});
		window.addEventListener("keyup", (e) => this.keys.delete(e.code));
		window.addEventListener("blur", () => this.keys.clear());
		this.padActive = false;
	}

	bindTouch(el, field, value) {
		const on = (e) => {
			e.preventDefault();
			this.touch[field] = value;
			el.classList.add("on");
		};
		const off = (e) => {
			e.preventDefault();
			if (this.touch[field] === value) this.touch[field] = 0;
			el.classList.remove("on");
		};
		el.addEventListener("pointerdown", on);
		el.addEventListener("pointerup", off);
		el.addEventListener("pointercancel", off);
		el.addEventListener("pointerleave", off);
	}

	poll(dt) {
		const k = this.keys;
		let th = k.has("ArrowUp") || k.has("KeyW") ? 1 : 0;
		let br = k.has("ArrowDown") || k.has("KeyS") || k.has("Space") ? 1 : 0;
		let st = (k.has("ArrowRight") || k.has("KeyD") ? 1 : 0) - (k.has("ArrowLeft") || k.has("KeyA") ? 1 : 0);
		th = Math.max(th, this.touch.throttle);
		br = Math.max(br, this.touch.brake);
		if (this.touch.steer) st = this.touch.steer;
		const pads = navigator.getGamepads ? navigator.getGamepads() : [];
		for (const p of pads || []) {
			if (!p) continue;
			const ax = p.axes[0] || 0;
			const rt = p.buttons[7] ? p.buttons[7].value : 0;
			const lt = p.buttons[6] ? p.buttons[6].value : 0;
			const a = p.buttons[0] && p.buttons[0].pressed ? 1 : 0;
			if (Math.abs(ax) > 0.12) st = ax;
			th = Math.max(th, rt, a);
			br = Math.max(br, lt);
			if (Math.abs(ax) > 0.12 || rt > 0.05 || lt > 0.05 || a) this.padActive = true;
		}
		const S = this.state;
		S.throttle = damp(S.throttle, th, 6, dt);
		S.brake = damp(S.brake, br, 10, dt);
		S.steer = damp(S.steer, st, 7, dt);
		return S;
	}
}

export { MPH };
