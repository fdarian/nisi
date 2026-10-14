import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";

const APP_ROOT = join(import.meta.dir, "..");
const ENTRY = "\0guide-preview-entry.css";

/**
 * The app's own stylesheet (`src/index.css`: Tailwind over `src/`, the theme
 * tokens, the bundled fonts) compiled once into a single string, so a preview
 * page needs no server. `extraSource` is a directory Tailwind should scan as
 * well, for classes used by a guide's own components.
 */
export async function compileAppCss(extraSource: string): Promise<string> {
	const result = await build({
		root: APP_ROOT,
		configFile: false,
		logLevel: "silent",
		plugins: [
			tailwindcss(),
			{
				name: "guide-preview-entry",
				resolveId: (id) => (id === ENTRY ? ENTRY : undefined),
				load: (id) =>
					id === ENTRY
						? `@import "${join(APP_ROOT, "src/index.css")}";\n@source "${extraSource}";`
						: undefined,
			},
		],
		build: {
			write: false,
			minify: false,
			// Fonts become data URIs, so the page stands alone.
			assetsInlineLimit: Number.MAX_SAFE_INTEGER,
			rollupOptions: { input: ENTRY },
		},
	});
	const outputs = (Array.isArray(result) ? result : [result]).flatMap(
		(entry) => ("output" in entry ? entry.output : []),
	);
	const css = outputs.find(
		(output): output is Rollup.OutputAsset =>
			output.type === "asset" && output.fileName.endsWith(".css"),
	);
	if (css === undefined) throw new Error("the app stylesheet didn't compile");
	return String(css.source);
}
