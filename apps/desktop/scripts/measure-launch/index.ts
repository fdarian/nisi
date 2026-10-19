import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { makeLaunchTracer } from "@repo/logging";
import type { LaunchRecord } from "@repo/sidecar-api";
import { Cause, Console, Effect, Exit, Logger, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	summarizeMemoryRuns,
	summarizeMilestones,
	summarizeSoakRuns,
} from "./aggregate.ts";
import { formatBuild, readBuildStamp } from "./build.ts";
import { formatCli, prepareCli } from "./cli.ts";
import {
	formatWorktree,
	launchDeepLinkInstance,
	parseMeasurementPr,
	runDeepLink,
	validateDeepLinkTargets,
	withDeepLinkWorktreeCleanup,
} from "./deeplink.ts";
import {
	formatAlreadyOpen,
	formatTimeline,
	formatVisibility,
	milestoneOffsets,
} from "./format.ts";
import {
	bundlePath,
	coldDataDir,
	liveInstance,
	newPrDataDir,
	prepareColdInstance,
	runningInstance,
	soakDir,
	unavailableAppPath,
} from "./instance.ts";
import { formatMemory, type MemorySummary, sampleMemory } from "./memory.ts";
import { resolveWarmup } from "./new-pr.ts";
import { parseLaunchOptions } from "./options.ts";
import { waitForPrIndex } from "./pr-index.ts";
import { runTracedOpen } from "./run.ts";
import {
	formatMemoryStats,
	formatMilestoneStats,
	formatSoakStats,
} from "./runs-report.ts";
import {
	formatSoak,
	type SoakSeries,
	soakCsv,
	summarizePhases,
} from "./soak.ts";
import { runSoakScenario, startSoakRecorder } from "./soak-run.ts";

type Options = ReturnType<typeof parseLaunchOptions>;

type DeepLinkPlan = {
	target: ReturnType<typeof parseMeasurementPr>;
	warmup: ReturnType<typeof parseMeasurementPr> | undefined;
	extraPrUrls: string[];
};

type RunOutput = {
	kind: "deeplink" | "plain";
	/** Printed above the timeline, or on stderr with `--json`. */
	header: string;
	records: LaunchRecord[];
	memory: MemorySummary | undefined;
	soak: SoakSeries | undefined;
	soakReport: { prs: string[]; csvPath: string } | undefined;
};

const planDeepLink = (options: Options, deeplink: string) =>
	Effect.try((): DeepLinkPlan => {
		const target = parseMeasurementPr(deeplink);
		const warmup =
			options.warmup === undefined
				? undefined
				: parseMeasurementPr(options.warmup);
		validateDeepLinkTargets(target, warmup);
		const extraPrUrls = options.soakPrs.map((raw, index) => {
			const pr = parseMeasurementPr(raw);
			validateDeepLinkTargets(target, pr);
			if (
				options.soakPrs
					.slice(0, index)
					.some((earlier) => parseMeasurementPr(earlier).number === pr.number)
			)
				throw new Error(`--soak-prs lists #${pr.number} twice`);
			return pr.url;
		});
		return { target, warmup, extraPrUrls };
	});

const measureDeepLink = (
	options: Options,
	plan: DeepLinkPlan,
	prepare: { rebuild: boolean; resetCold: boolean },
) =>
	Effect.gen(function* () {
		const target = plan.target;
		const warmup = plan.warmup;
		const extraPrs = plan.extraPrUrls.map((url) => ({
			url,
			traceId: crypto.randomUUID(),
		}));
		const dataDir = yield* prepareColdInstance(
			prepare.rebuild,
			options.newPr,
			prepare.resetCold,
		);
		const traceId = crypto.randomUUID();
		const warmupId = crypto.randomUUID();
		// Sampled inside the scope: its cleanup stops the app when it created a worktree.
		const measured = yield* Effect.scoped(
			Effect.gen(function* () {
				yield* withDeepLinkWorktreeCleanup(options.cwd, dataDir, [
					warmupId,
					traceId,
					...extraPrs.map((pr) => pr.traceId),
				]);
				const recorder = options.soak
					? yield* startSoakRecorder(options.soakIntervalMs)
					: undefined;
				const startedAt = Date.now();
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
				if (options.waitPrIndex) {
					const sessions = yield* Effect.tryPromise(() =>
						client.sessions.list(),
					);
					const session = sessions[0];
					if (session === undefined)
						return yield* Effect.fail(
							new Error(
								"index-hit deep-link measurement requires a warm-up session",
							),
						);
					yield* Effect.tryPromise(() =>
						client.sessions.setAttention({
							sessionId: session.id,
							watched: true,
						}),
					);
					yield* waitForPrIndex(dataDir, startedAt);
				}
				const records = yield* runDeepLink({
					dataDir,
					traceId,
					url: target.url,
					label: "Measured deep link",
				});
				if (recorder !== undefined) {
					yield* runSoakScenario({
						client,
						dataDir,
						recorder,
						idleMs: options.soakIdleMs,
						extraPrs,
					});
					return { records, memory: undefined, soak: recorder.finish() };
				}
				const memory = options.memory
					? yield* sampleMemory(options.memorySettleMs)
					: undefined;
				return { records, memory, soak: undefined };
			}),
		);
		const records = measured.records;
		const soak = measured.soak;
		const fs = yield* FileSystem;
		const soakCsvPath = join(soakDir, `${traceId}.csv`);
		if (soak !== undefined) {
			yield* fs.makeDirectory(soakDir, { recursive: true });
			yield* fs.writeFileString(soakCsvPath, soakCsv(soak.samples));
		}
		const stamp = yield* readBuildStamp(bundlePath);
		const worktreeHeader = yield* Effect.try(() => formatWorktree(records));
		const header = `${options.newPr ? `new PR into running app (warm-up: ${warmup?.url})` : "app startup"} — deep-link frontend injection\nCLI: n/a\nExcludes OS URL delivery and native plugin hop; cold delivery waits for the events stream, later than plugin getCurrent.\n${stamp === undefined ? "Build stamp unavailable" : formatBuild(stamp)}\n${worktreeHeader}`;
		return {
			kind: "deeplink",
			header,
			records,
			memory: measured.memory,
			soak,
			soakReport:
				soak === undefined
					? undefined
					: {
							prs: [target.url, ...extraPrs.map((pr) => pr.url)],
							csvPath: soakCsvPath,
						},
		} satisfies RunOutput;
	});

