import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-repo-moved-stub.sh");
const RUNNER = join(testDir, "fixtures/repoint-origin-runner.ts");

type RunnerResult =
	| { readonly ok: true; readonly root: string }
	| {
			readonly ok: false;
			readonly tag: string;
			readonly movedOnGitHub: boolean | null;
	  };

const spawnText = async (
	command: ReadonlyArray<string>,
	options: { cwd?: string; env?: Record<string, string | undefined> } = {},
) => {
	const proc = Bun.spawn([...command], {
		...options,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${command.join(" ")} exited ${exitCode}: ${stderr}`);
	}
	return stdout.trim();
};

/** `gh repo view stubFrom` answers `stubTo`; any other lookup fails. */
const runAgainstGhStub = async (
	mode: "verify" | "repoint",
	path: string,
	expected: { owner: string; repo: string },
	stub: { from: string; to: string },
): Promise<RunnerResult> => {
	const stdout = await spawnText(
		["bun", "run", RUNNER, mode, path, expected.owner, expected.repo],
		{
			env: {
				...process.env,
				NISI_GH_BIN: GH_STUB,
				STUB_FROM: stub.from,
				STUB_TO: stub.to,
			},
		},
	);
	// The runner's own warning logs share stdout; the result is the last line.
	const line = stdout.split("\n").at(-1);
	if (line === undefined) throw new Error("runner printed nothing");
	return JSON.parse(line);
};

const withRepo = async (
	originUrl: string,
	body: (path: string) => Promise<void>,
) => {
	const parent = await mkdtemp(join(tmpdir(), "nisi-repoint-origin-"));
	try {
		const path = join(parent, "repo");
		await mkdir(path);
		await spawnText(["git", "init", "-q", "-b", "main"], { cwd: path });
		await spawnText(["git", "remote", "add", "origin", originUrl], {
			cwd: path,
		});
		await body(await realpath(path));
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
};

const originOf = (path: string) =>
	spawnText(["git", "remote", "get-url", "origin"], { cwd: path });

const MOVED = {
	from: "farreldarian/farreldarian",
	to: "fdarian/farreldarian",
} as const;
const EXPECTED = { owner: "fdarian", repo: "farreldarian" } as const;

describe("verifyRepoPathMatchesOrigin with detectMovedRepo", () => {
	test("flags a mismatch GitHub resolves to the expected repo as moved", async () => {
		await withRepo(
			"https://github.com/farreldarian/farreldarian.git",
			async (path) => {
				expect(await runAgainstGhStub("verify", path, EXPECTED, MOVED)).toEqual(
					{
						ok: false,
						tag: "RepoPathOriginMismatch",
						movedOnGitHub: true,
					},
				);
			},
		);
	});

	test("an unrelated repo is a plain mismatch", async () => {
		await withRepo(
			"https://github.com/someoneelse/farreldarian.git",
			async (path) => {
				expect(await runAgainstGhStub("verify", path, EXPECTED, MOVED)).toEqual(
					{
						ok: false,
						tag: "RepoPathOriginMismatch",
						movedOnGitHub: false,
					},
				);
			},
		);
	});

	test("a failed lookup degrades to a plain mismatch", async () => {
		await withRepo(
			"https://github.com/farreldarian/farreldarian.git",
			async (path) => {
				expect(
					await runAgainstGhStub("verify", path, EXPECTED, {
						from: "nobody/nothing",
						to: "x/y",
					}),
				).toEqual({
					ok: false,
					tag: "RepoPathOriginMismatch",
					movedOnGitHub: false,
				});
			},
		);
	});
});

describe("repointOriginToMovedRepo", () => {
	test("rewrites an https origin to the new location", async () => {
		await withRepo(
			"https://github.com/farreldarian/farreldarian.git",
			async (path) => {
				expect(
					await runAgainstGhStub("repoint", path, EXPECTED, MOVED),
				).toEqual({
					ok: true,
					root: path,
				});
				expect(await originOf(path)).toBe(
					"https://github.com/fdarian/farreldarian.git",
				);
			},
		);
	});

	test("keeps an ssh origin on ssh", async () => {
		await withRepo(
			"git@github.com:farreldarian/farreldarian.git",
			async (path) => {
				await runAgainstGhStub("repoint", path, EXPECTED, MOVED);
				expect(await originOf(path)).toBe(
					"git@github.com:fdarian/farreldarian.git",
				);
			},
		);
	});

	test("refuses and leaves origin alone when GitHub does not say the repo moved", async () => {
		const url = "https://github.com/someoneelse/farreldarian.git";
		await withRepo(url, async (path) => {
			expect(await runAgainstGhStub("repoint", path, EXPECTED, MOVED)).toEqual({
				ok: false,
				tag: "RepoPathOriginMismatch",
				movedOnGitHub: false,
			});
			expect(await originOf(path)).toBe(url);
		});
	});

	test("is a no-op when origin already matches", async () => {
		const url = "https://github.com/fdarian/farreldarian.git";
		await withRepo(url, async (path) => {
			expect(await runAgainstGhStub("repoint", path, EXPECTED, MOVED)).toEqual({
				ok: true,
				root: path,
			});
			expect(await originOf(path)).toBe(url);
		});
	});
});
