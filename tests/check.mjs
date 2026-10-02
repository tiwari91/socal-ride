// Headless browser check for Citrus to Surf.
// Needs network access for three.js, MapLibre and the map tiles.
// Usage: node tests/check.mjs            (writes screenshots to tests/shots/)
// Env:   CHROME_BIN=/path/to/chrome-headless-shell  SHOTS=0 to skip extra screenshots
import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire("/Users/shankartiwar/Cayuse/s2s-web-client/package.json");
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tests", "shots");
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_BIN || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".bin": "application/octet-stream", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer((req, res) => {
	let p = decodeURIComponent(req.url.split("?")[0]);
	if (p.endsWith("/")) p += "index.html";
	const f = path.join(ROOT, p);
	if (!f.startsWith(ROOT)) {
		res.writeHead(403);
		res.end();
		return;
	}
	fs.readFile(f, (e, d) => {
		if (e) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
		res.end(d);
	});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const ok = (name, pass, info = "") => {
	results.push({ name, pass, info });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${info ? "  (" + info + ")" : ""}`);
};

const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });

async function open(opts = {}, query = "") {
	const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }, opts));
	const page = await ctx.newPage();
	const errors = [];
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
	await page.goto(BASE + query);
	await page.waitForFunction(() => window.app && window.app.ready, null, { timeout: 120000 });
	return { ctx, page, errors };
}
const wait = (page, ms) => page.waitForTimeout(ms);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + ".png") });

try {
	// ---------- desktop ----------
	const { ctx, page, errors } = await open();
	await page.click("#start");
	await wait(page, 2500);
	const gl = await page.evaluate(() => ({ tris: app.renderer.info.render.triangles, calls: app.renderer.info.render.calls, frames: app.frames, webgl2: app.renderer.capabilities.isWebGL2 }));
	ok("WebGL renders", gl.tris > 50000 && gl.frames > 20, `${gl.tris} triangles, ${gl.calls} calls, webgl2=${gl.webgl2}`);
	const px = await page.screenshot();
	ok("Frame is not blank", px.length > 60000, `${px.length} bytes png`);
	await shot(page, "01-redlands");

	const s0 = await page.evaluate(() => app.rider.s);
	await wait(page, 3000);
	const s1 = await page.evaluate(() => app.rider.s);
	ok("Cruise advances along the route", s1 - s0 > 15, `${(s1 - s0).toFixed(1)} m in 3 s`);
	const card1 = await page.evaluate(() => ({ last: app.lastCard, shown: document.getElementById("card").classList.contains("show") || app.lastCard === "Redlands" }));
	ok("Chapter card on start", card1.last === "Redlands", card1.last);

	// chapter menu jump
	await page.click("#btn-chapters");
	await page.click("#chapter-list li:nth-child(2) button");
	await page.waitForFunction(() => !app.paused && app.lastCard === "Riverside", null, { timeout: 30000 });
	const c2 = await page.evaluate(() => ({ last: app.lastCard, show: document.getElementById("card").classList.contains("show"), s: app.rider.s }));
	ok("Chapter menu jumps and card triggers", c2.last === "Riverside" && c2.show, `${c2.last} at ${(c2.s / 1000).toFixed(1)} km`);
	await wait(page, 2500);
	await shot(page, "02-riverside");

	// road surface check while cruising
	const onRoad = await page.evaluate(async () => {
		let worst = 0, outside = 0;
		for (let k = 0; k < 30; k++) {
			await new Promise((r) => setTimeout(r, 50));
			const r = app.route, rd = app.rider;
			const P = r.at(rd.s);
			const y = app.bike.root.position.y;
			worst = Math.max(worst, Math.abs(y - P.y));
			const [lo, hi] = rd.limits(P.i);
			if (rd.d < lo - 0.01 || rd.d > hi + 0.01) outside++;
			const g = app.ground.height(app.bike.root.position.x, app.bike.root.position.z);
			if (g > y + 0.05) outside++;
		}
		return { worst, outside };
	});
	ok("Bike stays on the road surface", onRoad.worst < 0.05 && onRoad.outside === 0, `max height error ${onRoad.worst.toFixed(3)} m, violations ${onRoad.outside}`);

	// ride mode controls
	await page.click("#mode-ride");
	const r0 = await page.evaluate(() => ({ mode: app.rider.mode, v: app.rider.v, s: app.rider.s, d: app.rider.d }));
	await page.keyboard.down("ArrowUp");
	await wait(page, 2500);
	const r1 = await page.evaluate(() => ({ v: app.rider.v, s: app.rider.s, d: app.rider.d }));
	await page.keyboard.down("ArrowLeft");
	await wait(page, 1200);
	await page.keyboard.up("ArrowLeft");
	const r2 = await page.evaluate(() => ({ v: app.rider.v, s: app.rider.s, d: app.rider.d, lean: app.rider.lean }));
	await page.keyboard.up("ArrowUp");
	await page.keyboard.down("ArrowDown");
	await wait(page, 1500);
	await page.keyboard.up("ArrowDown");
	const r3 = await page.evaluate(() => ({ v: app.rider.v }));
	ok("Ride: throttle accelerates and moves the bike", r0.mode === "ride" && r1.s - r0.s > 10 && r1.v > r0.v - 0.5, `v ${r0.v.toFixed(1)} -> ${r1.v.toFixed(1)} m/s, moved ${(r1.s - r0.s).toFixed(0)} m`);
	ok("Ride: steering changes lane position", Math.abs(r2.d - r1.d) > 0.4, `d ${r1.d.toFixed(2)} -> ${r2.d.toFixed(2)}`);
	ok("Ride: brake slows down", r3.v < r2.v - 2, `v ${r2.v.toFixed(1)} -> ${r3.v.toFixed(1)}`);
	const lim = await page.evaluate(async () => {
		// hold right for a long time: the bike must stop at the road edge
		const inp = app.input;
		inp.touch.steer = 1;
		inp.touch.throttle = 1;
		await new Promise((r) => setTimeout(r, 2500));
		inp.touch.steer = 0;
		inp.touch.throttle = 0;
		const rd = app.rider, P = app.route.at(rd.s);
		const [lo, hi] = rd.limits(P.i);
		return { d: rd.d, lo, hi };
	});
	ok("Ride: the road edge holds the bike", lim.d <= lim.hi + 0.01 && lim.d >= lim.lo - 0.01, `d ${lim.d.toFixed(2)} within [${lim.lo.toFixed(2)}, ${lim.hi.toFixed(2)}]`);
	await page.click("#mode-cruise");

	// audio
	const a0 = await page.evaluate(() => ({ ctx: !!app.audio.ctx }));
	await page.click("#btn-sound");
	await wait(page, 800);
	const a1 = await page.evaluate(() => ({ ctx: !!app.audio.ctx, state: app.audio.ctx && app.audio.ctx.state, built: app.audio.built, gain: app.audio.master && app.audio.master.gain.value, muted: app.audio.muted }));
	await page.click("#btn-sound");
	await wait(page, 1200);
	const a2 = await page.evaluate(() => ({ gain: app.audio.master.gain.value, muted: app.audio.muted, stored: localStorage.getItem("c2s.sound") }));
	ok("Audio is silent until a click", a0.ctx === false, "no AudioContext before the gesture");
	ok("Audio graph builds after a click", a1.ctx && a1.built && a1.state === "running" && !a1.muted, `state ${a1.state}, gain ${a1.gain && a1.gain.toFixed(2)}`);
	ok("Audio mutes and remembers", a2.muted && a2.gain < 0.05 && a2.stored === "false", `gain ${a2.gain.toFixed(3)}, stored ${a2.stored}`);

	// theme toggle
	const th = await page.evaluate(() => {
		document.getElementById("btn-theme").click();
		const a = document.documentElement.dataset.theme;
		document.getElementById("btn-theme").click();
		return [a, document.documentElement.dataset.theme];
	});
	ok("Theme toggles", th[0] !== th[1], th.join(" -> "));

	// rider: left boot goes down when the bike stops
	const foot = await page.evaluate(async () => {
		app.setMode("ride");
		app.rider.v = 0;
		await new Promise((r) => setTimeout(r, 1600));
		const f = app.bike.pose.foot, y = app.bike.legs[1].boot.position.y;
		app.setMode("cruise");
		return { f, y };
	});
	ok("Rider puts a foot down at a stop", foot.f > 0.8 && foot.y < 0.2, `foot ${foot.f.toFixed(2)}, boot y ${foot.y.toFixed(2)} m`);

	// places snapshot and floating labels
	await page.waitForFunction(() => app.places && app.places.ready, null, { timeout: 30000 });
	const pl = await page.evaluate(() => ({ n: app.places.list.length, c: app.places.counts(), labels: app.places.pool.filter((L) => L.place).length }));
	ok("Places snapshot loads (OSM cafes, food, viewpoints...)", pl.n > 500 && pl.c.cafe > 20 && pl.c.view > 5, `${pl.n} places, ${pl.c.cafe} cafes, ${pl.c.view} viewpoints, ${pl.labels} 3D labels`);

	// explore map (MapLibre, 3D terrain): open with G, places, search, popup,
	// category toggle, styles, 2D/3D, chapter fly-to, fly-along, ride here, Esc
	const mapIdle = (pg, extra = 800) => pg.evaluate(async (extra) => {
		const m = app.explore.map, t0 = performance.now();
		await new Promise((r) => setTimeout(r, 300));
		while (performance.now() - t0 < 30000 && (m.isMoving() || !m.areTilesLoaded())) await new Promise((r) => setTimeout(r, 150));
		await new Promise((r) => setTimeout(r, extra));
	}, extra);
	await page.keyboard.press("KeyG");
	await page.waitForFunction(() => app.explore.ready && app.explore.map.queryRenderedFeatures({ layers: ["pl-pin", "pl-cluster"] }).length > 5, null, { timeout: 60000 });
	await mapIdle(page);
	const ex0 = await page.evaluate(() => {
		const m = app.explore.map;
		return {
			open: app.explore.open, pins: m.queryRenderedFeatures({ layers: ["pl-pin", "pl-cluster"] }).length, rider: !!document.querySelector(".ex-rider.maplibregl-marker"),
			chapters: document.querySelectorAll(".ex-chapter.maplibregl-marker").length, terrain: !!m.getTerrain(), pitch: m.getPitch(), sky: !!m.getSky(),
			route: app.explore.routeData.ahead.geometry.coordinates.length + app.explore.routeData.done.geometry.coordinates.length,
			tiles: performance.getEntriesByType("resource").filter((e) => e.name.includes("tiles.maps.eox.at")).length,
			dem: performance.getEntriesByType("resource").filter((e) => e.name.includes("elevation-tiles-prod")).length, attr: document.querySelector(".maplibregl-ctrl-attrib").textContent,
		};
	});
	ok("Explore map opens in 3D with terrain, imagery, route, rider and places", ex0.open && ex0.pins > 5 && ex0.rider && ex0.chapters === 7 && ex0.terrain && ex0.pitch > 30 && ex0.sky && ex0.route > 1000 && ex0.tiles > 0 && ex0.dem > 0, `${ex0.pins} markers, ${ex0.tiles} imagery and ${ex0.dem} elevation tiles, pitch ${ex0.pitch.toFixed(0)}`);
	ok("Map credits OpenStreetMap, EOX Sentinel-2 and the terrain tiles", /OpenStreetMap/.test(ex0.attr) && /Sentinel-2 cloudless/.test(ex0.attr) && /EOX/.test(ex0.attr) && /Terrain Tiles/.test(ex0.attr));
	await shot(page, "13a-explore-follow");
	const dBefore = await page.evaluate(() => app.rider.d);
	const cBefore = await page.evaluate(() => app.explore.map.getCenter().toArray());
	await page.locator("#ex-map canvas").focus();
	await page.keyboard.down("ArrowLeft");
	await wait(page, 700);
	await page.keyboard.up("ArrowLeft");
	await wait(page, 400);
	const dAfter = await page.evaluate(() => app.rider.d);
	const cAfter = await page.evaluate(() => app.explore.map.getCenter().toArray());
	ok("Arrow keys pan the map instead of steering", Math.abs(dAfter - dBefore) < 0.3 && cAfter[0] < cBefore[0] - 1e-4, `d ${dBefore.toFixed(2)} -> ${dAfter.toFixed(2)}, lng ${cBefore[0].toFixed(4)} -> ${cAfter[0].toFixed(4)}`);
	await page.fill("#ex-search", "beach");
	await wait(page, 500);
	const found = await page.evaluate(() => document.querySelectorAll("#ex-list li").length);
	await page.click("#ex-list li button");
	await page.waitForSelector(".maplibregl-popup .pp-go", { timeout: 15000 });
	const pop = await page.evaluate(() => document.querySelector(".maplibregl-popup .pp-name").textContent);
	ok("Search lists matches and opens a popup", found > 0 && pop.length > 0, `${found} matches, popup "${pop}"`);
	await mapIdle(page);
	await shot(page, "13-explore-map");
	await page.fill("#ex-search", "");
	await page.click(".ex-cats .cat >> nth=0");
	const off = await page.evaluate(() => !app.places.enabled.has("cafe") && !app.explore.placeData.features.some((f) => f.properties.c === "cafe"));
	await page.click(".ex-cats .cat >> nth=0");
	const on = await page.evaluate(() => app.places.enabled.has("cafe") && app.explore.placeData.features.some((f) => f.properties.c === "cafe"));
	ok("Category toggles switch on and off", off && on, "cafes");
	// map styles: satellite, streets and hybrid (satellite with roads and labels)
	const styles = {};
	for (const v of ["satellite", "streets", "hybrid"]) {
		await page.click(`#ex-style [data-v="${v}"]`);
		styles[v] = await page.evaluate(() => {
			const m = app.explore.map, vis = (id) => m.getLayoutProperty(id, "visibility") !== "none";
			return { sat: vis("sat"), road: vis("road_motorway"), label: vis("label_city"), bld: vis("building-3d") };
		});
	}
	ok("Style switcher: Satellite, Streets and Hybrid", styles.satellite.sat && !styles.satellite.road && !styles.streets.sat && styles.streets.road && styles.hybrid.sat && styles.hybrid.road && styles.hybrid.label && styles.hybrid.bld, JSON.stringify(styles.hybrid));
	// per-chapter fly-to: Santa Ana Canyon, tilted and turned down the canyon
	await page.click("#ex-chaps .chap >> nth=2");
	await mapIdle(page, 1500);
	const cam = await page.evaluate(() => { const m = app.explore.map; return { pitch: m.getPitch(), bearing: m.getBearing(), z: m.getZoom() }; });
	ok("Chapter fly-to tilts and turns the 3D camera", cam.pitch > 60 && Math.abs(cam.bearing) > 90, `pitch ${cam.pitch.toFixed(0)}, bearing ${cam.bearing.toFixed(0)}, zoom ${cam.z.toFixed(1)}`);
	await shot(page, "15-explore-3d-canyon");
	await page.click("#ex-chaps .chap >> nth=6");
	await mapIdle(page, 1500);
	await shot(page, "16-explore-3d-coast");
	// 3D/2D toggle
	await page.click("#ex-3d");
	await page.waitForFunction(() => !app.explore.map.isMoving(), null, { timeout: 10000 });
	await wait(page, 900);
	const flat = await page.evaluate(() => ({ terrain: !!app.explore.map.getTerrain(), pitch: app.explore.map.getPitch(), label: document.getElementById("ex-3d").textContent }));
	await page.click("#ex-3d");
	await wait(page, 1200);
	const round = await page.evaluate(() => ({ terrain: !!app.explore.map.getTerrain(), pitch: app.explore.map.getPitch() }));
	ok("3D/2D toggle flattens and restores the terrain", !flat.terrain && flat.pitch < 1 && flat.label === "2D" && round.terrain && round.pitch > 30, `2D pitch ${flat.pitch.toFixed(0)}, 3D pitch ${round.pitch.toFixed(0)}`);
	// fly along the route
	await page.click("#ex-fly");
	await page.waitForFunction(() => app.explore.flying && app.explore.flying.s > 2000, null, { timeout: 20000 });
	const f0 = await page.evaluate(() => ({ s: app.explore.flying.s, c: app.explore.map.getCenter().toArray() }));
	await wait(page, 2500);
	const f1 = await page.evaluate(() => ({ s: app.explore.flying && app.explore.flying.s, c: app.explore.map.getCenter().toArray(), pitch: app.explore.map.getPitch(), status: document.getElementById("ex-status").textContent }));
	await shot(page, "17-explore-fly-along");
	await page.click("#ex-fly");
	const stopped = await page.evaluate(() => !app.explore.flying);
	ok("Fly the route moves a tilted camera along the ride", f1.s > f0.s + 1500 && Math.hypot(f1.c[0] - f0.c[0], f1.c[1] - f0.c[1]) > 0.005 && f1.pitch > 55 && /Flying the route/.test(f1.status) && stopped, `${((f1.s - f0.s) / 1000).toFixed(1)} km in 2.5 s, ${f1.status}`);
	// dark mode recolours the street map and the sky
	const light = await page.evaluate(() => { app.explore.setStyle("streets"); return JSON.stringify(app.explore.map.getPaintProperty("background", "background-color")); });
	await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
	await wait(page, 300);
	const dark = await page.evaluate(() => ({ bg: JSON.stringify(app.explore.map.getPaintProperty("background", "background-color")), sky: app.explore.map.getSky()["sky-color"] }));
	await page.evaluate(() => { app.explore.setStyle("hybrid"); app.explore.flyChapter(4); });
	await mapIdle(page, 1500);
	await shot(page, "18-explore-dark");
	await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
	ok("Dark mode recolours the map and sky", light !== dark.bg && dark.sky === "#0c1a2e", `${light} -> ${dark.bg}`);
	await page.fill("#ex-search", "Crystal Cove");
	await wait(page, 400);
	await page.click("#ex-list li button");
	await page.waitForSelector(".maplibregl-popup .pp-go", { timeout: 15000 });
	await wait(page, 400);
	const target = await page.evaluate(() => parseFloat(document.querySelector(".maplibregl-popup .pp-go").dataset.s));
	await page.click(".maplibregl-popup .pp-go");
	await page.waitForFunction(() => !app.explore.open && !app.paused, null, { timeout: 60000 });
	const sNow = await page.evaluate(() => app.rider.s);
	ok("Ride here jumps the bike to the place", Math.abs(sNow - target) < 400, `target ${(target / 1000).toFixed(1)} km, now ${(sNow / 1000).toFixed(1)} km`);
	await page.keyboard.press("KeyG");
	await wait(page, 600);
	await page.keyboard.press("Escape");
	await wait(page, 300);
	ok("Escape closes the map", await page.evaluate(() => !app.explore.open && !document.body.classList.contains("exploring")));

	// screenshots of each chapter and the sunset coast
	if (process.env.SHOTS !== "0") {
		const chapters = await page.evaluate(() => app.route.chapters.map((c) => c.s));
		const names = ["01b-redlands-state-st", "02b-riverside", "03-santa-ana-canyon", "04-fullerton", "05-irvine", "06-newport", "07-laguna"];
		const offs = [1900, 900, 3000, 1100, 3600, 3200, 2200];
		const views = ["chase", "side", "drone", "chase", "side", "side", "chase"];
		for (let k = 0; k < chapters.length; k++) {
			await page.evaluate(async ([s, v]) => {
				await app.jumpTo(s);
				app.rig.auto = false;
				app.rig.set(v);
			}, [chapters[k] + offs[k], views[k]]);
			await wait(page, 3800);
			await shot(page, names[k]);
		}
		await page.evaluate(async () => {
			await app.jumpTo(app.route.length - 900);
			app.rig.set("side");
		});
		await wait(page, 4000);
		await shot(page, "08-sunset-coast");
		await page.evaluate(async () => {
			app.hourOverride = 17.7;
			app.rig.set("chase");
		});
		await wait(page, 2500);
		await shot(page, "09-dusk-lights");
		await page.evaluate(async () => {
			app.hourOverride = null;
			app.gloom = 1;
			await app.jumpTo(app.route.chapters[5].s + 2500);
		});
		await wait(page, 5000);
		await shot(page, "10-june-gloom");
	}
	ok("No console errors (desktop)", errors.length === 0, errors.slice(0, 3).join(" | "));
	await ctx.close();

	// ---------- phones ----------
	for (const [name, vp] of [["iphone12-portrait", { width: 390, height: 844 }], ["iphone12-landscape", { width: 844, height: 390 }], ["iphone11-portrait", { width: 414, height: 896 }]]) {
		const P = await open({ viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
		await P.page.tap("#start");
		await wait(P.page, 2500);
		const lay = await P.page.evaluate(() => ({
			sw: document.documentElement.scrollWidth, iw: innerWidth, bw: document.body.scrollWidth,
			q: app.quality.name, pr: app.renderer.getPixelRatio(),
		}));
		ok(`Phone ${name}: no horizontal scroll`, lay.sw <= lay.iw && lay.bw <= lay.iw, `${lay.sw}/${lay.iw}`);
		if (name === "iphone12-portrait") ok("Phone defaults to Low quality, pixel ratio capped", lay.q === "low" && lay.pr <= 2, `${lay.q}, pr ${lay.pr}`);
		await shot(P.page, `11-${name}`);
		await P.page.tap("#mode-ride");
		await wait(P.page, 400);
		const vis = await P.page.evaluate(() => getComputedStyle(document.getElementById("touch")).display);
		const t0 = await P.page.evaluate(() => app.rider.s);
		const box = await P.page.locator("#t-gas").boundingBox();
		await P.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await P.page.evaluate(() => {
			const el = document.getElementById("t-gas");
			el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		});
		await wait(P.page, 1500);
		await P.page.evaluate(() => document.getElementById("t-gas").dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
		const t1 = await P.page.evaluate(() => app.rider.s);
		ok(`Phone ${name}: touch controls visible and drive`, vis === "flex" && t1 > t0 + 5, `display ${vis}, moved ${(t1 - t0).toFixed(0)} m`);
		await shot(P.page, `12-${name}-ride`);
		// tap the minimap to explore
		await P.page.tap("#map-wrap");
		await P.page.waitForFunction(() => app.explore.ready && app.explore.map.queryRenderedFeatures({ layers: ["pl-pin", "pl-cluster"] }).length > 0, null, { timeout: 60000 });
		await mapIdle(P.page);
		const ex = await P.page.evaluate(() => {
			const bar = document.getElementById("ex-bar").getBoundingClientRect();
			return { open: app.explore.open, sw: document.documentElement.scrollWidth, iw: innerWidth, sheet: document.getElementById("ex-side").getBoundingClientRect().height, terrain: !!app.explore.map.getTerrain(), bar: bar.right <= innerWidth + 1 };
		});
		ok(`Phone ${name}: minimap opens the 3D explore map`, ex.open && ex.sw <= ex.iw && ex.sheet > 100 && ex.terrain && ex.bar, `sheet ${Math.round(ex.sheet)} px, ${ex.sw}/${ex.iw}`);
		await shot(P.page, `14-${name}-explore`);
		await P.page.tap("#ex-close");
		ok(`No console errors (${name})`, P.errors.length === 0, P.errors.slice(0, 3).join(" | "));
		await P.ctx.close();
	}
} catch (e) {
	ok("Test run completed", false, e.message);
} finally {
	await browser.close();
	server.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
