import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	type Experimental_SandboxProcess,
	type Experimental_SandboxSession,
	extractLines,
} from "@ai-sdk/provider-utils";
import { resolvedPath } from "@repo/bin-resolver";
import { toSandboxProcess } from "./sandbox-process.ts";
import { bytesToStream, collectStream } from "./stream-utils.ts";

type RunOptions = Parameters<Experimental_SandboxSession["run"]>[0];
type SpawnOptions = Parameters<Experimental_SandboxSession["spawn"]>[0];
type ReadFileOptions = Parameters<Experimental_SandboxSession["readFile"]>[0];
type ReadTextFileOptions = Parameters<
	Experimental_SandboxSession["readTextFile"]
>[0];
type WriteFileOptions = Parameters<Experimental_SandboxSession["writeFile"]>[0];
type WriteBinaryFileOptions = Parameters<
	Experimental_SandboxSession["writeBinaryFile"]
>[0];
type WriteTextFileOptions = Parameters<
	Experimental_SandboxSession["writeTextFile"]
>[0];

/**
 * pnpm ≥10 gates dependency build scripts (postinstall, etc.) behind an
 * interactive `pnpm approve-builds` unless this is set — which every harness
 * adapter's pinned-CLI bootstrap install trips on its very first run,
 * since there's no TTY here to approve through and the bootstrap
 * directory's path isn't ours to choose (see AGENTS.md, "The claude-code
 * adapter's bootstrap directory is hardcoded"). Setting it via env instead
 * of writing a config file works regardless of what path a given adapter
 * happens to bootstrap into.
 *
 * All three spellings are set because pnpm's env-var config prefix changed
 * across versions (`npm_config_*` pre-v11, `pnpm_config_*`/`PNPM_CONFIG_*`
 * from v11) — verified against pnpm 11.17 on 2026-07-28; harmless on
 * versions that don't recognize the key (pnpm ignores unknown config) and a
 * no-op on pnpm <10, which never gated builds at all.
 */
const PNPM_BUILD_APPROVAL_ENV = {
	npm_config_dangerously_allow_all_builds: "true",
	pnpm_config_dangerously_allow_all_builds: "true",
	PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "true",
};

/**
 * `run`/`spawn`'s `command` is an arbitrary shell string composed by the
 * harness adapter (`pnpm --dir ... install`, `node .../bridge.mjs`, the
 * bootstrapped CLI itself, ...) — there's no single binary to resolve up
 * front the way `sidecar/walkthrough/model-discovery.ts` resolves one for
 * each harness CLI, so the fix here is widening `PATH` itself rather than
 * one `@repo/bin-resolver#resolveBin` call. Computed once per process for
 * the same reason `packages/git/src/exec.ts` resolves `git`/`gh` once: it
 * only reads `PATH`/the filesystem, neither of which changes over the
 * sidecar's lifetime. Same underlying GUI-`PATH` exposure as the harness
 * CLIs — a macOS `.app` launched from Finder/`open` never runs login shell
 * startup files, so e.g. a Bun-installed `pnpm` at `~/.bun/bin` (this
 * bootstrap's own dependency) wouldn't otherwise resolve.
 */
const RESOLVED_PATH = resolvedPath();

/**
 * `Experimental_SandboxSession` over the real filesystem and a real shell —
 * `run`/`spawn` shell out via `node:child_process`, file I/O goes through
 * `node:fs/promises`. This is the tool-safe surface returned by
 * `LocalNetworkSandboxSession.restricted()`; it holds no infra members
 * (no `stop`/`destroy`/`getPortUrl`), just exec + file I/O against `cwd`.
 */
export class LocalSandboxSession implements Experimental_SandboxSession {
	constructor(protected readonly cwd: string) {}

	get description(): string {
		return [
			"Local sandbox: the real host filesystem and a real shell (bash), not a virtual one.",
			"Files written here and processes spawned here are the actual host's — this is the user's own worktree.",
			`Current working directory: ${this.cwd}`,
		].join("\n");
	}

