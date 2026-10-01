// Citrus to Surf: entry point. Loads data, builds the world and runs the loop.
import "./setup.js";
import { clamp, fogUniforms, installFogChunks, lerp, nextFrame, noise2, smoothstep, store } from "./util.js";
import { initWorld } from "./world.js";
import { Route } from "./route.js";
import { Ground } from "./ground.js";
import { buildFarTerrain } from "./terrain.js";
import { Roads } from "./road.js";
import { Sky } from "./sky.js";
import { Ocean } from "./water.js";
import { Scenery } from "./scenery.js";
import { Bike } from "./bike.js";
import { Input, Rider } from "./ride.js";
import { CameraRig } from "./camera.js";
import { PRESETS, defaultQuality } from "./quality.js";
import { Buildings } from "./buildings.js";
import { buildSigns } from "./signs.js";
import { buildLandmarks } from "./landmarks.js";
import { Traffic } from "./traffic.js";
import { Audio } from "./audio.js";
import { UI } from "./ui.js";
import { coastDistance } from "./world.js";

const savedTheme = store.get("theme", null);
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

const params = new URLSearchParams(location.search);
const app = { t: 0, frames: 0, params };
window.app = app;

// Time of day follows the ride: morning in Redlands, sunset at Laguna.
export function hourAt(route, s) {
	const c = route.chapters;
	const keys = [[0, 8.0], [c[1].s, 9.4], [c[2].s, 11.4], [c[3].s, 13.3], [c[4].s, 15.2], [c[5].s, 16.15], [c[6].s, 16.62], [route.length, 17.02]];
	for (let k = 0; k < keys.length - 1; k++) {
		if (s <= keys[k + 1][0]) return lerp(keys[k][1], keys[k + 1][1], (s - keys[k][0]) / (keys[k + 1][0] - keys[k][0]));
	}
	return 17.02;
}

async function load(progress) {
	const get = (u, t) => fetch(u).then((r) => {
		if (!r.ok) throw new Error(u + " " + r.status);
		return t === "bin" ? r.arrayBuffer() : r.json();
	});
	progress(0.03, "Fetching map data");
	const [route, tmeta, tbin, scenery] = await Promise.all([
		get("data/route.json"), get("data/terrain.json"), get("data/terrain.bin", "bin"), get("data/scenery.json"),
	]);
	return { route, tmeta, tbin, scenery };
}

