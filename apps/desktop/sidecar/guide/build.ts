import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { compile } from "@mdx-js/mdx";
import { GuideCheck, type GuideResult } from "@repo/sidecar-api";
import { Schema } from "effect";

export const GUIDE_DIR = ".nisi/guide";
export const GUIDE_ENTRY = "guide.mdx";
/** Recorded command runs (`.claude/skills/nisi-guide/check.ts`). Not bundle input, so kept out of `version`. */
const CHECKS_DIR = "checks";

/**
 * Specifiers the frontend evaluator (`src/features/guide/evaluate.ts`)
 * answers from the app's own module instances. Keep both lists in step: a guide
 * must never bundle a second copy of React or of the kit.
 */
const EXTERNALS = [
	"react",
	"react/jsx-runtime",
	"react/jsx-dev-runtime",
	"react-dom",
	"@nisi/guide",
];

const mdxPlugin: Bun.BunPlugin = {
	name: "mdx",
	setup(build) {
		build.onLoad({ filter: /\.mdx$/ }, async (args) => {
			const source = await Bun.file(args.path).text();
			const compiled = await compile(
				{ value: source, path: args.path },
				{ jsxImportSource: "react", development: false },
			);
			return { contents: String(compiled), loader: "js" };
		});
	},
};

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

/** `import shot from "./shot.png"` yields a data URL, so the bundle is self-contained — Bun's `dataurl` loader is documented but emits an empty string. */
const imagePlugin: Bun.BunPlugin = {
	name: "guide-images",
	setup(build) {
		build.onLoad({ filter: /\.(png|jpe?g|gif|webp|svg)$/ }, async (args) => {
			const extension = args.path.slice(args.path.lastIndexOf(".") + 1);
			const mime = IMAGE_MIME[extension];
			if (mime === undefined) throw new Error(`unsupported image ${args.path}`);
			const bytes = await Bun.file(args.path).bytes();
			const url = `data:${mime};base64,${bytes.toBase64()}`;
			return {
				contents: `export default ${JSON.stringify(url)};`,
				loader: "js",
			};
		});
	},
};

type CachedBundle = { version: string; code: string };
const cache = new Map<string, CachedBundle>();

async function listFiles(dir: string, skip?: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries
			.filter((entry) => entry.name !== skip)
			.map((entry) =>
				entry.isDirectory()
					? listFiles(join(dir, entry.name))
					: [join(dir, entry.name)],
			),
	);
	return nested.flat().sort();
}

/** Hash of path + mtime + size over every bundle input in the guide directory, so an edit to an imported component or image rebuilds too. */
async function guideVersion(guideDir: string): Promise<string> {
	const hash = createHash("sha256");
	for (const file of await listFiles(guideDir, CHECKS_DIR)) {
		const info = await stat(file);
		hash.update(`${relative(guideDir, file)}\0${info.mtimeMs}\0${info.size}\0`);
	}
	return hash.digest("hex").slice(0, 16);
}

async function bundle(entry: string): Promise<string> {
	const output = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "cjs",
		external: EXTERNALS,
		plugins: [mdxPlugin, imagePlugin],
		throw: false,
		jsx: { runtime: "automatic", development: false, importSource: "react" },
	});
	if (!output.success) {
		throw new Error(output.logs.map((log) => log.message).join("\n"));
	}
	const first = output.outputs[0];
	if (first === undefined) throw new Error("bundler produced no output");
	return await first.text();
}

const decodeCheck = Schema.decodeUnknownSync(GuideCheck);

async function readChecks(guideDir: string): Promise<GuideCheck[]> {
	const dir = join(guideDir, CHECKS_DIR);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw cause;
	}
	const checks = await Promise.all(
		names
			.filter((name) => name.endsWith(".json"))
			.map(async (name) => {
				const file = join(dir, name);
				try {
					return decodeCheck(await Bun.file(file).json());
				} catch (cause) {
					throw new Error(
						`${file} isn't a valid check record (re-run it through check.ts): ${cause instanceof Error ? cause.message : String(cause)}`,
					);
				}
			}),
	);
	return checks.sort((a, b) => a.at.localeCompare(b.at));
}

async function headSha(repoRoot: string): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		proc.stdout.text(),
		proc.stderr.text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git rev-parse HEAD failed: ${err.trim()}`);
	return out.trim();
}

/**
 * Bundles `<repoRoot>/.nisi/guide/guide.mdx` and attaches the recorded check
 * runs and the worktree's head. A failed build is an `error` result rather
 * than a throw: the author is mid-edit while the Guide tab polls, and that
 * state is exactly what the tab exists to display. The bundle is cached on its
 * inputs; checks and head are re-read every call because they change without
 * the bundle changing.
 */
export async function buildGuide(repoRoot: string): Promise<GuideResult> {
	const guideDir = join(repoRoot, GUIDE_DIR);
	const path = join(guideDir, GUIDE_ENTRY);
	if (!(await Bun.file(path).exists())) return { kind: "missing", path };

	try {
		const version = await guideVersion(guideDir);
		let bundled = cache.get(repoRoot);
		if (bundled === undefined || bundled.version !== version) {
			bundled = { version, code: await bundle(path) };
			cache.set(repoRoot, bundled);
		}
		return {
			kind: "ok",
			path,
			version,
			code: bundled.code,
			checks: await readChecks(guideDir),
			headSha: await headSha(repoRoot),
		};
	} catch (cause) {
		return {
			kind: "error",
			path,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
}
