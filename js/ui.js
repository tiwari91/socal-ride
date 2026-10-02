// HUD, menus, minimap, chapter cards, settings and theme.
import { clamp, store } from "./util.js";
import { PAINTS } from "./bike.js";

export const CHAPTER_LINES = {
	Redlands: "Orange groves, mission-revival storefronts and the San Bernardino Mountains at your back.",
	Riverside: "Mission Inn Avenue under the palms, Mount Rubidoux rising to the west.",
	"Santa Ana Canyon": "The 91 threads the river gap between the Chino Hills and the Santa Ana Mountains.",
	Fullerton: "Nutwood Avenue past Cal State Fullerton, then south on State College through Anaheim.",
	Irvine: "Wide boulevards, eucalyptus windbreaks and jacarandas around UC Irvine.",
	"Newport Beach": "Pacific Coast Highway along the bluffs of Corona del Mar and Crystal Cove.",
	"Laguna Beach": "Coves, cliffs and the sun going down over the Pacific.",
};
const $ = (id) => document.getElementById(id);

export class UI {
	constructor(app) {
		this.app = app;
		this.route = app.route;
		this.chapter = -1;
		this.cardTimer = 0;
		this.toastTimer = 0;
		this.poiSeen = new Map();
		this.poiT = 0;
		this.mapT = 0;
		this.hintT = 0;
		this.touchDev = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
		if (this.touchDev) document.body.classList.add("touchdev");
		this.buildTicks();
		this.buildMap();
		this.buildChapters();
		this.bind();
	}

	buildTicks() {
		const g = $("ticks");
		const ns = "http://www.w3.org/2000/svg";
		for (let mph = 0; mph <= 100; mph += 10) {
			const a = (-225 + (mph / 100) * 270) * (Math.PI / 180);
			const major = mph % 20 === 0;
			const r0 = major ? 40 : 42, r1 = 45;
			const l = document.createElementNS(ns, "line");
			l.setAttribute("x1", 60 + Math.cos(a) * r0);
			l.setAttribute("y1", 60 + Math.sin(a) * r0);
			l.setAttribute("x2", 60 + Math.cos(a) * r1);
			l.setAttribute("y2", 60 + Math.sin(a) * r1);
			g.appendChild(l);
			if (major) {
				const t = document.createElementNS(ns, "text");
				t.setAttribute("x", 60 + Math.cos(a) * 33);
				t.setAttribute("y", 60 + Math.sin(a) * 33);
				t.textContent = mph;
				g.appendChild(t);
			}
		}
	}

	buildMap() {
		const r = this.route;
		let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
		for (let i = 0; i < r.n; i += 10) {
			x0 = Math.min(x0, r.X[i]); x1 = Math.max(x1, r.X[i]);
			z0 = Math.min(z0, r.Z[i]); z1 = Math.max(z1, r.Z[i]);
		}
		const W = 300, pad = 26;
		const sc = (W - pad * 2) / Math.max(x1 - x0, z1 - z0);
		const ox = (W - (x1 - x0) * sc) / 2, oz = (W - (z1 - z0) * sc) / 2;
		this.mp = (x, z) => [ox + (x - x0) * sc, oz + (z - z0) * sc];
		this.mapPts = [];
		for (let i = 0; i < r.n; i += 12) this.mapPts.push(this.mp(r.X[i], r.Z[i]));
		// coast line for context
		this.mapCoast = (this.app.coast || []).map((L) => {
			const pts = [];
			for (let k = 0; k < L.length; k += 6) pts.push(this.mp(L[k], L[k + 1]));
			return pts;
		});
	}

