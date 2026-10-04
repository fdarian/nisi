import { expect, test } from "bun:test";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { readIndexHead } from "../src/index-head.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

test("index head keys track exact fork owner/branch and decline unusual push configurations", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("a", "base");
		await repo.commit("base");
		await repo.git(["checkout", "-b", "feature"]);
		await repo.git([
			"remote",
			"add",
			"origin",
			"https://github.com/acme/project.git",
		]);
		await repo.git([
			"remote",
			"add",
			"fork",
			"git@github.com:fork/project.git",
		]);
		await repo.git(["config", "branch.feature.remote", "fork"]);
		await repo.git(["config", "branch.feature.merge", "refs/heads/feature"]);
		const run = () =>
			Effect.runPromise(
				readIndexHead(repo.root).pipe(Effect.provide(BunServices.layer)),
			);
		expect(await run()).toEqual({
			owner: "acme",
			repo: "project",
			headOwner: "fork",
			branch: "feature",
		});
		await repo.git(["config", "remote.pushDefault", "origin"]);
		expect(await run()).toBeUndefined();
		await repo.git(["config", "--unset", "remote.pushDefault"]);
		await repo.git(["config", "remote.fork.push", "feature:other"]);
		expect(await run()).toBeUndefined();
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("open PR index paginates, preserves ordering and surfaces auth/decode failures", async () => {
	const repo = await makeTestRepo();
	try {
		const page = (number: number, more: boolean) => ({
			data: {
				repository: {
					owner: { login: "acme" },
					name: "project",
					defaultBranchRef: { name: "main" },
					pullRequests: {
						nodes: [
							{
								number,
								title: `PR ${number}`,
								baseRefName: "main",
								headRefName: "feature",
								isCrossRepository: true,
								headRepositoryOwner: { login: "fork" },
							},
						],
						pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
					},
				},
			},
		});
		const first = join(repo.root, "first.json");
		const second = join(repo.root, "second.json");
		await Bun.write(first, JSON.stringify(page(2, true)));
		await Bun.write(second, JSON.stringify(page(1, false)));
		const log = join(repo.root, "calls");
		const run = async (exit: string) => {
			const child = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "fixtures/open-pr-index-runner.ts"),
					repo.root,
				],
				{
					env: {
						...process.env,
						NISI_GH_BIN: join(
							import.meta.dir,
							"fixtures/gh-open-pr-index-stub.sh",
						),
						NISI_TEST_FIRST: first,
						NISI_TEST_SECOND: second,
						NISI_TEST_LOG: log,
						NISI_TEST_EXIT: exit,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stdout = await new Response(child.stdout).text();
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited, stderr).toBe(0);
			return Effect.runPromise(
				Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
					stdout,
				),
			);
		};
		expect(await run("0")).toMatchObject({
			ok: true,
			value: { prs: [{ number: 2, headOwner: "fork" }, { number: 1 }] },
		});
		const calls = (await Bun.file(log).text()).trim().split("\n");
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("after=next");
		expect(calls[0]).toContain("states: OPEN");
		expect(await run("1")).toMatchObject({
			ok: false,
			tag: "GitHubUnreachable",
		});
		await Bun.write(first, "bad JSON");
		expect(await run("0")).toMatchObject({
			ok: false,
			tag: "GhOutputDecodeError",
		});
	} finally {
		await cleanupTestRepo(repo);
	}
});
