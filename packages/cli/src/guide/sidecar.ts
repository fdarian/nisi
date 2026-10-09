import { join } from "node:path";
import { ORPCError, safe } from "@orpc/client";
import type { SidecarClient } from "@repo/sidecar-api/client";
import { makeSidecarClient } from "@repo/sidecar-api/client";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	dataDirConfig,
	isOwnTimeout,
	POLL_INTERVAL_MS,
	pollTimeoutConfig,
	readHandshake,
} from "../handoff.ts";

/**
 * Longer than `handoff`'s 8s: the first `guide.validate`/`guide.preview` on a
 * sidecar bundles the guide, and a sidecar run from source compiles the whole
 * app stylesheet once.
 */
const CALL_TIMEOUT_MS = 90_000;

export type GuideCallOutcome<A> =
	| { readonly _tag: "ok"; readonly data: A }
	| { readonly _tag: "rejected"; readonly message: string }
	| { readonly _tag: "unreachable"; readonly dataDir: string }
	| { readonly _tag: "unresponsive" }
	| { readonly _tag: "launchFailed"; readonly reason: string };

type Attempt<A> = Exclude<
	GuideCallOutcome<A>,
	{ readonly _tag: "launchFailed" }
>;

const attempt = <A>(
	dataDir: string,
	call: (client: SidecarClient, signal: AbortSignal) => Promise<A>,
): Effect.Effect<Attempt<A>, never, FileSystem> =>
	Effect.gen(function* () {
		const handshake = yield* readHandshake(dataDir);
		if (handshake === undefined)
			return { _tag: "unreachable", dataDir } as const;
		const client = makeSidecarClient(handshake);
		const result = yield* Effect.promise(() =>
			safe(call(client, AbortSignal.timeout(CALL_TIMEOUT_MS))),
		);
		if (result.isSuccess) return { _tag: "ok", data: result.data } as const;
		if (result.error instanceof ORPCError)
			return { _tag: "rejected", message: result.error.message } as const;
		if (isOwnTimeout(result.error)) return { _tag: "unresponsive" } as const;
		return { _tag: "unreachable", dataDir } as const;
	}).pipe(Effect.withSpan("cli.guide.attempt"));

const pollUntilAnswered = <A>(
	dataDir: string,
	call: (client: SidecarClient, signal: AbortSignal) => Promise<A>,
	deadline: number,
): Effect.Effect<Attempt<A>, never, FileSystem> =>
	Effect.gen(function* () {
		const outcome = yield* attempt(dataDir, call);
		const conclusive = outcome._tag !== "unreachable";
		if (conclusive || Date.now() >= deadline) return outcome;
		yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`);
		return yield* pollUntilAnswered(dataDir, call, deadline);
	});

/**
 * Runs one sidecar procedure the way `handoff` opens a session: read
 * `sidecar.json` and call; if nothing answers, launch the app and keep trying
 * until its sidecar does. `NISI_DATA_DIR` picks which sidecar, as everywhere
 * else in the CLI.
 */
export const callGuideSidecar = <A>(
	call: (client: SidecarClient, signal: AbortSignal) => Promise<A>,
): Effect.Effect<
	GuideCallOutcome<A>,
	never,
	FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const dataDir = yield* dataDirConfig.pipe(Effect.orDie);
		const first = yield* attempt(dataDir, call);
		if (first._tag !== "unreachable") return first;

		const pollTimeoutMs = yield* pollTimeoutConfig.pipe(Effect.orDie);
		const app = yield* Effect.promise(() => import("../app-launch.ts"));
		const launched = yield* Effect.match(app.launchApp, {
			onFailure: (error) =>
				({ _tag: "launchFailed", reason: error.reason }) as const,
			onSuccess: () => undefined,
		});
		if (launched !== undefined) return launched;
		return yield* pollUntilAnswered(dataDir, call, Date.now() + pollTimeoutMs);
	});

/** One user-facing line for an outcome that isn't `ok`. */
export const describeGuideFailure = (
	outcome: Exclude<GuideCallOutcome<unknown>, { readonly _tag: "ok" }>,
): string => {
	switch (outcome._tag) {
		case "rejected":
			return outcome.message;
		case "unresponsive":
			return "Nisi is running but didn't respond in time. Try again in a moment.";
		case "launchFailed":
			return `Could not start Nisi: ${outcome.reason}`;
		case "unreachable":
			return `Timed out waiting for Nisi to start (data dir ${outcome.dataDir}; sidecar log ${join(outcome.dataDir, "logs", "sidecar.log")}). On a dev build, point NISI_DATA_DIR at the dev sandbox.`;
	}
};
