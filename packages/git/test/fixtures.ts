import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs real `git` for test setup — the code under test uses its own Effect-based runner. */
const sh = async (
	cwd: string,
	args: ReadonlyArray<string>,
): Promise<string> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout;
};

export type TestRepo = {
	readonly root: string;
	readonly git: (args: ReadonlyArray<string>) => Promise<string>;
	readonly write: (path: string, content: string) => Promise<void>;
	readonly writeBytes: (path: string, content: Uint8Array) => Promise<void>;
	/** Stages everything and commits. Returns the new commit sha. */
	readonly commit: (message: string) => Promise<string>;
};

/** A throwaway repo in a fresh temp dir, with a `main` branch and git identity configured. */
export const makeTestRepo = async (): Promise<TestRepo> => {
	const root = await mkdtemp(join(tmpdir(), "nisi-git-test-"));
	await sh(root, ["init", "-q", "-b", "main"]);
	await sh(root, ["config", "user.email", "test@example.com"]);
	await sh(root, ["config", "user.name", "Test"]);

	const write = async (path: string, content: string) => {
		await Bun.write(join(root, path), content);
	};
	const writeBytes = async (path: string, content: Uint8Array) => {
		await Bun.write(join(root, path), content);
	};
	const commit = async (message: string) => {
		await sh(root, ["add", "-A"]);
		await sh(root, ["commit", "-q", "-m", message]);
		return (await sh(root, ["rev-parse", "HEAD"])).trim();
	};

	return { root, git: (args) => sh(root, args), write, writeBytes, commit };
};

export const cleanupTestRepo = (repo: TestRepo): Promise<void> =>
	rm(repo.root, { recursive: true, force: true });
