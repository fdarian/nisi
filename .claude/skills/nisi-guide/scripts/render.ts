#!/usr/bin/env bun
/**
 * Previews the guide as the reader sees it, from the command line:
 *
 *   bun .claude/skills/nisi-guide/scripts/render.ts [--expand] [--text] [--theme light|dark]
 *                                                    [--width <px>] [--scale <n>] [--base <ref>]
 *
 * Default is PNGs: one per `##` section plus `full.png`, written to
 * `.nisi/guide/.preview/` (git-ignored with `.nisi/`, and outside the guide's
 * version hash). The page is the real kit rendered with real data (area stats
 * from the diff against the merge-base, recorded checks, the head SHA) under
 * the app's own compiled stylesheet, screenshotted by a freshly launched
 * headless Chrome with a throwaway profile; no existing browser is touched.
 *
 * `--expand` stacks every Tour frame, shows both Sequence states and opens the
 * Area file lists, so every pin and state is visible at once.
 * `--text` prints what the reader would take from the page as plain text,
 * expanded, and launches nothing.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAppCss } from "../../../../apps/desktop/scripts/guide-preview-css";
import { buildGuide } from "../../../../apps/desktop/sidecar/guide/build";
import { htmlToText } from "../../../../apps/desktop/src/features/guide/guide-text";
import { renderGuideHtml } from "../../../../apps/desktop/src/features/guide/static-render";
import {
	describeBase,
	git,
	parseBase,
	readDiff,
	stubLocalStorage,
} from "./guide-inputs";

const USAGE =
	"usage: render.ts [--expand] [--text] [--theme light|dark] [--width <px>] [--scale <n>] [--base <ref>]";

function flagValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	if (value === undefined) {
		console.error(USAGE);
		process.exit(2);
	}
	return value;
}

function numberFlag(name: string, fallback: number): number {
	const raw = flagValue(name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		console.error(`${name} needs a positive number\n${USAGE}`);
		process.exit(2);
	}
	return value;
}

const text = process.argv.includes("--text");
const expand = text || process.argv.includes("--expand");
const theme = flagValue("--theme") ?? "light";
if (theme !== "light" && theme !== "dark") {
	console.error(`--theme is light or dark\n${USAGE}`);
	process.exit(2);
}
const width = numberFlag("--width", 900);
const scale = numberFlag("--scale", 1);

const repoRoot = (
	await git(process.cwd(), "rev-parse", "--show-toplevel")
).trim();
const diff = await readDiff(repoRoot, parseBase(USAGE));
stubLocalStorage();

const built = await buildGuide(repoRoot);
if (built.kind !== "ok") {
	console.error(
		built.kind === "missing"
			? `There is no guide at ${built.path}.`
			: `The guide doesn't build:\n${built.message}`,
	);
	process.exit(1);
}
let html: string;
try {
	html = renderGuideHtml(built, diff.files, { expanded: expand });
} catch (cause) {
	console.error(
		`The guide fails to render: ${cause instanceof Error ? cause.message : String(cause)}`,
	);
	process.exit(1);
}

if (text) {
	process.stdout.write(htmlToText(html));
	process.exit(0);
}

const guideDir = join(repoRoot, ".nisi/guide");
const previewDir = join(guideDir, ".preview");

/** Runs in the page: hides everything but one `##` section (`#section=N`), and on `#measure` reports each section's height and title. */
const PAGE_SCRIPT = `
const page = document.getElementById("page");
const content = document.getElementById("content");
const kids = [...content.children];
const starts = kids.flatMap((kid, index) => (kid.tagName === "H2" ? [index] : []));
const groups = starts.map((start, n) => kids.slice(start, starts[n + 1] ?? kids.length));
function show(n) {
	kids.forEach((kid) => { kid.style.display = "none"; });
	(n < 0 ? kids : groups[n]).forEach((kid) => { kid.style.display = ""; });
}
const wanted = location.hash.match(/section=(\\d+)/);
show(wanted ? Number(wanted[1]) : -1);
if (location.hash === "#measure") {
	document.fonts.ready.then(() => {
		const heights = groups.map((_, n) => { show(n); return Math.ceil(page.getBoundingClientRect().height); });
		show(-1);
		heights.push(Math.ceil(page.getBoundingClientRect().height));
		document.documentElement.dataset.measured = encodeURIComponent(JSON.stringify({
			heights,
			titles: groups.map((group) => group[0].textContent),
		}));
	});
}
`;