async function start() {
	const bar = document.getElementById("load-bar");
	const msg = document.getElementById("load-msg");
	const progress = (f, m) => {
		if (bar) bar.style.transform = `scaleX(${f})`;
		if (m && msg) msg.textContent = m;
		app.loadProgress = f;
	};
	installFogChunks();
	const qName = params.get("q") || store.get("quality", defaultQuality());
	const Q = PRESETS[qName] || PRESETS.high;
	app.quality = Q;
	const data = await load(progress);
	initWorld(data.route, data.tmeta, data.tbin);
	await nextFrame();
	progress(0.1, "Shaping the road");
	const route = new Route(data.route);
	route.computeHeights();
	route.computeLayout();
	app.route = route;
	await nextFrame();

	const canvas = document.getElementById("scene");
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pixelRatio, 2));
	renderer.outputEncoding = THREE.sRGBEncoding;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.95;
	renderer.shadowMap.enabled = Q.shadows;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	app.renderer = renderer;
	const scene = new THREE.Scene();
	app.scene = scene;
	const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200000);
	app.camera = camera;
	const sky = new Sky(scene, renderer, Q);
	app.sky = sky;

	progress(0.18, "Raising the mountains");
	await nextFrame();
	const ground = new Ground(route, data.scenery, Q);
	app.ground = ground;
	scene.add(ground.group);
	const far = buildFarTerrain(ground, Q);
	scene.add(far.mesh);
	progress(0.42, "Laying the asphalt");
	await nextFrame();
	const roads = new Roads(route, ground, Q);
	scene.add(roads.group);
	app.roads = roads;
	const ocean = new Ocean(scene, sky, data.route.coast);
	app.ocean = ocean;
	const scenery = new Scenery(route, ground, roads, data.scenery, Q);
	scene.add(scenery.group);
	app.scenery = scenery;
	const buildings = new Buildings(route, ground, data.scenery.buildings || [], Q);
	scene.add(buildings.group);
	app.buildings = buildings;
	try {
		await document.fonts.load("700 40px Overpass");
	} catch (e) {
		/* fonts optional */
	}
	scene.add(buildSigns(route));
	const marks = buildLandmarks(ground, data.scenery.pois);
	scene.add(marks.group);
	app.pois = marks.pois;
	app.coast = data.route.coast;
	const traffic = new Traffic(route, Q, Q.name === "low" ? 10 : 18);
	scene.add(traffic.group);
	app.traffic = traffic;
	const audio = new Audio();
	app.audio = audio;

	// rider and machine
	const bike = new Bike(null, store.get("paint", "burgundy"));
	scene.add(bike.root);
	app.bike = bike;
	const head = new THREE.SpotLight(0xfff1d6, 0, 90, 0.42, 0.55, 1.2);
	head.position.copy(bike.headPos);
	head.target.position.set(0, -0.6, 14);
	bike.steer.children[0].add(head, head.target);
	app.headlight = head;
	const rider = new Rider(route);
	app.rider = rider;
	const input = new Input();
	app.input = input;
	const rig = new CameraRig(camera, ground);
	app.rig = rig;

	const startS = parseFloat(params.get("s") || "0") * 1000;
	rider.jump(startS);
	rider.v = startS > 0 ? 15 : 0;

	progress(0.5, "Planting the groves");
	await warm(rider.s, progress);
	progress(1, "Ready");

	const resize = () => {
		const w = window.innerWidth, h = window.innerHeight;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	};
	window.addEventListener("resize", resize);
	resize();
	document.body.classList.add("ready");

	async function warm(s, prog) {
		roads.ensure(s);
		let guard = 0;
		while ((ground.update(s, 30) > 0 || scenery.update(s) > 0 || buildings.update(s) > 0) && guard++ < 600) {
			if (prog) prog(0.5 + 0.48 * (1 - ground.pendingCount() / Math.max(1, ground.tiles.size)), "Planting the groves");
			await nextFrame();
		}
	}
	app.warm = warm;

	const clock = new THREE.Clock();
	const P = {};
	const B = { p: new THREE.Vector3(), f: new THREE.Vector3(), r: new THREE.Vector3(), v: 0, lean: 0 };
	app.hourOverride = params.get("h") ? parseFloat(params.get("h")) : null;
	app.gloom = params.get("gloom") === "1" ? 1 : 0;
	app.paused = false;
	let envTimer = 0;
	app.ready = true;

	app.setMode = (m) => {
		rider.mode = m;
		if (m === "ride") {
			rig.auto = false;
			if (rig.view === "drone" || rig.view === "low") rig.set("chase");
		} else rig.auto = true;
	};
	app.jumpTo = async (s) => {
		app.paused = true;
		document.body.classList.add("jumping");
		rider.jump(s);
		rider.v = s > 10 ? 14 : 0;
		traffic.reset();
		await warm(rider.s);
		rig.snap();
		app.paused = false;
		document.body.classList.remove("jumping");
	};
	const ui = new UI(app);
	app.ui = ui;
	if (params.get("mode") === "ride") ui.setMode("ride");
	const startBtn = document.getElementById("start");
	startBtn.disabled = false;
	const begin = () => {
		document.body.classList.add("started");
		app.started = true;
		if (store.get("sound", false)) ui.setSnd(true);
		if (store.get("music", false)) document.getElementById("btn-music").click();
	};
	startBtn.addEventListener("click", begin);
	if (params.get("autostart") === "1") begin();
	window.addEventListener("pointerdown", () => {
		if (audio.ctx && audio.ctx.state === "suspended" && !audio.muted) audio.ctx.resume();
	});

	function frame() {
		requestAnimationFrame(frame);
		const dt = Math.min(clock.getDelta(), 0.08);
		app.t += dt;
		if (!app.paused && app.started) {
			rider.input = input.poll(dt);
			rider.lead = app.lead || null;
			rider.update(dt);
			if (rider.shift) {
				audio.shift(rider.shift > 0);
				rider.shift = 0;
			}
		}
		route.at(rider.s, P);
		const f = B.f.set(P.tx, 0, P.tz);
		const rr = B.r.set(P.rx, 0, P.rz);
		const c = Math.cos(rider.psi), sn = Math.sin(rider.psi);
		const fx = f.x * c + rr.x * sn, fz = f.z * c + rr.z * sn;
		B.p.set(P.x + P.rx * rider.d, P.y, P.z + P.rz * rider.d);
		f.set(fx, 0, fz);
		rr.set(-fz, 0, fx);
		B.v = rider.v;
		B.lean = rider.lean;
		B.prefSide = route.zoneAt(rider.s) === "laguna" || route.zoneAt(rider.s) === "coast" ? 1 : 0;
		bike.root.position.copy(B.p);
		bike.root.rotation.set(-Math.atan(P.grade), Math.atan2(fx, fz), 0, "YXZ");
		const bump = 0.006 * noise2(rider.s * 0.45, 3) * clamp(rider.v / 10, 0, 1);
		bike.update(dt, rider.v, rider.lean, rider.steerVis, bump, rider.rpm);
		rig.update(dt, B, rider.mode === "cruise");

		const hour = app.hourOverride !== null ? app.hourOverride : hourAt(route, rider.s);
		const zone = route.zoneAt(rider.s);
		const coastal = zone === "coast" || zone === "laguna" ? 1 : zone === "irvine" ? 0.55 : 0.15;
		app.gloomAmt = lerp(app.gloomAmt || 0, app.gloom * coastal, 1 - Math.exp(-dt * 0.5));
		sky.set(hour, app.gloomAmt, B.p, dt);
		sky.dome.position.copy(camera.position);
		camera.updateMatrixWorld();
		sky.updateFogView(camera);
		envTimer -= dt;
		if (envTimer <= 0) {
			envTimer = 1.5;
			const env = sky.maybeEnv(!scene.environment);
			if (env) scene.environment = env;
		}
		const night = sky.state.night;
		head.intensity = smoothstep(0.15, 0.6, night) * 3.2;
		bike.setLights(night > 0.3);
		scenery.setNight(night);
		buildings.setNight(night);
		ocean.update(dt, sky);
		app.lead = traffic.update(dt, { s: rider.s, d: rider.d, v: rider.v });
		traffic.night = night;
		const cd = coastDistance(B.p.x, B.p.z, 2500);
		audio.update(dt, {
			rpm: rider.rpm, v: rider.v, throttle: rider.throttle,
			coast: cd < 1e5 ? smoothstep(1400, 150, Math.abs(cd)) : 0,
			slabs: P.kind === 0,
			birds: (zone === "redlands" || zone === "riverside" || zone === "irvine" || zone === "ie-freeway") && hour < 15 ? 1 : 0,
		});
		ui.update(dt);
		fogUniforms.uTime.value = app.t;
		roads.update(rider.s);
		ground.update(rider.s, Q.budget);
		scenery.update(rider.s);
		buildings.update(rider.s);
		renderer.render(scene, camera);
		app.frames++;
		app.zone = zone;
		app.hour = hour;
	}
	requestAnimationFrame(frame);
}

start().catch((e) => {
	console.error(e);
	const msg = document.getElementById("load-msg");
	if (msg) msg.textContent = "Could not start: " + e.message;
});
