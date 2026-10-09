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
import { buildGuide } from "../../../../apps/desktop/sidecar/guide/build";
import { validateGuide } from "../../../../apps/desktop/src/features/guide/validate";

import {
	describeBase,
	git,
	parseBase,
	readDiff,
	stubLocalStorage,
} from "./guide-inputs";
const repoRoot = (
	await git(process.cwd(), "rev-parse", "--show-toplevel")
).trim();
const diff = await readDiff(
	repoRoot,
	parseBase("usage: validate.ts [--base <ref>]"),
);
stubLocalStorage();

const problems = validateGuide(await buildGuide(repoRoot), diff.files);
if (problems.length === 0) {
	console.log(`Guide is valid. ${describeBase(diff)}.`);
	process.exit(0);
}
console.error(
	`${problems.length} problem${problems.length === 1 ? "" : "s"} in the guide (${describeBase(diff)}):\n`,
);
for (const problem of problems) console.error(`- ${problem}`);
process.exit(1);