function pageHtml(css: string): string {
	return `<!doctype html>
<html class="${theme === "dark" ? "dark" : ""}" style="color-scheme:${theme}">
<head>
<meta charset="utf-8">
<title>Guide preview</title>
<style>${css}</style>
<style>
	/* The app's body is a fixed full-window flex column; a preview scrolls like a document. */
	html, body { height: auto; width: auto; overflow: visible; }
	body { position: static; display: block; background: var(--background); }
</style>
</head>
<body>
<div class="@container px-6 py-5" id="page">
	<div class="relative mx-auto max-w-3xl">
		<div class="flex flex-col gap-3 pb-12 text-foreground text-sm leading-relaxed" id="content">${html}</div>
	</div>
</div>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

function chromePath(): string {
	const fromEnv = process.env.CHROME_PATH;
	if (fromEnv !== undefined) return fromEnv;
	const candidates = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	];
	for (const candidate of candidates) {
		if (Bun.file(candidate).size > 0) return candidate;
	}
	const onPath = ["google-chrome", "chromium", "chromium-browser"]
		.map((name) => Bun.which(name))
		.find((found) => found !== null);
	if (onPath !== undefined && onPath !== null) return onPath;
	throw new Error(
		"no Chrome found; set CHROME_PATH to a Chrome or Chromium binary",
	);
}

async function chrome(profile: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(
		[
			chromePath(),
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--no-first-run",
			"--no-default-browser-check",
			`--user-data-dir=${profile}`,
			`--force-device-scale-factor=${scale}`,
			"--virtual-time-budget=3000",
			...args,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [out, err, code] = await Promise.all([
		proc.stdout.text(),
		proc.stderr.text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(`Chrome exited ${code}: ${err.trim().slice(-400)}`);
	return out;
}

function slug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

await rm(previewDir, { recursive: true, force: true });
await mkdir(previewDir, { recursive: true });
const pagePath = join(previewDir, "preview.html");
await Bun.write(pagePath, pageHtml(await compileAppCss(guideDir)));

const profile = await mkdtemp(join(tmpdir(), "nisi-guide-preview-"));
try {
	const dom = await chrome(profile, [
		"--dump-dom",
		`--window-size=${width},1000`,
		`file://${pagePath}#measure`,
	]);
	const measured = /data-measured="([^"]+)"/.exec(dom);
	if (measured === null)
		throw new Error("the preview page didn't report its layout");
	const layout = JSON.parse(decodeURIComponent(measured[1] as string)) as {
		heights: number[];
		titles: string[];
	};
	const shots = [
		...layout.titles.map((title, index) => ({
			file: `${String(index + 1).padStart(2, "0")}-${slug(title)}.png`,
			hash: `#section=${index}`,
			height: layout.heights[index] as number,
		})),
		{
			file: "full.png",
			hash: "",
			height: layout.heights[layout.heights.length - 1] as number,
		},
	];
	for (const shot of shots) {
		await chrome(profile, [
			`--screenshot=${join(previewDir, shot.file)}`,
			`--window-size=${width},${shot.height}`,
			`file://${pagePath}${shot.hash}`,
		]);
	}
} finally {
	await rm(profile, { recursive: true, force: true });
}

const written = (await readdir(previewDir))
	.filter((name) => name.endsWith(".png"))
	.sort();
console.log(
	`${theme}${expand ? ", expanded" : ""}, ${width}px wide. ${describeBase(diff)}:`,
);
for (const name of written) console.log(join(previewDir, name));
console.log(`(page: ${pagePath})`);