	drawMap() {
		const cv = $("minimap"), g = cv.getContext("2d");
		const st = getComputedStyle(document.documentElement);
		const ink = st.getPropertyValue("--ink").trim() || "#1d2327";
		const accent = st.getPropertyValue("--accent").trim() || "#d9652a";
		const teal = st.getPropertyValue("--teal").trim() || "#1f5f66";
		g.clearRect(0, 0, 300, 300);
		g.lineCap = g.lineJoin = "round";
		g.strokeStyle = teal;
		g.globalAlpha = 0.55;
		g.lineWidth = 3;
		for (const L of this.mapCoast) {
			g.beginPath();
			L.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
			g.stroke();
		}
		g.globalAlpha = 0.28;
		g.strokeStyle = ink;
		g.lineWidth = 7;
		g.beginPath();
		this.mapPts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
		g.stroke();
		g.globalAlpha = 1;
		const s = this.app.rider.s;
		const upto = Math.floor(s / this.route.step / 12);
		g.strokeStyle = accent;
		g.lineWidth = 7;
		g.beginPath();
		for (let k = 0; k <= Math.min(upto, this.mapPts.length - 1); k++) {
			const [x, y] = this.mapPts[k];
			k ? g.lineTo(x, y) : g.moveTo(x, y);
		}
		g.stroke();
		g.fillStyle = ink;
		for (const c of this.route.chapters) {
			const P = this.route.at(c.s);
			const [x, y] = this.mp(P.x, P.z);
			g.beginPath();
			g.arc(x, y, 5, 0, Math.PI * 2);
			g.fill();
		}
		const P = this.route.at(s);
		const [x, y] = this.mp(P.x, P.z);
		g.fillStyle = "#fff";
		g.beginPath();
		g.arc(x, y, 12, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = accent;
		g.beginPath();
		g.arc(x, y, 8, 0, Math.PI * 2);
		g.fill();
		const done = s / 1609, total = this.route.length / 1609;
		$("map-meta").textContent = `${done.toFixed(done < 10 ? 1 : 0)} of ${Math.round(total)} mi`;
	}

	buildChapters() {
		const ol = $("chapter-list");
		ol.innerHTML = "";
		this.route.chapters.forEach((c, k) => {
			const li = document.createElement("li");
			const b = document.createElement("button");
			b.innerHTML = `<span class="n">${k + 1}</span><span class="t">${c.name}</span><span class="d">mile ${Math.round(c.s / 1609)}</span><span class="l">${CHAPTER_LINES[c.name] || ""}</span>`;
			b.addEventListener("click", () => {
				this.app.jumpTo(c.s + (k === 0 ? 0 : 60));
				this.close();
			});
			li.appendChild(b);
			ol.appendChild(li);
		});
	}

	open(id) {
		for (const s of ["chapters", "settings"]) $(s).hidden = s !== id || !$(s).hidden;
	}

	close() {
		$("chapters").hidden = true;
		$("settings").hidden = true;
	}

	bind() {
		const app = this.app;
		$("btn-chapters").addEventListener("click", () => this.open("chapters"));
		$("btn-map").addEventListener("click", () => app.explore.toggle());
		$("map-wrap").addEventListener("click", () => app.explore.show());
		// clicking a floating place label in 3D opens it on the map
		const cv = $("scene");
		let down = null;
		cv.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
		cv.addEventListener("pointerup", (e) => {
			if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6 || !app.places) return;
			const p = app.places.pick(e.clientX, e.clientY);
			if (p) app.explore.show(p);
		});
		cv.addEventListener("pointermove", (e) => {
			if (e.pointerType !== "mouse" || !app.places) return;
			this._hoverT = (this._hoverT || 0) + 1;
			if (this._hoverT % 3) return;
			cv.style.cursor = app.places.pick(e.clientX, e.clientY) ? "pointer" : "";
		});
		$("btn-settings").addEventListener("click", () => this.open("settings"));
		document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => this.close()));
		$("btn-theme").addEventListener("click", () => {
			const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
			const next = cur === "dark" ? "light" : "dark";
			document.documentElement.dataset.theme = next;
			store.set("theme", next);
		});
		const snd = $("btn-sound");
		const setSnd = (on) => {
			snd.classList.toggle("active", on);
			snd.title = on ? "Sound on" : "Sound (muted)";
			app.audio.setMuted(!on);
			store.set("sound", on);
		};
		snd.addEventListener("click", () => setSnd(snd.classList.contains("active") ? false : true));
		this.setSnd = setSnd;
		const mus = $("btn-music");
		mus.addEventListener("click", () => {
			const on = !mus.classList.contains("active");
			mus.classList.toggle("active", on);
			app.audio.setMusic(on);
			if (on && !snd.classList.contains("active")) setSnd(true);
			store.set("music", on);
		});
		this.setMode = (m) => {
			app.setMode(m);
			$("mode-cruise").classList.toggle("active", m === "cruise");
			$("mode-ride").classList.toggle("active", m === "ride");
			$("mode-cruise").setAttribute("aria-selected", m === "cruise");
			$("mode-ride").setAttribute("aria-selected", m === "ride");
			document.body.classList.toggle("ride", m === "ride");
			if (m === "ride") {
				$("hint").classList.add("show");
				this.hintT = 6;
			}
		};
		$("mode-cruise").addEventListener("click", () => this.setMode("cruise"));
		$("mode-ride").addEventListener("click", () => this.setMode("ride"));
		$("btn-cam").addEventListener("click", () => {
			app.rig.auto = false;
			app.rig.next();
		});
		// touch controls
		const inp = app.input;
		inp.bindTouch($("t-left"), "steer", -1);
		inp.bindTouch($("t-right"), "steer", 1);
		inp.bindTouch($("t-gas"), "throttle", 1);
		inp.bindTouch($("t-brake"), "brake", 1);
		inp.onKey = (e) => {
			if (e.code === "KeyG") {
				this.close();
				app.explore.toggle();
			} else if (e.code === "Escape" && app.explore.open) app.explore.hide();
			else if (e.key === "?") {
				this.open("settings");
				const k = document.querySelector("#settings .keys");
				if (k && !$("settings").hidden) k.open = true;
			} else if (e.code === "KeyC") {
				app.rig.auto = false;
				app.rig.next();
			} else if (e.code === "KeyM") this.setMode(app.rider.mode === "cruise" ? "ride" : "cruise");
			else if (e.code === "Escape") this.close();
			else if (e.code === "KeyH") document.body.classList.toggle("hide-hud");
			else if (e.code === "KeyP") app.paused = !app.paused;
			else if (/^Digit[1-7]$/.test(e.code)) {
				const c = this.route.chapters[+e.code.slice(5) - 1];
				if (c) app.jumpTo(c.s + 60);
			} else if (["ArrowUp", "KeyW"].includes(e.code) && app.rider.mode === "cruise" && !e.repeat) {
				// pressing throttle in Cruise hands you the bars
				this.setMode("ride");
			}
		};
		// settings
		const seg = (id, fn) => {
			const el = $(id);
			el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
				el.querySelectorAll("button").forEach((o) => o.classList.toggle("active", o === b));
				fn(b.dataset.v);
			}));
		};
		const time = $("time");
		const showTime = (h) => {
			const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
			const ap = hh >= 12 ? "pm" : "am";
			$("time-label").textContent = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${ap}`;
		};
		seg("time-mode", (v) => {
			app.hourOverride = v === "manual" ? parseFloat(time.value) : null;
		});
		time.addEventListener("input", () => {
			app.hourOverride = parseFloat(time.value);
			showTime(app.hourOverride);
			$("time-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === "manual"));
		});
		this.showTime = showTime;
		seg("weather", (v) => {
			app.gloom = v === "gloom" ? 1 : 0;
			store.set("weather", v);
		});
		const w = store.get("weather", "clear");
		if (app.params.get("gloom") === "1" || w === "gloom") {
			app.gloom = 1;
			$("weather").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === "gloom"));
		}
		seg("pace", (v) => {
			app.rider.pace = parseFloat(v);
		});
		seg("quality", (v) => {
			store.set("quality", v);
			const u = new URL(location.href);
			u.searchParams.delete("q");
			u.searchParams.set("s", (app.rider.s / 1000).toFixed(2));
			location.href = u.toString();
		});
		$("quality").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === app.quality.name));
		const sw = $("paint");
		for (const [k, p] of Object.entries(PAINTS)) {
			const b = document.createElement("button");
			b.style.background = `linear-gradient(135deg, ${p.main} 0 60%, ${p.trim} 60%)`;
			b.title = p.name;
			b.setAttribute("aria-label", p.name);
			b.classList.toggle("active", k === app.bike.paintKey);
			b.addEventListener("click", () => {
				app.bike.setPaint(k);
				store.set("paint", k);
				sw.querySelectorAll("button").forEach((o) => o.classList.toggle("active", o === b));
			});
			sw.appendChild(b);
		}
		$("again").addEventListener("click", () => {
			$("finale").hidden = true;
			app.jumpTo(0);
		});
		$("finale-chapters").addEventListener("click", () => {
			$("finale").hidden = true;
			this.open("chapters");
		});
		document.addEventListener("pointerdown", (e) => {
			const inSheet = e.target.closest && (e.target.closest(".sheet") || e.target.closest(".icons"));
			if (!inSheet) this.close();
		});
	}

	showCard(k) {
		const c = this.route.chapters[k];
		$("card-kicker").textContent = `Chapter ${k + 1} of ${this.route.chapters.length}`;
		$("card-title").textContent = c.name;
		$("card-line").textContent = CHAPTER_LINES[c.name] || "";
		$("card").classList.add("show");
		this.cardTimer = 6.5;
		this.app.lastCard = c.name;
		document.querySelectorAll("#chapter-list button").forEach((b, i) => b.classList.toggle("current", i === k));
	}

	toast(html) {
		const t = $("toast");
		t.innerHTML = html;
		t.classList.add("show");
		this.toastTimer = 5;
	}

	update(dt) {
		const app = this.app, rider = app.rider;
		const k = this.route.chapterAt(rider.s);
		if (k !== this.chapter) {
			this.chapter = k;
			this.showCard(k);
		}
		if (this.cardTimer > 0 && (this.cardTimer -= dt) <= 0) $("card").classList.remove("show");
		if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) $("toast").classList.remove("show");
		if (this.hintT > 0 && (this.hintT -= dt) <= 0) $("hint").classList.remove("show");
		// speedometer
		const mph = rider.mph;
		const m = Math.round(mph);
		if (m !== this._mph) {
			this._mph = m;
			$("mph").textContent = m;
			const f = clamp(mph / 100, 0, 1);
			$("needle").style.transform = `rotate(${-135 + f * 270}deg)`;
			$("gauge-fill").style.strokeDashoffset = 231 * (1 - f);
		}
		const gear = rider.v < 0.3 ? "N" : String(rider.gear);
		if (gear !== this._gear) $("gear").textContent = this._gear = gear;
		const rpm = Math.round(clamp(rider.rpm / 5200, 0, 1) * 20) * 5;
		if (rpm !== this._rpm) $("rpm").style.setProperty("--rpm", `${(this._rpm = rpm)}%`);
		const cam = app.rig.label();
		if (cam !== this._cam) $("cam-label").textContent = this._cam = cam;
		// location
		const c = this.route.chapters[k].name;
		const road = this.route.nameAt(rider.s);
		const where = `${c} · ${road}`;
		if (where !== this._where) {
			$("where").textContent = where;
			this._where = where;
		}
		// minimap at ~8 Hz
		this.mapT -= dt;
		if (this.mapT <= 0) {
			this.mapT = 0.12;
			this.drawMap();
		}
		// passing landmarks
		this.poiT -= dt;
		if (this.poiT <= 0) {
			this.poiT = 0.5;
			const p = app.bike.root.position;
			for (const poi of app.pois || []) {
				const d = Math.hypot(poi.x - p.x, poi.z - p.z);
				const last = this.poiSeen.get(poi.name) || -1e9;
				if (d < 420 && app.t - last > 120) {
					this.poiSeen.set(poi.name, app.t);
					this.toast(`Passing <b>${poi.name}</b>${poi.note ? " · " + poi.note : ""}`);
					app.lastPoi = poi.name;
				}
			}
		}
		if (rider.finished && !this.finaleShown) {
			this.finaleShown = true;
			$("finale-line").textContent = `${Math.round(this.route.length / 1609)} miles from the orange groves of Redlands to the Pacific at sunset.`;
			$("finale").hidden = false;
		}
		if (!rider.finished) this.finaleShown = false;
	}
}
