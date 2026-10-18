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

// `build:electrobun-webkit` sets `native`: system WKWebView, no bundled CEF. Windows follow the build's default renderer.
const native = process.env.NISI_ELECTROBUN_RENDERER === "native";

export default {
	app: {
		name: native ? "nisi-webkit" : "nisi-electrobun",
		// Not `com.nisi.desktop`: a second bundle with the installed app's ID makes LaunchServices activate that one instead.
		identifier: native
			? "com.nisi.desktop.webkit"
			: "com.nisi.desktop.electrobun",
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
		buildFolder: native ? "build-electrobun-webkit" : "build-electrobun",
		artifactFolder: native ? "release-electrobun-webkit" : "release-electrobun",
		mac: {
			bundleCEF: !native,
			defaultRenderer: native ? "native" : "cef",
			icons: "electrobun/icon.iconset",
			// Chromium flags mean nothing to WKWebView.
			...(measurementBuild && !native
				? { chromiumFlags: measurementChromiumFlags }
				: {}),
		},
	},
	scripts: { postBuild: "electrobun/post-build.ts" },
	release: { generatePatch: false },
} satisfies ElectrobunConfig;
