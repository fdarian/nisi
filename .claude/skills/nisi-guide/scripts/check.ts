#!/usr/bin/env bun
/**
 * Runs a command and records the result for the guide's `<Checks />`:
 *
 *   bun .claude/skills/nisi-guide/scripts/check.ts "Type check and lint" -- pnpm turbo run check:type check:lint
 *   bun .claude/skills/nisi-guide/scripts/check.ts Desktop tests -- "cd apps/desktop && bun test"
 *
 * The command is either an argv (`-- cmd arg arg`, run directly) or one quoted
 * shell line (run with `sh -c`, for `cd` and `&&`). The title is everything
 * before `--`.
 *
 * Runs in the repo root, streams the command's output through, and exits with
 * its exit code. The record lands in `.nisi/guide/checks/<slug>.json`; its shape
 * is `GuideCheck` in `packages/sidecar-api/src/guide.ts`, which the sidecar
 * parses — change both together. Re-running with the same title overwrites.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TAIL_LINES = 40;

function usage(): never {
	console.error('usage: check.ts "<Title>" -- <command…>');
	process.exit(2);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([proc.stdout.text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return out.trim();
}

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug === "")
		throw new Error(`title "${title}" has nothing to name a file by`);
	return slug;
}

function shellQuote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg)
		? arg
		: `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Forwards a stream to the terminal as it arrives and keeps the last lines for the record. */
async function pump(
	stream: ReadableStream<Uint8Array>,
	sink: NodeJS.WriteStream,
	tail: string[],
): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	for await (const chunk of stream) {
		const text = decoder.decode(chunk, { stream: true });
		sink.write(text);
		pending += text;
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		tail.push(...lines);
	}
	if (pending !== "") tail.push(pending);
}

const separator = process.argv.indexOf("--");
// Everything before `--` is the title, so it doesn't need quoting.
if (separator < 3) usage();
const title = process.argv.slice(2, separator).join(" ");
const argv = process.argv.slice(separator + 1);
if (argv.length === 0) usage();

const repoRoot = await git(process.cwd(), "rev-parse", "--show-toplevel");
// A single argument is a shell line (`"cd x && bun test"`); several are an argv.
const display =
	argv.length === 1 ? (argv[0] as string) : argv.map(shellQuote).join(" ");
const spawned = argv.length === 1 ? ["sh", "-c", argv[0] as string] : argv;

// Heuristic, and only a warning: a check that rewrites files records a pass for code it just changed.
const MUTATING = /(?:^|\s)(?:--write|--fix|-w)(?:\s|$)|\bformat\b/;
if (MUTATING.test(display)) {
	console.error(
		`check.ts: "${display}" looks like it modifies files. A recorded check should only read the code it vouches for; use the read-only form (\`biome check\`, \`--check\`) unless this is on purpose.`,
	);
}

const startedAt = performance.now();
const proc = Bun.spawn(spawned, {
	cwd: repoRoot,
	stdin: "inherit",
	stdout: "pipe",
	stderr: "pipe",
});
const merged: string[] = [];
await Promise.all([
	pump(proc.stdout, process.stdout, merged),
	pump(proc.stderr, process.stderr, merged),
]);
const exitCode = await proc.exited;
const durationMs = Math.round(performance.now() - startedAt);

const record = {
	title,
	command: display,
	exitCode,
	durationMs,
	sha: await git(repoRoot, "rev-parse", "HEAD"),
	at: new Date().toISOString(),
	output: merged
		.slice(-TAIL_LINES)
		.map((line) => Bun.stripANSI(line))
		.join("\n"),
};
const dir = join(repoRoot, ".nisi/guide/checks");
await mkdir(dir, { recursive: true });
await writeFile(
	join(dir, `${slugify(title)}.json`),
	`${JSON.stringify(record, null, "\t")}\n`,
);
process.exit(exitCode);
