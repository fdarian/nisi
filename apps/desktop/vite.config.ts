import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const port = process.env.VITE_PORT ? Number(process.env.VITE_PORT) : 1420;

/**
 * Extra `server.fs.allow` roots for files the dev server must serve from a
 * dependency's *real* on-disk location.
 *
 * `enableGlobalVirtualStore: true` (pnpm-workspace.yaml) makes every
 * `node_modules` entry a symlink into pnpm's global store —
 * `~/Library/pnpm/store/v11/links/...` on macOS — well outside the workspace
 * root Vite's allow-list defaults to, so any such file 403s. `@pierre/diffs`'
 * worker is the visible casualty: `diff-code-view.tsx` builds its URL with
 * `new URL(..., import.meta.url)`, which resolves through the symlink to a
 * `/@fs/<store path>` request, and the refusal kills the whole diff pane with
 * "Worker error" on a cold dev server (`bun dev` and `tauri dev` included —
 * this is a dev-server check, not a browser one). `@fontsource-variable`'s
 * woff2 files go the same way.
 *
 * Derived from an installed dependency rather than hard-coded so it tracks
 * this machine's own `pnpm store path`, and scoped to the store root instead
 * of reaching for `fs: { strict: false }`, which would serve the entire
 * filesystem. An install *without* the global virtual store keeps its
 * packages under the workspace root, which is already allowed — hence nothing
 * to add rather than a failure.
 */
function globalVirtualStoreRoots(): string[] {
	const segments = fs
		.realpathSync(path.resolve(__dirname, "node_modules/@pierre/diffs"))
		.split(path.sep);
	const linksIndex = segments.indexOf("links");
	if (linksIndex === -1) return [];
	return [segments.slice(0, linksIndex + 1).join(path.sep)];
}

// https://vite.dev/config/
export default defineConfig(async () => ({
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react(),
		tailwindcss(),
	],

	resolve: {
		alias: {
			"#": path.resolve(__dirname, "./src"),
		},
	},

	// `@pierre/diffs`' worker (src/components/diff-pane/diff-pane.tsx) is a real ES
	// module with its own imports (shiki, @pierre/theming, diff) — Vite's default
	// worker output format is `iife`, which rollup refuses for a bundle that needs
	// code-splitting. `es` matches the `{ type: "module" }` the Worker is already
	// constructed with.
	worker: {
		format: "es",
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port,
		strictPort: true,
		host: host || false,
		fs: {
			allow: [searchForWorkspaceRoot(__dirname), ...globalVirtualStoreRoots()],
		},
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri`
			ignored: ["**/src-tauri/**"],
		},
	},
}));
