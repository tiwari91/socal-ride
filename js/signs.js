// Generic green freeway guide signs (real place names, no logos), roadside
// distance and speed-limit signs, generated from the route itself.
import { clamp } from "./util.js";
import { KIND } from "./route.js";

const DEST = {
	"I-10": { W: ["San Bernardino", "Los Angeles"], E: ["Redlands", "Palm Springs"] },
	"I-215": { S: ["Riverside", "San Diego"], N: ["San Bernardino"] },
	"CA-91": { W: ["Corona", "Beach Cities"], E: ["Riverside"] },
	"CA-57": { N: ["Fullerton", "Cal State Fullerton"], S: ["Anaheim"] },
	"I-5": { S: ["Santa Ana", "San Diego"], N: ["Los Angeles"] },
	"CA-55": { S: ["Costa Mesa", "Newport Beach"], N: ["Riverside"] },
	"I-405": { S: ["Irvine", "San Diego"], N: ["Long Beach"] },
};
const DIRW = { N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST" };

function refOf(name) {
	const m = /^(I-\d+|CA-\d+)/.exec(name || "");
	return m ? m[1] : null;
}

function compass(r, i0, i1) {
	const dx = r.X[i1] - r.X[i0], dz = r.Z[i1] - r.Z[i0];
	if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? "E" : "W";
	return dz > 0 ? "S" : "N";
}

function shield(g, x, y, s, ref) {
	const num = ref.split("-")[1];
	g.save();
	g.translate(x, y);
	if (ref.startsWith("I-")) {
		g.fillStyle = "#fff";
		g.beginPath();
		g.moveTo(-s * 0.5, -s * 0.45);
		g.quadraticCurveTo(0, -s * 0.6, s * 0.5, -s * 0.45);
		g.quadraticCurveTo(s * 0.55, s * 0.25, 0, s * 0.55);
		g.quadraticCurveTo(-s * 0.55, s * 0.25, -s * 0.5, -s * 0.45);
		g.fill();
		g.fillStyle = "#1d4fa0";
		g.beginPath();
		g.moveTo(-s * 0.43, -s * 0.2);
		g.lineTo(s * 0.43, -s * 0.2);
		g.quadraticCurveTo(s * 0.45, s * 0.25, 0, s * 0.47);
		g.quadraticCurveTo(-s * 0.45, s * 0.25, -s * 0.43, -s * 0.2);
		g.fill();
		g.fillStyle = "#b8202a";
		g.beginPath();
		g.moveTo(-s * 0.44, -s * 0.4);
		g.quadraticCurveTo(0, -s * 0.52, s * 0.44, -s * 0.4);
		g.lineTo(s * 0.44, -s * 0.26);
		g.lineTo(-s * 0.44, -s * 0.26);
		g.fill();
		g.fillStyle = "#fff";
		g.font = `700 ${Math.round(s * (num.length > 2 ? 0.36 : 0.44))}px Overpass, Arial, sans-serif`;
		g.textAlign = "center";
		g.textBaseline = "middle";
		g.fillText(num, 0, s * 0.12);
	} else {
		// California spade-shaped state route marker
		g.fillStyle = "#fff";
		g.beginPath();
		g.moveTo(-s * 0.42, -s * 0.5);
		g.lineTo(s * 0.42, -s * 0.5);
		g.quadraticCurveTo(s * 0.55, s * 0.1, 0, s * 0.55);
		g.quadraticCurveTo(-s * 0.55, s * 0.1, -s * 0.42, -s * 0.5);
		g.fill();
		g.fillStyle = "#1f6b3a";
		g.beginPath();
		g.moveTo(-s * 0.36, -s * 0.44);
		g.lineTo(s * 0.36, -s * 0.44);
		g.quadraticCurveTo(s * 0.47, s * 0.08, 0, s * 0.47);
		g.quadraticCurveTo(-s * 0.47, s * 0.08, -s * 0.36, -s * 0.44);
		g.fill();
		g.fillStyle = "#fff";
		g.font = `700 ${Math.round(s * 0.42)}px Overpass, Arial, sans-serif`;
		g.textAlign = "center";
		g.textBaseline = "middle";
		g.fillText(num, 0, -s * 0.02);
	}
	g.restore();
}

function canvasSign(w, h, draw) {
	const cv = document.createElement("canvas");
	cv.width = w;
	cv.height = h;
	const g = cv.getContext("2d");
	draw(g, w, h);
	const t = new THREE.CanvasTexture(cv);
	t.encoding = THREE.sRGBEncoding;
	t.anisotropy = 4;
	return t;
}

function greenPanel(g, w, h) {
	g.fillStyle = "#0f6b45";
	g.fillRect(0, 0, w, h);
	g.strokeStyle = "#f2f2ee";
	g.lineWidth = 8;
	g.beginPath();
	g.roundRect ? g.roundRect(10, 10, w - 20, h - 20, 18) : g.rect(10, 10, w - 20, h - 20);
	g.stroke();
}

export function guideTexture(ref, dir, lines, exitNote) {
	return canvasSign(768, 384, (g, w, h) => {
		greenPanel(g, w, h);
		g.fillStyle = "#f4f4ef";
		g.textBaseline = "middle";
		if (ref) {
			shield(g, 110, 150, 140, ref);
			g.font = "700 40px Overpass, Arial, sans-serif";
			g.textAlign = "center";
			g.fillText(DIRW[dir] || "", 110, 262);
		}
		g.textAlign = "left";
		g.font = "700 66px Overpass, Arial, sans-serif";
		lines.slice(0, 2).forEach((l, k) => g.fillText(l, ref ? 215 : 60, 125 + k * 90));
		if (exitNote) {
			g.font = "700 40px Overpass, Arial, sans-serif";
			g.fillText(exitNote, ref ? 215 : 60, 320);
		}
	});
}

function distanceTexture(rows) {
	return canvasSign(640, 80 + rows.length * 84, (g, w, h) => {
		greenPanel(g, w, h);
		g.fillStyle = "#f4f4ef";
		g.font = "700 58px Overpass, Arial, sans-serif";
		g.textBaseline = "middle";
		rows.forEach(([name, mi], k) => {
			const y = 82 + k * 84;
			g.textAlign = "left";
			g.fillText(name, 48, y);
			g.textAlign = "right";
			g.fillText(String(mi), w - 48, y);
		});
	});
}

function speedTexture(mph) {
	return canvasSign(256, 320, (g, w, h) => {
		g.fillStyle = "#f6f6f2";
		g.fillRect(0, 0, w, h);
		g.strokeStyle = "#111";
		g.lineWidth = 8;
		g.strokeRect(14, 14, w - 28, h - 28);
		g.fillStyle = "#111";
		g.textAlign = "center";
		g.font = "700 46px Overpass, Arial, sans-serif";
		g.fillText("SPEED", w / 2, 78);
		g.fillText("LIMIT", w / 2, 128);
		g.font = "800 120px Overpass, Arial, sans-serif";
		g.fillText(String(mph), w / 2, 250);
	});
}

export function buildSigns(route) {
	const r = route;
	const group = new THREE.Group();
	const steel = new THREE.MeshLambertMaterial({ color: 0x9ea2a6 });
	const back = new THREE.MeshLambertMaterial({ color: 0x8c9196 });
	const P = {};
	const place = (s) => r.at(s, P) && { ...P };
	const chapterAhead = (s, n) => r.chapters.filter((c) => c.s > s + 1500).slice(0, n);
	const miles = (m) => Math.max(1, Math.round(m / 1609));
	// freeway runs
	const runs = [];
	let cur = null;
	for (let i = 0; i < r.n; i++) {
		const fw = r.kind[i] === KIND.freeway;
		const ref = fw ? refOf(r.names[r.nameIdx[i]]) : null;
		if (fw && ref && (!cur || cur.ref !== ref)) {
			if (cur) runs.push(cur);
			cur = { ref, i0: i, i1: i };
		} else if (fw && cur) cur.i1 = i;
		else if (!fw && cur && i - cur.i1 > 40) {
			runs.push(cur);
			cur = null;
		}
	}
	if (cur) runs.push(cur);
	const gantries = [];
	for (const run of runs) {
		const dir = compass(r, run.i0, run.i1);
		const dest = (DEST[run.ref] && DEST[run.ref][dir]) || chapterAhead(run.i0 * r.step, 2).map((c) => c.name);
		gantries.push({ s: run.i0 * r.step + 420, tex: guideTexture(run.ref, dir, dest) });
		// advance notice for the exit at the end of the run
		const nextName = r.names[r.nameIdx[Math.min(r.n - 1, run.i1 + 60)]];
		const nref = refOf(nextName);
		const ndir = nref ? compass(r, run.i1 + 30, Math.min(r.n - 1, run.i1 + 300)) : null;
		const label = nref ? ((DEST[nref] && DEST[nref][ndir]) || [nextName]) : [nextName.replace(/ (Avenue|Boulevard|Road|Drive|Street)$/, (m) => " " + m.trim().slice(0, 4).replace("Aven", "Ave").replace("Boul", "Blvd").replace("Stre", "St").replace("Driv", "Dr"))];
		const sx = run.i1 * r.step - 650;
		if (sx > run.i0 * r.step + 900) gantries.push({ s: sx, tex: guideTexture(nref, ndir, label, "EXIT  1/2 MILE") });
		// distance signs every ~9 km
		for (let s = run.i0 * r.step + 2500; s < run.i1 * r.step - 1500; s += 9000) {
			const rows = chapterAhead(s, 3).map((c) => [c.name, miles(c.s - s)]);
			if (rows.length) gantries.push({ s, tex: distanceTexture(rows), roadside: true, h: 0.8 + rows.length * 0.85 });
		}
	}
	// coast highway marker
	const pch = r.chapters.find((c) => c.name === "Newport Beach");
	if (pch) gantries.push({ s: pch.s + 400, tex: distanceTexture([["Laguna Beach", miles(r.length - pch.s - 3000)], ["Crystal Cove", 3]]), roadside: true, h: 2.6 });
	for (const g of gantries) {
		const p = place(g.s);
		const i = p.i;
		const yaw = Math.atan2(p.tx, p.tz) + Math.PI;
		const sign = new THREE.Group();
		sign.position.set(p.x, p.y, p.z);
		sign.rotation.y = yaw;
		const tex = g.tex;
		const mat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0x0b2a1c, emissiveIntensity: 0.0 });
		if (g.roadside) {
			const w = 4.4, h = g.h || 2.4;
			const x = r.R[i] + 2.2; // local +x is the rider's right after the yaw flip
			const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
			panel.position.set(x, 2.4 + h / 2, 0);
			const rear = new THREE.Mesh(new THREE.PlaneGeometry(w, h), back);
			rear.rotation.y = Math.PI;
			rear.position.copy(panel.position);
			sign.add(panel, rear);
			for (const dx of [-1.4, 1.4]) {
				const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.4 + h, 6), steel);
				post.position.set(x + dx, (2.4 + h) / 2, -0.06);
				sign.add(post);
			}
		} else {
			const left = -(r.hw[i] + 1.2), right = r.R[i] + 1.0;
			const span = right - left;
			const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.5, 0.5), steel);
			beam.position.set((left + right) / 2, 7.4, -0.3);
			sign.add(beam);
			for (const x of [left, right]) {
				const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 7.6, 8), steel);
				post.position.set(x, 3.8, -0.3);
				sign.add(post);
			}
			const panel = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 3.6), mat);
			const cx = clamp(r.hw[i] * 0.3, left + 4, right - 4);
			panel.position.set(cx, 7.6, 0.02);
			const rear = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 3.6), back);
			rear.rotation.y = Math.PI;
			rear.position.set(cx, 7.6, -0.02);
			sign.add(panel, rear);
		}
		sign.userData.mat = mat;
		group.add(sign);
	}
	// speed limit signs
	const spd = new Map();
	for (let s = 1200; s < r.length - 500; s += 6000) {
		const p = place(s);
		const k = p.kind;
		if (k === KIND.ramp) continue;
		const mph = k === KIND.freeway ? 65 : k === KIND.coast ? 45 : k === KIND.boulevard ? 40 : 30;
		if (!spd.has(mph)) spd.set(mph, new THREE.MeshLambertMaterial({ map: speedTexture(mph) }));
		const sign = new THREE.Group();
		sign.position.set(p.x, p.y, p.z);
		sign.rotation.y = Math.atan2(p.tx, p.tz) + Math.PI;
		const x = r.R[p.i] + 1.6;
		const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.94), spd.get(mph));
		panel.position.set(x, 2.2, 0);
		const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.2, 5), steel);
		post.position.set(x, 1.1, -0.03);
		sign.add(panel, post);
		group.add(sign);
	}
	group.traverse((o) => {
		if (o.isMesh) o.matrixAutoUpdate = true;
	});
	return group;
}
