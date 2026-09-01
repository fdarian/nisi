/**
 * Bundles `src/` into `dist/`, the extension's load-unpacked target. Three
 * entries (`background.ts` fires from the manifest as the service worker;
 * `interstitial.ts`/`options.ts` are `<script type="module" src=…>` in
 * their own HTML pages) — `direct-arrival.ts` and `bounce-back.ts` are
 * imports of `background.ts`, not entries, so they end up inlined into
 * `background.js` rather than emitted as their own files.
 *
 * `naming` is pinned to `[name].js` for both entries and chunks (Bun's
 * default hashes filenames, e.g. `background-a1b2c3.js`) because
 * `src/manifest.json` and the two HTML pages reference the built files by
 * their literal, unhashed name. `assertExpectedOutputsExist` below is what
 * catches the pin ever failing to hold, rather than a comment promising it.
 *
 * Every path here is resolved off `import.meta.url`, not `process.cwd()`,
 * so the script behaves the same run from the repo root, from
 * `apps/extension`, or anywhere else — `fileURLToPath`, not `URL.pathname`,
 * because `.pathname` leaves percent-encoding in place (breaks under a
 * path containing a space).
 */
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const srcDir = path.join(packageDir, "src");
const outdir = path.join(packageDir, "dist");

const EXPECTED_ENTRY_OUTPUTS = [
	"background.js",
	"interstitial.js",
	"options.js",
];

function assertExpectedOutputsExist(): void {
	for (const file of EXPECTED_ENTRY_OUTPUTS) {
		if (!existsSync(path.join(outdir, file))) {
			console.error(
				`build succeeded but ${file} is missing from ${outdir} — the "naming" pin in this script no longer matches what Bun emitted`,
			);
			process.exit(1);
		}
	}
}

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: [
		path.join(srcDir, "background.ts"),
		path.join(srcDir, "interstitial.ts"),
		path.join(srcDir, "options.ts"),
	],
	outdir,
	target: "browser",
	format: "esm",
	minify: false,
	sourcemap: "linked",
	naming: { entry: "[name].js", chunk: "[name].js" },
});

if (!result.success) {
	for (const message of result.logs) {
		console.error(message);
	}
	process.exit(1);
}

await cp(
	path.join(srcDir, "manifest.json"),
	path.join(outdir, "manifest.json"),
);
await cp(
	path.join(srcDir, "interstitial.html"),
	path.join(outdir, "interstitial.html"),
);
await cp(path.join(srcDir, "options.html"), path.join(outdir, "options.html"));

assertExpectedOutputsExist();
