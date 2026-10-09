import { join } from "node:path";
import { classifyFile, parseChangedRuns } from "@repo/git";
import type { DiffFile } from "../../src/features/guide/validate";

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
	return out;
}

async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
	});
	return (await proc.exited) === 0;
}

/**
 * The branch a change is measured against: `origin/main` when it exists and
 * isn't behind the local `main` (a stale remote ref would make the diff
 * include everything merged since), else local `main`, else `master`. An
 * explicit `--base` wins.
 */
async function resolveBaseRef(
	repoRoot: string,
	explicit: string | undefined,
): Promise<string> {
	if (explicit !== undefined) return explicit;
	const has = (ref: string) =>
		gitOk(repoRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
	const [remoteMain, localMain] = await Promise.all([
		has("origin/main"),
		has("main"),
	]);
	if (
		remoteMain &&
		(!localMain ||
			(await gitOk(
				repoRoot,
				"merge-base",
				"--is-ancestor",
				"main",
				"origin/main",
			)))
	) {
		return "origin/main";
	}
	if (localMain) return "main";
	if (await has("master")) return "master";
	if (remoteMain) return "origin/main";
	throw new Error(
		"couldn't find a base branch (origin/main, main, master); pass --base <ref>",
	);
}

/** Per-file `git diff -U0` sections, keyed by head path. */
function splitSections(diff: string): Map<string, string> {
	const sections = new Map<string, string>();
	for (const section of diff.split(/^(?=diff --git )/m)) {
		const header = /^\+\+\+ b\/(.+)$/m.exec(section);
		if (header !== null) sections.set(header[1] as string, section);
	}
	return sections;
}

const CONTENT_PREFIX_BYTES = 32 * 1024;

/** `git check-attr linguist-generated` for many paths in one call. */
async function linguistGenerated(
	repoRoot: string,
	paths: readonly string[],
): Promise<Set<string>> {
	if (paths.length === 0) return new Set();
	const proc = Bun.spawn(
		["git", "check-attr", "--stdin", "-z", "linguist-generated"],
		{
			cwd: repoRoot,
			stdin: new Blob([paths.map((path) => `${path}\0`).join("")]),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	const tokens = out.split("\0");
	const generated = new Set<string>();
	for (let index = 0; index + 2 < tokens.length; index += 3) {
		const value = tokens[index + 2];
		if (value === "set" || value === "true") {
			generated.add(tokens[index] as string);
		}
	}
	return generated;
}

/**
 * The session's diff as the guide sees it: the base (see `resolveBaseRef`)
 * merge-based against HEAD, compared with the working tree, plus untracked
 * files that git doesn't ignore (`.gitignore`, `.git/info/exclude`). The
 * guide's own `.nisi/` is never part of it. Each file carries its stats, its
 * changed runs, and whether the sidecar's classifier would call it generated
 * (lockfiles, `*.snap`, drizzle snapshots, `@generated`, `linguist-generated`).
 */
export async function readGuideDiff(
	repoRoot: string,
	base: string | undefined,
): Promise<{ base: string; mergeBase: string; files: DiffFile[] }> {
	const baseRef = await resolveBaseRef(repoRoot, base);
	const mergeBase = (await git(repoRoot, "merge-base", baseRef, "HEAD")).trim();
	const numstat = await git(
		repoRoot,
		"diff",
		"--numstat",
		"--no-renames",
		mergeBase,
	);
	const sections = splitSections(
		await git(repoRoot, "diff", "-U0", "--no-color", "--no-renames", mergeBase),
	);
	const isGuideFile = (path: string) => path.startsWith(".nisi/");
	const files: DiffFile[] = [];
	for (const line of numstat.split("\n")) {
		if (line === "") continue;
		const [added, deleted, path] = line.split("\t");
		if (path === undefined || isGuideFile(path)) continue;
		files.push({
			path,
			// Binary files report "-".
			additions: added === "-" ? 0 : Number.parseInt(added as string, 10),
			deletions: deleted === "-" ? 0 : Number.parseInt(deleted as string, 10),
			hunks: parseChangedRuns(sections.get(path) ?? ""),
		});
	}
	const untracked = (
		await git(repoRoot, "ls-files", "--others", "--exclude-standard")
	)
		.split("\n")
		.filter((path) => path !== "" && !isGuideFile(path));
	for (const path of untracked) {
		const bytes = await Bun.file(join(repoRoot, path)).bytes();
		const binary = bytes.includes(0);
		const lines = binary
			? 0
			: new TextDecoder().decode(bytes).split("\n").length;
		files.push({
			path,
			additions: lines,
			deletions: 0,
			hunks:
				lines === 0
					? []
					: [{ startLine: 1, endLine: lines, additions: lines, deletions: 0 }],
		});
	}
	const flagged = await linguistGenerated(
		repoRoot,
		files.map((file) => file.path),
	);
	for (const file of files) {
		const prefix = await Bun.file(join(repoRoot, file.path))
			.slice(0, CONTENT_PREFIX_BYTES)
			.text()
			.catch(() => undefined);
		file.generated =
			classifyFile({
				path: file.path,
				linguistGenerated: flagged.has(file.path),
				contentPrefix: prefix,
			}) === "generated";
	}
	return { base: baseRef, mergeBase, files };
}
