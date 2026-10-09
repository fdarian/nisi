import { join } from "node:path";
import type {
	ChangedRange,
	DiffFile,
} from "../../../../apps/desktop/src/features/guide/validate";

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		proc.stdout.text(),
		proc.stderr.text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
	return out;
}

/** `--base <ref>` from the command line, if given. */
export function parseBase(usage: string): string | undefined {
	const flag = process.argv.indexOf("--base");
	if (flag === -1) return undefined;
	const value = process.argv[flag + 1];
	if (value === undefined) {
		console.error(usage);
		process.exit(2);
	}
	return value;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** `git diff -U0`: the head-side line ranges of each file's hunks. */
function parseChangedRanges(diff: string): Map<string, ChangedRange[]> {
	const byPath = new Map<string, ChangedRange[]>();
	let current: ChangedRange[] | undefined;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ ")) {
			// `+++ /dev/null` is a deletion: nothing of it exists at head.
			const path = line.startsWith("+++ b/")
				? line.slice("+++ b/".length)
				: undefined;
			current = path === undefined ? undefined : [];
			if (path !== undefined && current !== undefined)
				byPath.set(path, current);
			continue;
		}
		const hunk = HUNK.exec(line);
		if (hunk === null || current === undefined) continue;
		const start = Number.parseInt(hunk[1] as string, 10);
		const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
		current.push({ start, end: start + Math.max(count, 1) - 1 });
	}
	return byPath;
}

/**
 * The session's diff as the guide sees it: the merge-base of `origin/main`
 * and HEAD (or `base`) against the working tree, plus untracked files, with
 * per-file stats and the head-side changed line ranges.
 */
export async function readDiff(
	repoRoot: string,
	base: string | undefined,
): Promise<{ base: string; files: DiffFile[] }> {
	const resolved =
		base ?? (await git(repoRoot, "merge-base", "origin/main", "HEAD")).trim();
	const numstat = await git(
		repoRoot,
		"diff",
		"--numstat",
		"--no-renames",
		resolved,
	);
	const ranges = parseChangedRanges(
		await git(repoRoot, "diff", "-U0", "--no-color", "--no-renames", resolved),
	);
	const files: DiffFile[] = [];
	for (const line of numstat.split("\n")) {
		if (line === "") continue;
		const [added, deleted, path] = line.split("\t");
		if (path === undefined) continue;
		files.push({
			path,
			// Binary files report "-".
			additions: added === "-" ? 0 : Number.parseInt(added as string, 10),
			deletions: deleted === "-" ? 0 : Number.parseInt(deleted as string, 10),
			changed: ranges.get(path) ?? [],
		});
	}
	const untracked = await git(
		repoRoot,
		"ls-files",
		"--others",
		"--exclude-standard",
	);
	for (const path of untracked.split("\n")) {
		if (path === "") continue;
		const lines = (await Bun.file(join(repoRoot, path)).text()).split(
			"\n",
		).length;
		files.push({
			path,
			additions: lines,
			deletions: 0,
			changed: [{ start: 1, end: lines }],
		});
	}
	return { base: resolved, files };
}

/** `NeedsYou` reads tick state from localStorage, which a server render lacks. */
export function stubLocalStorage(): void {
	Object.assign(globalThis, {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	});
}
