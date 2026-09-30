import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";

const root = dirname(fileURLToPath(import.meta.url));
const Result = Schema.Struct({
	ok: Schema.Boolean,
	job: Schema.optional(
		Schema.Struct({
			name: Schema.String,
			steps: Schema.Array(
				Schema.Struct({
					number: Schema.Number,
					conclusion: Schema.NullOr(Schema.String),
				}),
			),
		}),
	),
	logs: Schema.optional(
		Schema.Union([
			Schema.Struct({
				status: Schema.Literal("available"),
				raw: Schema.String,
			}),
			Schema.Struct({
				status: Schema.Literal("unavailable"),
				reason: Schema.String,
			}),
		]),
	),
	error: Schema.optional(Schema.Struct({ _tag: Schema.String })),
});

async function run(action: string, id: number) {
	const proc = Bun.spawn(
		[
			"bun",
			"run",
			join(root, "fixtures/actions-job-runner.ts"),
			root,
			action,
			String(id),
		],
		{
			env: {
				...process.env,
				NISI_GH_BIN: join(root, "fixtures/gh-actions-job-stub.sh"),
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const output = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (output[2] !== 0) throw new Error(output[1]);
	return Effect.runPromise(
		Schema.decodeUnknownEffect(Schema.fromJsonString(Result))(output[0]),
	);
}

test("Actions metadata decoding and exact job endpoint", async () => {
	const result = await run("job", 1);
	expect(result.ok).toBe(true);
	expect(result.job).toEqual({
		name: "test",
		steps: [{ number: 1, conclusion: "failure" }],
	});
	expect((await run("job", 2)).error?._tag).toBe("GhOutputDecodeError");
});

test("raw logs retain CRLF; missing and expired logs are typed unavailable", async () => {
	expect((await run("logs", 1)).logs).toEqual({
		status: "available",
		raw: "2026-01-01T00:00:01.000Z ##[error]exit 1\r\n",
	});
	for (const id of [404, 410])
		expect((await run("logs", id)).logs?.status).toBe("unavailable");
});

test("permission, auth and rate-limit errors never become unavailable", async () => {
	expect((await run("logs", 403)).error?._tag).toBe("GitCommandError");
	expect((await run("logs", 401)).error?._tag).toBe("GhNotAuthenticated");
	expect((await run("logs", 429)).error?._tag).toBe("GhRateLimited");
});

test("re-run uses POST and reports permission failures", async () => {
	expect((await run("rerun", 1)).ok).toBe(true);
	expect((await run("rerun", 403)).error?._tag).toBe("GitCommandError");
});
