import { join } from "node:path";

const compiled = Bun.main.startsWith("/$bunfs/");

const sourceCss = new Map<string, Promise<string>>();

/**
 * The app's stylesheet for `guide.preview`.
 *
 * Compiled sidecar: the copy `scripts/build-guide-css.ts` generated at
 * `build:sidecar` time and embedded as text. It has no Vite, no Tailwind and
 * no source tree to run them over, so a guide's own components can't add
 * Tailwind classes the app doesn't already use.
 *
 * Running from source: compiled once per process (Vite and Tailwind are slow
 * to start), scanning the guide directory too so its components' classes exist.
 */
export function appStylesheet(guideDir: string): Promise<string> {
	if (compiled) {
		return import("./app-stylesheet.gen.txt", { with: { type: "text" } }).then(
			(module) => module.default,
		);
	}
	let css = sourceCss.get(guideDir);
	if (css === undefined) {
		// Variable specifier: the compiler must not follow it into Vite.
		const script = join(import.meta.dir, "../../scripts/guide-preview-css.ts");
		css = import(script).then((module) => module.compileAppCss(guideDir));
		css.catch(() => sourceCss.delete(guideDir));
		sourceCss.set(guideDir, css);
	}
	return css;
}