const measurePlain = (
	options: Options,
	prepare: { rebuild: boolean; resetCold: boolean },
) =>
	Effect.gen(function* () {
		const warmupLabel =
			options.warmup === undefined
				? undefined
				: yield* resolveWarmup(options.cwd, options.warmup);
		const managed = options.cold || options.newPr;
		const dataDir = yield* managed
			? prepareColdInstance(prepare.rebuild, options.newPr, prepare.resetCold)
			: runningInstance;
		const fs = yield* FileSystem;
		const cli = yield* prepareCli(managed);
		const startedAt = managed
			? Date.now()
			: yield* fs
					.stat(join(dataDir, "sidecar.json"))
					.pipe(
						Effect.flatMap((stat) =>
							Option.isSome(stat.mtime)
								? Effect.succeed(stat.mtime.value.getTime())
								: Effect.fail(
										new Error("sidecar handshake has no start timestamp"),
									),
						),
					);
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
				cliPath: cli.path,
			});
		if (options.waitPrIndex) {
			yield* waitForPrIndex(dataDir, startedAt);
			yield* Console.log(
				"Warm-up PR index populated (target hit must still be confirmed in trace)",
			);
		}
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
			cliPath: cli.path,
		});
		const label =
			warmupLabel === undefined
				? options.cold
					? "app startup"
					: "running-instance quick check"
				: `new PR into running app (warm-up: ${warmupLabel})`;
		const stamp =
			dataDir === coldDataDir || dataDir === newPrDataDir
				? yield* readBuildStamp(bundlePath)
				: undefined;
		const memory = options.memory
			? yield* sampleMemory(options.memorySettleMs)
			: undefined;
		return {
			kind: "plain",
			header: `${label}\n${stamp === undefined ? "Build stamp unavailable for this instance" : formatBuild(stamp)}\n${formatCli(cli)}`,
			records,
			memory,
			soak: undefined,
			soakReport: undefined,
		} satisfies RunOutput;
	});

/** The per-run JSON shape, which `--runs` repeats unchanged under `runs`. */
const runPayload = (options: Options, output: RunOutput) => {
	if (output.soak !== undefined && output.soakReport !== undefined)
		return {
			records: output.records,
			soak: {
				intervalMs: options.soakIntervalMs,
				idleMs: options.soakIdleMs,
				prs: output.soakReport.prs,
				csv: output.soakReport.csvPath,
				...output.soak,
				summary: summarizePhases(output.soak),
			},
		};
	return output.memory === undefined
		? output.records
		: { records: output.records, memory: output.memory };
};

const soakNote = (options: Options, report: { prs: string[] }) =>
	`Soak PRs: ${report.prs.join(", ")}; idle ${options.soakIdleMs / 1000}s per idle phase`;

const printSingleRun = (options: Options, output: RunOutput) =>
	Effect.gen(function* () {
		if (options.json) {
			yield* Console.error(output.header);
			yield* Console.log(JSON.stringify(runPayload(options, output), null, 2));
			if (output.kind === "plain") {
				const alreadyOpen = formatAlreadyOpen(output.records);
				if (alreadyOpen !== undefined) yield* Console.error(alreadyOpen);
				const visibility = formatVisibility(output.records, Date.now());
				if (visibility !== undefined) yield* Console.error(visibility);
			}
			return;
		}
		const soakText =
			output.soak === undefined || output.soakReport === undefined
				? ""
				: `\n\n${formatSoak(output.soak, options.soakIntervalMs)}\n${soakNote(options, output.soakReport)}\nCSV: ${output.soakReport.csvPath}`;
		yield* Console.log(
			`${output.header}\n\n${formatTimeline(output.records)}${output.memory === undefined ? "" : `\n\n${formatMemory(output.memory)}`}${soakText}`,
		);
	});

