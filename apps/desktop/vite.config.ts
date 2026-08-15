import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { agentationSourceLocation } from "agentation/vite";
import { defineConfig, searchForWorkspaceRoot } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const port = process.env.VITE_PORT ? Number(process.env.VITE_PORT) : 1420;
// `scripts/dev.ts --host` — binds the server to every interface instead of
// localhost-only. Distinct from `host` above: `TAURI_DEV_HOST` points the HMR
// *client* at a specific LAN address (Tauri mobile dev), this only widens
// what the server binds to.
// @ts-expect-error process is a nodejs global
const exposeHost = process.env.VITE_HOST === "true";

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
		.realpathSync(
			path.resolve(import.meta.dirname, "node_modules/@pierre/diffs"),
		)
		.split(path.sep);
	const linksIndex = segments.indexOf("links");
	if (linksIndex === -1) return [];
	return [segments.slice(0, linksIndex + 1).join(path.sep)];
}

/** `apps/desktop/package.json` is the version source of truth — see `scripts/sync-version.ts`. */
function resolveAppVersion(): string {
	const packageJsonPath = path.resolve(import.meta.dirname, "package.json");
	const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
	const version = packageJson.version;
	if (typeof version !== "string" || version.length === 0) {
		throw new Error(`Missing or unparseable "version" in ${packageJsonPath}`);
	}
	return version;
}

/**
 * The commit the running build was produced from, shown (and linked) in the
 * About dialog. `NISI_COMMIT_SHA` lets a build from a source tarball with no
 * `.git` directory supply it directly; every other build reads it straight
 * off the repo. No `"unknown"` fallback — a build that can't identify its
 * own commit should fail loudly instead of shipping a dialog that lies.
 */
function resolveCommitSha(): string {
	// @ts-expect-error process is a nodejs global
	const envSha = process.env.NISI_COMMIT_SHA;
	if (envSha) return envSha;

	const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
		cwd: import.meta.dirname,
	});
	if (result.exitCode === 0) {
		return result.stdout.toString().trim();
	}

	throw new Error(
		"Could not resolve the build commit: `git rev-parse HEAD` failed and " +
			"NISI_COMMIT_SHA is unset. Set NISI_COMMIT_SHA when building from a " +
			"source tarball with no .git directory.",
	);
}

// https://vite.dev/config/
export default defineConfig(async () => ({
	// Build-time constants for the custom About dialog (`src/components/about-dialog.tsx`)
	// — see `src/vite-env.d.ts` for their type declarations. The native AppKit about
	// panel can't render a hyperlink, so the dialog needs the commit baked in itself.
	define: {
		__APP_VERSION__: JSON.stringify(resolveAppVersion()),
		__APP_COMMIT_SHA__: JSON.stringify(resolveCommitSha()),
	},

	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		// Stamps JSX host elements with their original file/line as a
		// data-agentation-source attribute — see agentation/vite's doc comment
		// for why the toolbar can't recover this from React internals alone in
		// a bundled build. Dev-only: gated on the same NODE_ENV that
		// build:frontend:dev already sets to flip Vite's JSX dev/prod mode, so
		// a normal production build never gets these attributes injected.
		...(process.env.NODE_ENV === "development"
			? [agentationSourceLocation()]
			: []),
		react(),
		tailwindcss(),
	],

	resolve: {
		alias: {
			"#": path.resolve(import.meta.dirname, "./src"),
		},
		dedupe: ["react", "react-dom"],
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
		host: host || exposeHost || false,
		fs: {
			allow: [
				searchForWorkspaceRoot(import.meta.dirname),
				...globalVirtualStoreRoots(),
			],
		},
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			ignored: [
				// 3. tell Vite to ignore watching `src-tauri`
				"**/src-tauri/**",
				// devsess's per-session data dirs (`AGENTS.md`'s "Dev/prod isolation")
				// live under here, and a PR worktree (`@repo/git`'s
				// `openPullRequestWorktree`) lands inside one of those — a full git
				// checkout appearing mid-request inside a watched directory, tsconfig
				// files and all. Left unignored, that triggers a full-page reload
				// right as `pullRequests.open` is still in flight. The whole `.data`
				// tree is excluded, not just its `worktrees/` subdirectory, since
				// sessions also write `sidecar.json`/`app.db` there that don't need
				// watching either.
				"**/.data/**",
			],
		},
	},
}));
