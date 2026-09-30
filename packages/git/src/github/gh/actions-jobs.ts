import { Effect, Option, Schema } from "effect";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	GitCommandError,
} from "../../errors.ts";
import { ghResult } from "../../exec.ts";
import type {
	ActionsJobInput,
	ActionsJobLogs,
	RerunActionsJobInput,
} from "../models.ts";
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

export function findRerunActionsJob(
	jobs: readonly { id: number; name: string }[],
	oldJob: { id: number; name: string },
): number | null {
	const job = jobs.find(
		(candidate) => candidate.name === oldJob.name && candidate.id !== oldJob.id,
	);
	return job === undefined ? null : job.id;
}

const JobsPage = Schema.Struct({
	jobs: Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String })),
});

const pollRerunActionsJob = (
	input: RerunActionsJobInput,
	oldJob: { id: number; name: string },
) =>
	Effect.gen(function* () {
		const args = [
			"api",
			"--paginate",
			"--slurp",
			`repos/${input.owner}/${input.repo}/actions/runs/${input.runId}/jobs?filter=latest&per_page=100`,
		];
		while (true) {
			const result = yield* ghResult(input.repoRoot, args);
			if (result.exitCode !== 0) return yield* failure(input, args, result);
			const pages = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(Schema.Array(JobsPage)),
			)(result.stdout).pipe(
				Effect.mapError(
					(cause) =>
						new GhOutputDecodeError({
							command: "gh api actions/runs/jobs",
							raw: result.stdout,
							cause,
						}),
				),
			);
			const jobId = findRerunActionsJob(
				pages.flatMap((page) => page.jobs),
				oldJob,
			);
			if (jobId !== null) return jobId;
			yield* Effect.sleep("1 second");
		}
	});

export const rerunActionsJob = (input: RerunActionsJobInput) =>
	Effect.gen(function* () {
		const oldJob = yield* getActionsJob(input);
		const args = ["api", "-X", "POST", `${endpoint(input)}/rerun`];
		const result = yield* ghResult(input.repoRoot, args);
		if (result.exitCode !== 0) return yield* failure(input, args, result);
		const found = yield* pollRerunActionsJob(input, oldJob).pipe(
			Effect.timeoutOption("10 seconds"),
		);
		return Option.isSome(found) ? found.value : null;
	});
