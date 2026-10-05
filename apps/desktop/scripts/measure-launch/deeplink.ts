import { launchTracePath, makeLaunchTracer } from "@repo/logging";
import { LaunchRecord } from "@repo/sidecar-api";
import { Console, Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	bundlePath,
	liveInstance,
	requireInstrumentation,
} from "./instance.ts";
import { stopBundle } from "./processes.ts";
import { windowWentHidden } from "./run.ts";

export function parseMeasurementPr(raw: string) {
	const url = new URL(raw);
	const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.username !== "" ||
		url.password !== "" ||
		match === null ||
		Number(match[3]) <= 0
	)
		throw new Error("Expected https://github.com/<owner>/<repo>/pull/<number>");
	const owner = match[1];
	const repo = match[2];
	if (owner === undefined || repo === undefined)
		throw new Error("PR URL has no repository");
	return { owner, repo, number: Number(match[3]), url: url.href };
}

export function validateDeepLinkTargets(
	target: ReturnType<typeof parseMeasurementPr>,
	warmup?: ReturnType<typeof parseMeasurementPr>,
): void {
	if (warmup === undefined) return;
	if (
		target.owner.toLowerCase() !== warmup.owner.toLowerCase() ||
		target.repo.toLowerCase() !== warmup.repo.toLowerCase()
	)
		throw new Error(
			"Warm-up and target URLs must identify the same repository",
		);
	if (target.number === warmup.number)
		throw new Error("Warm-up and target identify the same PR");
}

export const readTrace = (dataDir: string, traceId: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const file = launchTracePath(dataDir, traceId);
		if (!(yield* fs.exists(file))) return [] as LaunchRecord[];
		const text = yield* fs.readFileString(file);
		return yield* Effect.forEach(text.split("\n").slice(0, -1), (line) =>
			Schema.decodeUnknownEffect(Schema.fromJsonString(LaunchRecord))(line),
		);
	});

const awaitInstance = (dataDir: string) =>
	Effect.gen(function* () {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const instance = yield* liveInstance(dataDir);
			if (instance.live) {
				yield* requireInstrumentation(instance.client);
				return instance.client;
			}
			yield* Effect.sleep("100 millis");
		}
		return yield* Effect.fail(
			new Error("Timed out waiting for the managed deep-link instance"),
		);
	});

export const launchDeepLinkInstance = (dataDir: string, traceId: string) =>
	Effect.gen(function* () {
		const exporter = yield* makeLaunchTracer({ dataDir, source: "cli" });
		yield* exporter.activate(traceId);
		yield* exporter.append(traceId, [
			{
				type: "mark",
				source: "cli",
				name: "measurement.app-launch.start",
				at: Date.now(),
				attrs: {},
			},
		]);
		// Only an explicit bundle path is ever given to LaunchServices, never a URL.
		const child = yield* Effect.try(() =>
			Bun.spawn(
				[
					"open",
					"-n",
					"--env",
					`NISI_DATA_DIR=${dataDir}`,
					"--env",
					"NISI_MEASUREMENT_INSTANCE=1",
					"-a",
					bundlePath,
				],
				{ stdout: "ignore", stderr: "inherit" },
			),
		);
		const exit = yield* Effect.tryPromise(() => child.exited);
		if (exit !== 0)
			return yield* Effect.fail(
				new Error(`Managed app launch failed with ${exit}`),
			);
		return yield* awaitInstance(dataDir);
	});

export const runDeepLink = (options: {
	dataDir: string;
	traceId: string;
	url: string;
	label: string;
}) =>
	Effect.gen(function* () {
		const client = yield* awaitInstance(options.dataDir);
		const link = new URL("nisi://open");
		link.searchParams.set("url", options.url);
		yield* Effect.tryPromise(() =>
			client.diagnostics.injectDeepLink({
				url: link.href,
				traceId: options.traceId,
			}),
		);
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const records = yield* readTrace(options.dataDir, options.traceId);
			if (windowWentHidden(records))
				return yield* Effect.fail(
					new Error(
						`${options.label}: window went hidden; stop and bring the measurement window forward. Trace: ${launchTracePath(options.dataDir, options.traceId)}`,
					),
				);
			if (records.some((record) => record.name === "deeplink.needs-repo-path"))
				return yield* Effect.fail(
					new Error(
						`${options.label}: needs-repo-path despite seeded mapping; folder picker suppressed`,
					),
				);
			if (records.some((record) => record.name === "trace.done"))
				return records;
			yield* Effect.sleep("100 millis");
		}
		return yield* Effect.fail(
			new Error(
				`${options.label}: timed out waiting for trace.done; keep window visible. Trace: ${launchTracePath(options.dataDir, options.traceId)}`,
			),
		);
	});

export function worktreePaths(porcelain: string): string[] {
	return porcelain
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice(9));
}

export function createdWorktrees(
	before: readonly string[],
	after: readonly string[],
	records: readonly LaunchRecord[],
): string[] {
	const added = records
		.filter(
			(record) =>
				record.type === "span" &&
				record.name === "subprocess" &&
				record.attrs.exitCode === 0,
		)
		.flatMap((record) => {
			const args = record.attrs.args;
			return Array.isArray(args) &&
				args[0] === "worktree" &&
				args[1] === "add" &&
				typeof args[2] === "string"
				? [args[2]]
				: [];
		});
	return after.filter((path) => !before.includes(path) && added.includes(path));
}

const snapshot = (cwd: string) =>
	Effect.tryPromise(() =>
		Bun.$`git worktree list --porcelain`.cwd(cwd).text(),
	).pipe(Effect.map(worktreePaths));

export const withDeepLinkWorktreeCleanup = (
	cwd: string,
	dataDir: string,
	traceIds: readonly string[],
) =>
	Effect.acquireRelease(snapshot(cwd), (before) =>
		Effect.gen(function* () {
			const records = (yield* Effect.forEach(traceIds, (id) =>
				readTrace(dataDir, id),
			)).flat();
			const created = createdWorktrees(before, yield* snapshot(cwd), records);
			if (created.length > 0) yield* stopBundle(bundlePath);
			for (const path of created) {
				yield* Console.error(
					`Removing worktree created by this measurement: ${path}`,
				);
				yield* Effect.tryPromise(() =>
					Bun.$`git worktree remove ${path}`.cwd(cwd).quiet(),
				);
			}
		}).pipe(Effect.orDie),
	);