type RunFailure = { run: number; error: string };

const firstRunNote =
	"The first run after a fresh build is slower (first launch of new binaries); --discard-first drops run 1 from the summary.";

/**
 * Runs the measurement `runs` times, each from a stopped app and an empty cold data
 * dir. A failed run is reported and left out of the summary; only all runs failing
 * (or none left after `--discard-first`) fails the command.
 */
const measureRepeatedly = <R>(
	options: Options,
	runs: number,
	measure: (prepare: {
		rebuild: boolean;
		resetCold: boolean;
	}) => Effect.Effect<RunOutput, unknown, R>,
) =>
	Effect.gen(function* () {
		const succeeded: { run: number; output: RunOutput }[] = [];
		const failures: RunFailure[] = [];
		for (let run = 1; run <= runs; run += 1) {
			yield* Console.error(`Run ${run}/${runs}`);
			const exit = yield* Effect.exit(
				measure({ rebuild: options.rebuild && run === 1, resetCold: true }),
			);
			if (Exit.isSuccess(exit)) {
				succeeded.push({ run, output: exit.value });
				yield* Console.error(`Run ${run}/${runs}: ok`);
				continue;
			}
			if (Cause.hasInterrupts(exit.cause))
				return yield* Effect.failCause(exit.cause);
			const error = Cause.pretty(exit.cause);
			failures.push({ run, error });
			yield* Console.error(`Run ${run}/${runs} failed: ${error}`);
		}
		if (succeeded.length === 0)
			return yield* Effect.fail(new Error(`All ${runs} runs failed`));
		const counted = options.discardFirst
			? succeeded.filter((entry) => entry.run !== 1)
			: succeeded;
		if (counted.length === 0)
			return yield* Effect.fail(
				new Error("Only run 1 succeeded and --discard-first drops it"),
			);
		const outputs = counted.map((entry) => entry.output);
		const milestones = yield* Effect.try(() =>
			summarizeMilestones(
				outputs.map((output) => milestoneOffsets(output.records)),
			),
		);
		const memory = yield* Effect.try(() => {
			const samples = outputs.flatMap((output) =>
				output.memory === undefined ? [] : [output.memory],
			);
			return samples.length === 0 ? undefined : summarizeMemoryRuns(samples);
		});
		const soak = yield* Effect.try(() => {
			const series = outputs.flatMap((output) =>
				output.soak === undefined ? [] : [output.soak],
			);
			return series.length === 0 ? undefined : summarizeSoakRuns(series);
		});
		const last = succeeded[succeeded.length - 1] as (typeof succeeded)[number];
		const counts = `${runs} requested, ${succeeded.length} succeeded, ${counted.length} in the summary`;
		const discarded = options.discardFirst
			? "Run 1 is dropped from the summary (--discard-first)."
			: firstRunNote;
		if (options.json) {
			yield* Console.error(
				`${last.output.header}\nRuns: ${counts}\n${discarded}`,
			);
			yield* Console.log(
				JSON.stringify(
					{
						runs: succeeded.map((entry) => runPayload(options, entry.output)),
						summary: {
							requested: runs,
							succeeded: succeeded.length,
							runIndexes: succeeded.map((entry) => entry.run),
							countedRunIndexes: counted.map((entry) => entry.run),
							discardedFirst: options.discardFirst,
							failures,
							milestones,
							memory,
							soak,
						},
					},
					null,
					2,
				),
			);
			return;
		}
		const soakReport = last.output.soakReport;
		yield* Console.log(
			[
				last.output.header,
				`Runs: ${counts}. Each run starts from a stopped app and an empty cold data dir.`,
				discarded,
				...failures.map(
					(failure) => `Run ${failure.run} failed: ${failure.error}`,
				),
				"",
				formatMilestoneStats(milestones),
				...(memory === undefined ? [] : ["", formatMemoryStats(memory)]),
				...(soak === undefined || soakReport === undefined
					? []
					: [
							"",
							formatSoakStats(soak),
							soakNote(options, soakReport),
							`CSVs: ${counted.flatMap((entry) => (entry.output.soakReport === undefined ? [] : [entry.output.soakReport.csvPath])).join(", ")}`,
						]),
			].join("\n"),
		);
	});

const program = Effect.gen(function* () {
	const options = yield* Effect.try(() =>
		parseLaunchOptions(process.argv.slice(2)),
	);
	const deeplink = options.deeplink;
	const plan =
		deeplink === undefined ? undefined : yield* planDeepLink(options, deeplink);
	const measure = (prepare: { rebuild: boolean; resetCold: boolean }) =>
		plan === undefined
			? measurePlain(options, prepare)
			: measureDeepLink(options, plan, prepare);
	if (options.runs !== undefined) {
		yield* measureRepeatedly(options, options.runs, measure);
		return;
	}
	const output = yield* measure({
		rebuild: options.rebuild,
		resetCold: false,
	});
	yield* printSingleRun(options, output);
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
