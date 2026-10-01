// Procedural Web Audio: V-twin engine tied to RPM, gear-shift dips, wind,
// tyre hum and slab joints, birds in the groves, surf at the coast and an
// optional soft ambient pad. Nothing is loaded from files.
import { clamp, lerp, smoothstep } from "./util.js";

function noiseBuffer(ctx, sec = 2) {
	const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
	const d = b.getChannelData(0);
	let last = 0;
	for (let i = 0; i < d.length; i++) {
		const w = Math.random() * 2 - 1;
		last = last * 0.6 + w * 0.4;
		d[i] = last;
	}
	return b;
}

// One 720-degree cycle of a 45-degree V-twin at 1000 rpm: two uneven pulses.
function engineBuffer(ctx) {
	const sr = ctx.sampleRate;
	const cycle = 0.12;
	const n = Math.round(sr * cycle);
	const b = ctx.createBuffer(1, n, sr);
	const d = b.getChannelData(0);
	const fire = [0, 315 / 720];
	for (const f0 of fire) {
		const start = Math.round(f0 * n);
		for (let i = 0; i < n; i++) {
			const t = ((i - start + n) % n) / sr;
			const env = Math.exp(-t * 55);
			const thump = Math.sin(2 * Math.PI * 62 * t) * env * 0.9;
			const body = Math.sin(2 * Math.PI * 128 * t + Math.sin(t * 600) * 0.6) * Math.exp(-t * 90) * 0.45;
			const crack = (Math.random() * 2 - 1) * Math.exp(-t * 260) * 0.35;
			d[i] += thump + body + crack;
		}
	}
	let m = 0;
	for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(d[i]));
	for (let i = 0; i < n; i++) d[i] /= m;
	return b;
}

function impulse(ctx, sec, decay) {
	const n = ctx.sampleRate * sec;
	const b = ctx.createBuffer(2, n, ctx.sampleRate);
	for (let c = 0; c < 2; c++) {
		const d = b.getChannelData(c);
		for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
	}
	return b;
}

export class Audio {
	constructor() {
		this.ctx = null;
		this.built = false;
		this.muted = true;
		this.musicOn = false;
		this.t = 0;
		this.birdT = 2;
		this.slab = 0;
		this.chord = -1;
	}

	ensure() {
		if (this.ctx) {
			if (this.ctx.state === "suspended") this.ctx.resume();
			return this.ctx;
		}
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		const ctx = (this.ctx = new AC());
		const master = (this.master = ctx.createGain());
		master.gain.value = 0;
		const comp = ctx.createDynamicsCompressor();
		comp.threshold.value = -14;
		comp.ratio.value = 3;
		master.connect(comp).connect(ctx.destination);
		const noise = noiseBuffer(ctx, 3);
		this.noise = noise;
		// engine
		const eng = ctx.createBufferSource();
		eng.buffer = engineBuffer(ctx);
		eng.loop = true;
		const shaper = ctx.createWaveShaper();
		const curve = new Float32Array(1024);
		for (let i = 0; i < 1024; i++) {
			const x = (i / 1023) * 2 - 1;
			curve[i] = Math.tanh(x * 2.2);
		}
		shaper.curve = curve;
		const elp = (this.engLP = ctx.createBiquadFilter());
		elp.type = "lowpass";
		elp.frequency.value = 600;
		elp.Q.value = 0.8;
		const eg = (this.engGain = ctx.createGain());
		eg.gain.value = 0.0;
		eng.connect(shaper).connect(elp).connect(eg).connect(master);
		eng.start();
		this.eng = eng;
		// exhaust body: low sine at firing frequency
		const sub = ctx.createOscillator();
		sub.type = "triangle";
		const sg = (this.subGain = ctx.createGain());
		sg.gain.value = 0;
		sub.connect(sg).connect(master);
		sub.start();
		this.sub = sub;
		// wind
		const wind = ctx.createBufferSource();
		wind.buffer = noise;
		wind.loop = true;
		const wbp = (this.windBP = ctx.createBiquadFilter());
		wbp.type = "bandpass";
		wbp.frequency.value = 500;
		wbp.Q.value = 0.5;
		const wg = (this.windGain = ctx.createGain());
		wg.gain.value = 0;
		wind.connect(wbp).connect(wg).connect(master);
		wind.start();
		// tyres
		const tyre = ctx.createBufferSource();
		tyre.buffer = noise;
		tyre.loop = true;
		tyre.playbackRate.value = 0.7;
		const tlp = ctx.createBiquadFilter();
		tlp.type = "lowpass";
		tlp.frequency.value = 220;
		const tg = (this.tyreGain = ctx.createGain());
		tg.gain.value = 0;
		tyre.connect(tlp).connect(tg).connect(master);
		tyre.start();
		// surf
		const surf = ctx.createBufferSource();
		surf.buffer = noise;
		surf.loop = true;
		surf.playbackRate.value = 0.5;
		const slp = ctx.createBiquadFilter();
		slp.type = "lowpass";
		slp.frequency.value = 700;
		const sgn = (this.surfGain = ctx.createGain());
		sgn.gain.value = 0;
		surf.connect(slp).connect(sgn).connect(master);
		surf.start();
		// ambience reverb for birds and music
		const verb = (this.verb = ctx.createConvolver());
		verb.buffer = impulse(ctx, 2.6, 2.4);
		const vg = ctx.createGain();
		vg.gain.value = 0.5;
		verb.connect(vg).connect(master);
		// music bus
		const mus = (this.musicGain = ctx.createGain());
		mus.gain.value = 0;
		const mlp = ctx.createBiquadFilter();
		mlp.type = "lowpass";
		mlp.frequency.value = 1100;
		mus.connect(mlp);
		mlp.connect(master);
		mlp.connect(verb);
		this.voices = [];
		for (let k = 0; k < 4; k++) {
			const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
			o1.type = "sawtooth";
			o2.type = "triangle";
			o2.detune.value = 7;
			const g = ctx.createGain();
			g.gain.value = 0.0;
			o1.connect(g);
			o2.connect(g);
			g.connect(mus);
			o1.start();
			o2.start();
			this.voices.push({ o1, o2, g });
		}
		this.built = true;
		this.apply();
		return ctx;
	}

