import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TAIL_LINES = 40;

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

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, code] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return out.trim();
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
		pending = lines.pop() as string;
		tail.push(...lines);
	}
	if (pending !== "") tail.push(pending);
}

// Heuristic, and only a warning: a check that rewrites files records a pass for code it just changed.
const MUTATING = /(?:^|\s)(?:--write|--fix|-w)(?:\s|$)|\bformat\b/;

/**
 * Runs `command` in `repoRoot`, streams its output through, and records the
 * result as `.nisi/guide/checks/<slug>.json` for the guide's `<Checks />`.
 * Its shape is `GuideCheck` in `packages/sidecar-api/src/guide.ts`, which the
 * sidecar parses — change both together. Re-running with the same title
 * overwrites. Returns the command's exit code.
 *
 * A single-element `command` is a shell line (run with `sh -c`, for `cd` and
 * `&&`); several elements are an argv, run directly.
 */
export async function recordCheck(
	repoRoot: string,
	title: string,
	command: readonly string[],
): Promise<number> {
	const slug = slugify(title);
	const single = command.length === 1;
	const display = single
		? (command[0] as string)
		: command.map(shellQuote).join(" ");
	const spawned = single ? ["sh", "-c", command[0] as string] : [...command];

	if (MUTATING.test(display)) {
		console.error(
			`nisi guide check: "${display}" looks like it modifies files. A recorded check should only read the code it vouches for; use the read-only form (\`biome check\`, \`--check\`) unless this is on purpose.`,
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
		join(dir, `${slug}.json`),
		`${JSON.stringify(record, null, "\t")}\n`,
	);
	return exitCode;
}
