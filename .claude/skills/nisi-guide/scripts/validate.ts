#!/usr/bin/env bun
/**
 * Checks the guide the way the Guide tab will show it, plus what only the
 * author can fix (changed files no Area covers, Refs to lines outside the
 * diff, stale checks):
 *
 *   bun .claude/skills/nisi-guide/scripts/validate.ts [--base <ref>]
 *
 * `--base` defaults to the merge-base of `origin/main` and HEAD. The diff is
 * that base against the working tree, plus untracked files, which is what the
 * session's diff shows with uncommitted changes on. The checks themselves live
 * in `apps/desktop/src/features/guide/validate.ts`; this only reads git.
 */
import { join } from "node:path";
import { buildGuide } from "../../../../apps/desktop/sidecar/guide/build";
import type {
	ChangedRange,
	DiffFile,
} from "../../../../apps/desktop/src/features/guide/validate";
import { validateGuide } from "../../../../apps/desktop/src/features/guide/validate";

async function git(cwd: string, ...args: string[]): Promise<string> {
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

function parseBase(): string | undefined {
	const flag = process.argv.indexOf("--base");
	if (flag === -1) return undefined;
	const value = process.argv[flag + 1];
	if (value === undefined) {
		console.error("usage: validate.ts [--base <ref>]");
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

const repoRoot = (
	await git(process.cwd(), "rev-parse", "--show-toplevel")
).trim();
const base =
	parseBase() ??
	(await git(repoRoot, "merge-base", "origin/main", "HEAD")).trim();

const numstat = await git(repoRoot, "diff", "--numstat", "--no-renames", base);
const ranges = parseChangedRanges(
	await git(repoRoot, "diff", "-U0", "--no-color", "--no-renames", base),
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

// `NeedsYou` reads tick state from localStorage, which a server render lacks.
Object.assign(globalThis, {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
});

const problems = validateGuide(await buildGuide(repoRoot), files);
if (problems.length === 0) {
	console.log(
		`Guide is valid against ${base.slice(0, 7)} (${files.length} changed files).`,
	);
	process.exit(0);
}
console.error(
	`${problems.length} problem${problems.length === 1 ? "" : "s"} in the guide:\n`,
);
for (const problem of problems) console.error(`- ${problem}`);
process.exit(1);
