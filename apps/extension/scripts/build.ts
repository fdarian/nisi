/**
 * Bundles `src/` into `dist/`, the extension's load-unpacked target. Three
 * entries (`background.js` fires from the manifest as the service worker;
 * `interstitial.js`/`options.js` are `<script type="module" src=…>` in
 * their own HTML pages) — `direct-arrival.js` and `bounce-back.js` are
 * imports of `background.js`, not entries, so they end up inlined into
 * `background.js` rather than emitted as their own files.
 *
 * `naming` is pinned to `[name].js` (Bun's default without it hashes
 * filenames, e.g. `background-a1b2c3.js`) because `src/manifest.json` and
 * the two HTML pages reference the built files by their literal, unhashed
 * name — a hashed output would silently break the extension without
 * failing this build.
 */
import { cp, rm } from "node:fs/promises";

const outdir = new URL("../dist/", import.meta.url).pathname;

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["src/background.js", "src/interstitial.js", "src/options.js"],
	outdir,
	target: "browser",
	format: "esm",
	minify: false,
	sourcemap: "linked",
	naming: "[name].js",
});

if (!result.success) {
	for (const message of result.logs) {
		console.error(message);
	}
	process.exit(1);
}

await cp("src/manifest.json", `${outdir}manifest.json`);
await cp("src/interstitial.html", `${outdir}interstitial.html`);
await cp("src/options.html", `${outdir}options.html`);