	setMuted(m) {
		this.muted = m;
		if (!m) this.ensure();
		this.apply();
	}

	setMusic(on) {
		this.musicOn = on;
		if (on) this.ensure();
		this.apply();
	}

	apply() {
		if (!this.ctx) return;
		const t = this.ctx.currentTime;
		this.master.gain.cancelScheduledValues(t);
		this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, t, 0.15);
		this.musicGain.gain.setTargetAtTime(this.musicOn && !this.muted ? 0.05 : 0, t, 1.2);
	}

	shift(up) {
		if (!this.ctx || this.muted) return;
		const t = this.ctx.currentTime;
		const g = this.engGain.gain;
		g.cancelScheduledValues(t);
		g.setValueAtTime(g.value, t);
		g.linearRampToValueAtTime(g.value * (up ? 0.35 : 0.6), t + 0.05);
		g.linearRampToValueAtTime(g.value, t + 0.22);
	}

	chirp(pan) {
		const ctx = this.ctx, t = ctx.currentTime;
		const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
		const f = 2600 + Math.random() * 2200;
		o.frequency.setValueAtTime(f, t);
		const notes = 2 + Math.floor(Math.random() * 4);
		for (let k = 0; k < notes; k++) {
			o.frequency.linearRampToValueAtTime(f * (1 + (Math.random() - 0.3) * 0.5), t + 0.05 + k * 0.09);
		}
		g.gain.setValueAtTime(0, t);
		for (let k = 0; k < notes; k++) {
			g.gain.linearRampToValueAtTime(0.025, t + k * 0.09 + 0.02);
			g.gain.linearRampToValueAtTime(0.0, t + k * 0.09 + 0.07);
		}
		if (p) {
			p.pan.value = pan;
			o.connect(g).connect(p).connect(this.verb);
			p.connect(this.master);
		} else {
			o.connect(g).connect(this.master);
		}
		o.start(t);
		o.stop(t + notes * 0.09 + 0.1);
	}

	thump(level) {
		const ctx = this.ctx, t = ctx.currentTime;
		const s = ctx.createBufferSource();
		s.buffer = this.noise;
		const f = ctx.createBiquadFilter();
		f.type = "lowpass";
		f.frequency.value = 120;
		const g = ctx.createGain();
		g.gain.setValueAtTime(level, t);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
		s.connect(f).connect(g).connect(this.master);
		s.start(t, Math.random() * 2, 0.12);
	}

	update(dt, st) {
		if (!this.ctx || !this.built) return;
		const t = this.ctx.currentTime;
		this.t += dt;
		const rpm = st.rpm, v = st.v, th = st.throttle;
		this.eng.playbackRate.setTargetAtTime(clamp(rpm / 1000, 0.6, 6), t, 0.05);
		this.sub.frequency.setTargetAtTime(rpm / 60, t, 0.05);
		this.engLP.frequency.setTargetAtTime(380 + th * 900 + rpm * 0.12, t, 0.08);
		const eGain = 0.16 + th * 0.12 + (rpm / 5000) * 0.06;
		if (!this._shiftHold || this.t > this._shiftHold) this.engGain.gain.setTargetAtTime(eGain, t, 0.08);
		this.subGain.gain.setTargetAtTime(0.05 + th * 0.04, t, 0.1);
		const sp = clamp(v / 30, 0, 1.4);
		this.windBP.frequency.setTargetAtTime(350 + sp * 900, t, 0.2);
		this.windGain.gain.setTargetAtTime(sp * sp * 0.22, t, 0.2);
		this.tyreGain.gain.setTargetAtTime(sp * 0.16, t, 0.2);
		// surf swells every ~9 s
		const swell = 0.55 + 0.45 * Math.sin(this.t * 0.7) * Math.sin(this.t * 0.31 + 1);
		this.surfGain.gain.setTargetAtTime(st.coast * (0.08 + swell * 0.12), t, 0.4);
		// freeway slab joints
		if (st.slabs && v > 3) {
			this.slab += v * dt;
			if (this.slab > 4.6) {
				this.slab -= 4.6;
				this.thump(0.05 + sp * 0.05);
			}
		}
		// birds in groves and quiet streets
		this.birdT -= dt;
		if (this.birdT < 0) {
			this.birdT = 1.5 + Math.random() * 4;
			if (st.birds > 0.3 && v < 25 && !this.muted) this.chirp(Math.random() * 1.6 - 0.8);
		}
		// pad chords
		if (this.musicOn) {
			const CH = [[53, 57, 60, 64], [52, 55, 59, 64], [50, 57, 60, 65], [46, 53, 57, 62]];
			const c = Math.floor(this.t / 9) % CH.length;
			if (c !== this.chord) {
				this.chord = c;
				CH[c].forEach((m, k) => {
					const f = 440 * Math.pow(2, (m - 69) / 12);
					const vo = this.voices[k];
					vo.o1.frequency.setTargetAtTime(f, t, 0.8);
					vo.o2.frequency.setTargetAtTime(f * 2, t, 0.8);
					vo.g.gain.setTargetAtTime(0.18, t, 1.5);
				});
			}
		}
	}
}

export { lerp, smoothstep };
