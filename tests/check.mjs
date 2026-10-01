// Headless browser check for Citrus to Surf.
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
