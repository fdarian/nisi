import { BunRuntime, BunServices } from "@effect/platform-bun";
import { makeLaunchTracer } from "@repo/logging";
import { Console, Effect, Logger } from "effect";
import { FileSystem } from "effect/FileSystem";
import { formatBuild, readBuildStamp } from "./build.ts";
import {
	formatAlreadyOpen,
	formatTimeline,
	formatVisibility,
} from "./format.ts";
import {
	bundlePath,
	coldDataDir,
	liveInstance,
	newPrDataDir,
	prepareColdInstance,
	runningInstance,
	unavailableAppPath,
} from "./instance.ts";
import { resolveWarmup } from "./new-pr.ts";
import { parseLaunchOptions } from "./options.ts";
import { runTracedOpen } from "./run.ts";
import {
	launchDeepLinkInstance,
	parseMeasurementPr,
	runDeepLink,
	validateDeepLinkTargets,
	withDeepLinkWorktreeCleanup,
} from "./deeplink.ts";

const program = Effect.gen(function* () {
	const options = yield* Effect.try(() =>
		parseLaunchOptions(process.argv.slice(2)),
	);
	if (options.deeplink !== undefined) {
		const target = yield* Effect.try(() =>
			parseMeasurementPr(options.deeplink as string),
		);
		const warmup =
			options.warmup === undefined
				? undefined
				: yield* Effect.try(() => parseMeasurementPr(options.warmup as string));
		yield* Effect.try(() => validateDeepLinkTargets(target, warmup));
		const dataDir = yield* prepareColdInstance(options.rebuild, options.newPr);
		const traceId = crypto.randomUUID();
		const warmupId = crypto.randomUUID();
		const records = yield* Effect.scoped(
			Effect.gen(function* () {
				yield* withDeepLinkWorktreeCleanup(options.cwd, dataDir, [
					warmupId,
					traceId,
				]);
				const client = yield* launchDeepLinkInstance(
					dataDir,
					options.newPr ? warmupId : traceId,
				);
				yield* Effect.tryPromise(() =>
					client.pullRequests.recordRepoPath({
						owner: target.owner,
						repo: target.repo,
						path: options.cwd,
					}),
				);
				if (warmup !== undefined)
					yield* runDeepLink({
						dataDir,
						traceId: warmupId,
						url: warmup.url,
						label: "Deep-link warm-up",
					});
				return yield* runDeepLink({
					dataDir,
					traceId,
					url: target.url,
					label: "Measured deep link",
				});
			}),
		);
		const stamp = yield* readBuildStamp(bundlePath);
		const header = `${options.newPr ? `new PR into running app (warm-up: ${warmup?.url})` : "app startup"} — deep-link frontend injection\nExcludes OS URL delivery and native plugin hop; cold delivery waits for the events stream, later than plugin getCurrent.\n${stamp === undefined ? "Build stamp unavailable" : formatBuild(stamp)}`;
		if (options.json) {
			yield* Console.error(header);
			yield* Console.log(JSON.stringify(records, null, 2));
		} else yield* Console.log(`${header}\n\n${formatTimeline(records)}`);
		return;
	}
	const warmupLabel =
		options.warmup === undefined
			? undefined
			: yield* resolveWarmup(options.cwd, options.warmup);
	const managed = options.cold || options.newPr;
	const dataDir = yield* managed
		? prepareColdInstance(options.rebuild, options.newPr)
		: runningInstance;
	const fs = yield* FileSystem;
	if ((options.newPr || !managed) && (yield* fs.exists(unavailableAppPath)))
		return yield* Effect.fail(
			new Error(
				`Remove unexpected app at ${unavailableAppPath}; warm-mode fallback must be disabled`,
			),
		);
	if (options.warmup !== undefined)
		yield* runTracedOpen({
			cwd: options.warmup,
			dataDir,
			traceId: crypto.randomUUID(),
			launch: true,
			managed: true,
			quiet: true,
			label: "Warm-up",
		});
	const traceId = crypto.randomUUID();
	if (!options.cold) {
		const instance = yield* liveInstance(dataDir);
		if (!instance.live)
			return yield* Effect.fail(
				new Error("Selected sidecar stopped before measurement"),
			);
		const sessions = yield* Effect.tryPromise(() =>
			instance.client.sessions.list(),
		);
		const exporter = yield* makeLaunchTracer({ dataDir, source: "cli" });
		yield* exporter.activate(traceId);
		yield* exporter.append(traceId, [
			{
				type: "mark",
				source: "cli",
				name: "measurement.sessions-before-open",
				at: Date.now(),
				attrs: { sessionIds: sessions.map((session) => session.id) },
			},
		]);
	}
	const records = yield* runTracedOpen({
		cwd: options.cwd,
		dataDir,
		traceId,
		launch: options.cold,
		managed,
		quiet: options.json,
		label: "Measured open",
	});
	const header =
		warmupLabel === undefined
			? options.cold
				? "app startup"
				: "running-instance quick check"
			: `new PR into running app (warm-up: ${warmupLabel})`;
	const stamp =
		dataDir === coldDataDir || dataDir === newPrDataDir
			? yield* readBuildStamp(bundlePath)
			: undefined;
	const reportHeader = `${header}\n${stamp === undefined ? "Build stamp unavailable for this instance" : formatBuild(stamp)}`;
	if (options.json) {
		yield* Console.error(reportHeader);
		yield* Console.log(JSON.stringify(records, null, 2));
		const alreadyOpen = formatAlreadyOpen(records);
		if (alreadyOpen !== undefined) yield* Console.error(alreadyOpen);
		const visibility = formatVisibility(records, Date.now());
		if (visibility !== undefined) yield* Console.error(visibility);
	} else yield* Console.log(`${reportHeader}\n\n${formatTimeline(records)}`);
});
BunRuntime.runMain(
	program.pipe(
		Effect.catchCause((cause) =>
			Effect.logError(cause).pipe(Effect.andThen(Effect.failCause(cause))),
		),
		Effect.provide(BunServices.layer),
		Effect.provide(
			Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]),
		),
	),
	{ disableErrorReporting: true },
);
