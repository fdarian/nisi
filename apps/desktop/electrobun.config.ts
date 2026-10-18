import type { ElectrobunConfig } from "electrobun";
import { MEASUREMENT_CHROMIUM_SWITCHES } from "./electron/measurement-instance";

// The Electron shell appends these at runtime (`electron/measurement.ts`); CEF only reads them at build time,
// so `scripts/measure-launch` builds its Electrobun bundle with this set. Never set it for a shipped build.
const measurementBuild = process.env.NISI_MEASUREMENT_BUILD === "1";
const measurementChromiumFlags = Object.fromEntries(
	[...MEASUREMENT_CHROMIUM_SWITCHES, "use-mock-keychain"].map((flag) => [
		flag,
		true,
	]),
);

export default {
	app: {
		name: "nisi-electrobun",
		// Not `com.nisi.desktop`: a second bundle with the installed app's ID makes LaunchServices activate that one instead.
		identifier: "com.nisi.desktop.electrobun",
		version: "0.6.1",
		urlSchemes: ["nisi"],
	},
	build: {
		mainProcess: "bun",
		bun: { entrypoint: "electrobun/main.ts" },
		views: {
			// Injected inline into every window's <head>, so it can't be an ES module.
			bridge: { entrypoint: "electrobun/bridge.ts", format: "iife" },
		},
		// `dist/` is the Vite build; `views://mainview/index.html` is what windows load.
		copy: { dist: "views/mainview" },
		// `build/` already holds the Electron icon and entitlements.
		buildFolder: "build-electrobun",
		artifactFolder: "release-electrobun",
		mac: {
			bundleCEF: true,
			defaultRenderer: "cef",
			icons: "electrobun/icon.iconset",
			...(measurementBuild ? { chromiumFlags: measurementChromiumFlags } : {}),
		},
	},
	scripts: { postBuild: "electrobun/post-build.ts" },
	release: { generatePatch: false },
} satisfies ElectrobunConfig;
