// Hand-built landmark accents placed at their OSM coordinates, and the list
// of named places that trigger a "passing" note on the HUD.
import { merge, paint } from "./util.js";
import { toXZ } from "./world.js";

const FLAVOR = {
	"A. K. Smiley Public Library": "Moorish-revival library, 1898",
	"Redlands Bowl": "Free summer concerts under the trees since 1924",
	"Mission Inn": "Mission-revival landmark hotel, Riverside",
	"Riverside City Hall": "Downtown Riverside",
	"Mount Rubidoux": "Sunrise services on the summit since 1909",
	"Cal State Fullerton": "Home of the Titans",
	"University of California, Irvine": "Anteaters, eucalyptus and Aldrich Park",
	"Fashion Island": "Newport Center",
	"Crystal Cove State Park": "Tide pools and historic beach cottages",
	"Heisler Park": "Bluff-top gardens over the coves",
	"Main Beach Park": "Laguna's boardwalk and lifeguard tower",
	"Balboa Pier": "Newport's Peninsula",
	"Newport Pier": "Dory fleet market since 1891",
};

function tower(h, w, color, roofColor) {
	const parts = [];
	parts.push(paint(new THREE.BoxGeometry(w, h, w).translate(0, h / 2, 0), color));
	// open belfry arches suggested by darker insets
	for (let k = 0; k < 4; k++) {
		const a = new THREE.BoxGeometry(w * 0.45, w * 0.7, 0.1);
		a.translate(0, h - w * 0.75, w / 2 + 0.03);
		a.rotateY((k * Math.PI) / 2);
		parts.push(paint(a, "#3a2e26"));
	}
	parts.push(paint(new THREE.BoxGeometry(w * 1.15, 0.4, w * 1.15).translate(0, h, 0), color));
	parts.push(paint(new THREE.ConeGeometry(w * 0.8, w * 0.9, 4).rotateY(Math.PI / 4).translate(0, h + 0.65, 0), roofColor));
	return merge(parts);
}

export function buildLandmarks(ground, pois) {
	const group = new THREE.Group();
	const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
	const at = (lat, lon, dx = 0, dz = 0) => {
		const [x, z] = toXZ(lat, lon);
		return [x + dx, ground.height(x + dx, z + dz), z + dz];
	};
	const add = (geo, p, rot = 0) => {
		const m = new THREE.Mesh(geo, mat);
		m.position.set(p[0], p[1], p[2]);
		m.rotation.y = rot;
		m.castShadow = true;
		group.add(m);
	};
	// Mission Inn: campanile and rotunda dome
	add(tower(24, 4.2, "#e8d7b8", "#a9573a"), at(33.9834, -117.3731, 12, -6));
	const dome = merge([
		paint(new THREE.CylinderGeometry(4.2, 4.2, 5, 16).translate(0, 12, 0), "#e8d7b8"),
		paint(new THREE.SphereGeometry(4.3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 14.5, 0), "#b8693f"),
		paint(new THREE.CylinderGeometry(0.4, 0.6, 2, 8).translate(0, 19.4, 0), "#e8d7b8"),
	]);
	add(dome, at(33.9829, -117.3724, -10, 8));
	// A. K. Smiley Public Library tower
	add(tower(15, 3.2, "#efe2c8", "#a9573a"), at(34.0542, -117.184, 6, 4));
	// Mount Rubidoux summit cross
	const cross = merge([paint(new THREE.BoxGeometry(0.8, 12, 0.8).translate(0, 6, 0), "#f2efe8"), paint(new THREE.BoxGeometry(5, 0.8, 0.8).translate(0, 9, 0), "#f2efe8")]);
	add(cross, at(33.9839, -117.3931));
	// Laguna Main Beach lifeguard tower
	const lg = merge([
		paint(new THREE.CylinderGeometry(2.0, 2.2, 3.0, 6).translate(0, 4.2, 0), "#f4f1e8"),
		paint(new THREE.ConeGeometry(2.6, 1.6, 6).translate(0, 6.5, 0), "#3e6f8c"),
		paint(new THREE.CylinderGeometry(0.25, 0.25, 3, 6).translate(1.2, 1.5, 0), "#d8d2c4"),
		paint(new THREE.CylinderGeometry(0.25, 0.25, 3, 6).translate(-1.2, 1.5, 0), "#d8d2c4"),
		paint(new THREE.BoxGeometry(1.6, 1.1, 0.1).translate(0, 4.5, 2.0), "#2e3b44"),
	]);
	add(lg, at(33.5418, -117.7852));
	group.traverse((o) => (o.matrixAutoUpdate = true));
	const list = (pois || []).map((p) => ({ name: p.name, x: p.x, z: p.z, note: FLAVOR[p.name] || "" }));
	return { group, pois: list };
}
