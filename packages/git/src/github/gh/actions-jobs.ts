import { Effect, Schema } from "effect";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	GitCommandError,
} from "../../errors.ts";
import { ghResult } from "../../exec.ts";
import type { ActionsJobInput, ActionsJobLogs } from "../models.ts";
import { isAuthFailure, isRateLimited } from "./pull-request.ts";

const Step = Schema.Struct({
	number: Schema.Number,
	name: Schema.String,
	status: Schema.String,
	conclusion: Schema.NullOr(Schema.String),
	started_at: Schema.NullOr(Schema.String),
	completed_at: Schema.NullOr(Schema.String),
});
const Job = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	status: Schema.String,
	conclusion: Schema.NullOr(Schema.String),
	html_url: Schema.String,
	started_at: Schema.NullOr(Schema.String),
	completed_at: Schema.NullOr(Schema.String),
	steps: Schema.Array(Step),
});
const failure = (
	input: ActionsJobInput,
	args: readonly string[],
	result: { stdout: string; stderr: string; exitCode: number },
) => {
	if (isAuthFailure(result))
		return new GhNotAuthenticated({ reason: result.stderr.trim() });
	if (isRateLimited(result.stderr))
		return new GhRateLimited({ reason: result.stderr.trim() });
	return new GitCommandError({
		command: "gh",
		args,
		cwd: input.repoRoot,
		exitCode: result.exitCode,
		stderr: result.stderr,
		cause: new Error(result.stderr),
	});
};
const endpoint = (input: ActionsJobInput) =>
	`repos/${input.owner}/${input.repo}/actions/jobs/${input.jobId}`;

export const getActionsJob = (input: ActionsJobInput) =>
	Effect.gen(function* () {
		const args = ["api", endpoint(input)];
		const result = yield* ghResult(input.repoRoot, args);
		if (result.exitCode !== 0) return yield* failure(input, args, result);
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Job))(
			result.stdout,
		).pipe(
			Effect.mapError(
				(cause) =>
					new GhOutputDecodeError({
						command: "gh api actions/jobs",
						raw: result.stdout,
						cause,
					}),
			),
		);
	});

export const getActionsJobLogs = (input: ActionsJobInput) =>
	Effect.gen(function* () {
		// gh rejects ANSI-bearing responses on piped stdout unless explicitly allowed.
		const args = ["api", "--allow-escape-sequences", `${endpoint(input)}/logs`];
		const result = yield* ghResult(input.repoRoot, args);
		if (result.exitCode === 0)
			return {
				status: "available",
				raw: result.stdout,
			} satisfies ActionsJobLogs;
		if (/\bHTTP (404|410)\b/.test(result.stderr))
			return {
				status: "unavailable",
				reason: "Job logs are not available yet or have expired.",
			} satisfies ActionsJobLogs;
		return yield* failure(input, args, result);
	});

export const rerunActionsJob = (input: ActionsJobInput) =>
	Effect.gen(function* () {
		const args = ["api", "-X", "POST", `${endpoint(input)}/rerun`];
		const result = yield* ghResult(input.repoRoot, args);
		if (result.exitCode !== 0) return yield* failure(input, args, result);
	});
