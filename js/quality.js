// Quality presets. Phones default to Low.
export const PRESETS = {
	low: { name: "low", far: 650, fine: 20, coarse: 50, ahead: 2600, shadows: false, shadowSize: 1024, pixelRatio: 1.25, density: 0.5, budget: 4 },
	medium: { name: "medium", far: 420, fine: 12, coarse: 32, ahead: 3600, shadows: true, shadowSize: 1024, pixelRatio: 1.5, density: 0.75, budget: 5 },
	high: { name: "high", far: 300, fine: 8, coarse: 25, ahead: 4500, shadows: true, shadowSize: 2048, pixelRatio: 2, density: 1, budget: 6 },
};

export function isPhone() {
	const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
	return coarse && Math.min(screen.width, screen.height) < 820;
}

export function defaultQuality() {
	return isPhone() ? "low" : "high";
}