	private resolvePath(path: string): string {
		return isAbsolute(path) ? path : resolve(this.cwd, path);
	}

	async run({
		command,
		workingDirectory,
		env,
		abortSignal,
	}: RunOptions): Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}> {
		abortSignal?.throwIfAborted();

		const child = spawn("/bin/bash", ["-c", command], {
			cwd: workingDirectory ?? this.cwd,
			env: {
				...PNPM_BUILD_APPROVAL_ENV,
				...process.env,
				PATH: RESOLVED_PATH,
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
			signal: abortSignal,
		});

		/*
		 * `run` is `spawn` plus draining both streams to strings — built on the
		 * same wrapper so a killed-by-signal exit code (128 + signum) is computed
		 * identically in both. Streams must be read via `collectStream`, not a
		 * manual `'data'` listener race against `toSandboxProcess`'s own
		 * `Readable.toWeb`, which would otherwise fight over the same source.
		 */
		const process_ = toSandboxProcess(child, abortSignal);
		const [stdout, stderr, { exitCode }] = await Promise.all([
			collectStream(process_.stdout).then((bytes) =>
				Buffer.from(bytes).toString("utf-8"),
			),
			collectStream(process_.stderr).then((bytes) =>
				Buffer.from(bytes).toString("utf-8"),
			),
			process_.wait(),
		]);

		return { exitCode, stdout, stderr };
	}

	async spawn({
		command,
		workingDirectory,
		env,
		abortSignal,
	}: SpawnOptions): Promise<Experimental_SandboxProcess> {
		abortSignal?.throwIfAborted();

		const child = spawn("/bin/bash", ["-c", command], {
			cwd: workingDirectory ?? this.cwd,
			env: {
				...PNPM_BUILD_APPROVAL_ENV,
				...process.env,
				PATH: RESOLVED_PATH,
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
			signal: abortSignal,
		});

		return toSandboxProcess(child, abortSignal);
	}

	async readFile({
		path,
		abortSignal,
	}: ReadFileOptions): Promise<ReadableStream<Uint8Array> | null> {
		const bytes = await this.readBinaryFile({ path, abortSignal });
		return bytes == null ? null : bytesToStream(bytes);
	}

	async readBinaryFile({
		path,
		abortSignal,
	}: ReadFileOptions): Promise<Uint8Array | null> {
		abortSignal?.throwIfAborted();
		const resolved = this.resolvePath(path);
		try {
			const buffer = await readFile(resolved);
			return new Uint8Array(
				buffer.buffer,
				buffer.byteOffset,
				buffer.byteLength,
			);
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}

	async readTextFile({
		path,
		encoding = "utf-8",
		startLine,
		endLine,
		abortSignal,
	}: ReadTextFileOptions): Promise<string | null> {
		const bytes = await this.readBinaryFile({ path, abortSignal });
		if (bytes == null) return null;
		const text = Buffer.from(bytes).toString(encoding as BufferEncoding);
		return extractLines({ text, startLine, endLine });
	}

	async writeFile({
		path,
		content,
		abortSignal,
	}: WriteFileOptions): Promise<void> {
		const bytes = await collectStream(content);
		await this.writeBinaryFile({ path, content: bytes, abortSignal });
	}

	async writeBinaryFile({
		path,
		content,
		abortSignal,
	}: WriteBinaryFileOptions): Promise<void> {
		abortSignal?.throwIfAborted();
		const resolved = this.resolvePath(path);
		await mkdir(dirname(resolved), { recursive: true });
		await writeFile(resolved, content);
	}

	async writeTextFile({
		path,
		content,
		encoding = "utf-8",
		abortSignal,
	}: WriteTextFileOptions): Promise<void> {
		const buffer = Buffer.from(content, encoding as BufferEncoding);
		await this.writeBinaryFile({
			path,
			content: new Uint8Array(
				buffer.buffer,
				buffer.byteOffset,
				buffer.byteLength,
			),
			abortSignal,
		});
	}
}

function isEnoent(error: unknown): boolean {
	return (
		error instanceof Object &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
