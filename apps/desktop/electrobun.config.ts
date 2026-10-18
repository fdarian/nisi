import type { ElectrobunConfig } from "electrobun";

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
		},
	},
	scripts: { postBuild: "electrobun/post-build.ts" },
	release: { generatePatch: false },
} satisfies ElectrobunConfig;
