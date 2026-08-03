import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import type { PluginOption } from "vite";

/**
 * `@storybook/react-vite` already installs its own `@vitejs/plugin-react`
 * instance for JSX/refresh — merging the app config's `plugins` array
 * wholesale would add a *second* one, and two react-refresh transforms
 * running over the same file both inject the same boilerplate, which esbuild
 * then rejects wholesale ("The symbol 'inWebWorker' has already been
 * declared"). Only `tanstackRouter`/`tailwindcss` are unique to the app
 * config; React itself is dropped here since Storybook's own copy already
 * covers it.
 */
async function withoutReactPlugin(
	plugins: PluginOption[] | undefined,
): Promise<PluginOption[]> {
	const flattened = await Promise.all(
		(plugins ?? []).flatMap(async (plugin) => {
			const resolved = await plugin;
			return Array.isArray(resolved) ? resolved : [resolved];
		}),
	);
	return flattened
		.flat()
		.filter((plugin) => plugin && !plugin.name?.startsWith("vite:react"));
}

/**
 * `viteFinal` merges Storybook's own Vite config on top of the app's real one
 * (`../vite.config.ts`) rather than redeclaring it — the `#/*` alias, the
 * Tailwind v4 plugin, and `@pierre/diffs`' `worker: { format: "es" }` all
 * come from there, and the reference pane's diff view (a real Web Worker)
 * silently fails to paint without the last one. `mergeConfig` keeps
 * Storybook's own `plugins`/`server` additions rather than letting the
 * app config's (irrelevant here — Tauri dev server port, `src-tauri` watch
 * ignore) clobber them.
 *
 * Loaded via Vite's own `loadConfigFromFile` rather than a bare
 * `import("../vite.config.ts")` — a bare dynamic import runs the file as
 * plain ESM with none of the CJS shims Vite's config loader injects, and
 * `vite.config.ts` uses `__dirname` (needed there for its `fs.realpathSync`
 * pnpm-store lookup), which is `undefined` in that context and crashes the
 * whole preview build (`ReferenceError: __dirname is not defined`).
 * `loadConfigFromFile` is the same loader `vite dev`/`vite build` use on this
 * file themselves, so it gets the same shims.
 */
const config: StorybookConfig = {
	stories: ["../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
	// `@storybook/addon-docs` is dropped, not just disabled — its autodocs
	// source-serializer (`reactElementToJsxString`) walks every rendered
	// prop to pretty-print JSX, including the `Proxy`-backed `orpc` query
	// utils this component takes, and throws (`prot.hasOwnProperty is not a
	// function`) instead of skipping it. Nothing here needs generated docs
	// pages badly enough to work around that.
	addons: ["@storybook/addon-a11y"],
	framework: "@storybook/react-vite",
	async viteFinal(storybookConfig) {
		const { mergeConfig, loadConfigFromFile } = await import("vite");
		const loaded = await loadConfigFromFile(
			{ command: "serve", mode: "development" },
			fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
		);
		if (loaded === null) {
			throw new Error("Could not load ../vite.config.ts for Storybook");
		}
		return mergeConfig(storybookConfig, {
			plugins: await withoutReactPlugin(loaded.config.plugins),
			resolve: loaded.config.resolve,
			worker: loaded.config.worker,
			// Storybook's own Vite dev server has its own `server.fs.allow`,
			// scoped to the workspace root — without also merging in the app
			// config's pnpm-global-store addition (see that file's own comment),
			// `@pierre/diffs`' worker script 403s here exactly the way it does in
			// a cold `bun dev`/`tauri dev`, and the reference pane's diff view
			// never paints.
			server: { fs: { allow: loaded.config.server?.fs?.allow } },
		});
	},
};
export default config;
