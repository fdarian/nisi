import type { makeSidecarClient, WorkloadStep } from "@repo/sidecar-api";
import { Console, Effect } from "effect";
import { runDeepLink } from "./deeplink.ts";
import { sampleMemory } from "./memory.ts";
import type { Shell } from "./shell.ts";
import {
	type SoakPhase,
	type SoakPhaseSpan,
	type SoakSample,
	type SoakSeries,
	toSoakSample,
} from "./soak.ts";

type Client = ReturnType<typeof makeSidecarClient>;

const WORKLOAD_STEP_TIMEOUT_MS = 15 * 60_000;

/**
 * Samples memory on a fixed cadence for as long as the surrounding scope lives,
 * tagging each sample with whatever phase the scenario is in when the read starts.
 * Reads that fail before the first success are expected (the app is still
 * launching); later failures mean a process exited mid-read and are counted.
 */
export const startSoakRecorder = (shell: Shell, intervalMs: number) =>
	Effect.gen(function* () {
		const startedAt = Date.now();
		const samples: SoakSample[] = [];
		const phases: SoakPhaseSpan[] = [
			{ phase: "open", startedAt, endedAt: startedAt },
		];
		const state = { phase: "open" as SoakPhase, skipped: 0 };
		const readOnce = Effect.gen(function* () {
			const at = Date.now();
			const phase = state.phase;
			const summary = yield* sampleMemory(shell, 0);
			samples.push(toSoakSample(summary, phase, at, startedAt));
		}).pipe(
			Effect.catch((error) => {
				if (samples.length === 0) return Effect.void;
				state.skipped += 1;
				return Console.error(`soak: skipped a sample: ${error.message}`);
			}),
		);
		yield* Effect.forkScoped(
			Effect.forever(
				Effect.gen(function* () {
					const began = Date.now();
					yield* readOnce;
					yield* Effect.sleep(
						`${Math.max(0, intervalMs - (Date.now() - began))} millis`,
					);
				}),
			),
		);
		return {
			enter: (phase: SoakPhase) => {
				const now = Date.now();
				const current = phases.at(-1);
				if (current !== undefined) current.endedAt = now;
				phases.push({ phase, startedAt: now, endedAt: now });
				state.phase = phase;
				return Console.error(`soak: phase ${phase}`);
			},
			finish: (): SoakSeries => {
				const current = phases.at(-1);
				if (current !== undefined) current.endedAt = Date.now();
				return { samples, phases, skippedSamples: state.skipped };
			},
		};
	});

export type SoakRecorder = Effect.Success<ReturnType<typeof startSoakRecorder>>;

/** Asks the frontend to perform a step and waits for its acknowledgment. */
export const runWorkloadStep = (client: Client, step: WorkloadStep) =>
	Effect.gen(function* () {
		const id = crypto.randomUUID();
		yield* Effect.tryPromise(() =>
			client.diagnostics.runWorkloadStep({ id, step }),
		);
		const deadline = Date.now() + WORKLOAD_STEP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const status = yield* Effect.tryPromise(() =>
				client.diagnostics.workloadStepStatus({ id }),
			);
			if (status.status === "ok") return;
			if (status.status === "failed")
				return yield* Effect.fail(
					new Error(`Workload step ${step} failed: ${status.error}`),
				);
			yield* Effect.sleep("250 millis");
		}
		return yield* Effect.fail(
			new Error(
				`Workload step ${step} was not acknowledged within ${WORKLOAD_STEP_TIMEOUT_MS}ms`,
			),
		);
	});

/** Runs after the `--deeplink` PR is open (the `open` phase). */
export const runSoakScenario = (options: {
	client: Client;
	dataDir: string;
	recorder: SoakRecorder;
	idleMs: number;
	extraPrs: readonly { url: string; traceId: string }[];
}) =>
	Effect.gen(function* () {
		const recorder = options.recorder;
		yield* recorder.enter("idle-1");
		yield* Effect.sleep(`${options.idleMs} millis`);
		yield* recorder.enter("scroll-1");
		yield* runWorkloadStep(options.client, "scroll-files-changed");
		yield* recorder.enter("extra-tabs");
		for (const [index, pr] of options.extraPrs.entries()) {
			yield* Console.error(
				`soak: opening extra PR ${index + 1}/${options.extraPrs.length} ${pr.url}`,
			);
			yield* runDeepLink({
				dataDir: options.dataDir,
				traceId: pr.traceId,
				url: pr.url,
				label: `Soak PR ${pr.url}`,
			});
			yield* runWorkloadStep(options.client, "scroll-files-changed");
		}
		yield* recorder.enter("after-close");
		yield* runWorkloadStep(options.client, "close-other-tabs");
		yield* Effect.sleep(`${options.idleMs} millis`);
	});
