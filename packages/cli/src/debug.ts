import { isDefinedError, safe } from "@orpc/client";
import { makeSidecarClient } from "@repo/sidecar-api/client";
import { readSidecarJson } from "deskkit/sidecar";
import { Console, Effect, Option } from "effect";
import { renderSnapshot } from "./debug-report.ts";
import { dataDirConfig } from "./handoff.ts";

const REQUEST_TIMEOUT_MS = 8_000;

const isOwnTimeout = (error: unknown): boolean =>
	error instanceof DOMException && error.name === "TimeoutError";

/**
 * Same `sidecar.json` discovery as `handoff.ts` (`NISI_DATA_DIR`, else the
 * production data dir) — the token never leaves this process. Unlike a
 * handoff it never launches the app: debugging a sidecar that isn't running
 * has nothing to inspect.
 */
const fetchSnapshot = (sessionId: string | undefined) =>
	Effect.gen(function* () {
		const dataDir = yield* dataDirConfig.pipe(Effect.orDie);
		const handshake = yield* readSidecarJson(dataDir);
		if (handshake === undefined)
			return { _tag: "notRunning", dataDir } as const;
		const client = makeSidecarClient(handshake);
		const result = yield* Effect.promise(() =>
			safe(
				client.diagnostics.snapshot(
					{ sessionId },
					{ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
				),
			),
		);
		if (result.isSuccess)
			return { _tag: "snapshot", snapshot: result.data } as const;
		if (isDefinedError(result.error))
			return {
				_tag: "rejected",
				message: result.error.message,
			} as const;
		if (isOwnTimeout(result.error)) return { _tag: "unresponsive" } as const;
		return { _tag: "notRunning", dataDir } as const;
	});

export const runDebug = <E>(
	options: {
		readonly session: Option.Option<string>;
		readonly json: boolean;
	},
	fail: Effect.Effect<never, E>,
) =>
	Effect.gen(function* () {
		const outcome = yield* fetchSnapshot(
			Option.getOrUndefined(options.session),
		);
		switch (outcome._tag) {
			case "snapshot":
				return yield* Console.log(
					options.json
						? JSON.stringify(outcome.snapshot, null, 2)
						: renderSnapshot(outcome.snapshot, Date.now()),
				);
			case "rejected":
				yield* Console.error(`Nisi rejected the request: ${outcome.message}`);
				return yield* fail;
			case "unresponsive":
				yield* Console.error(
					"Nisi is running but didn't respond in time. Try again in a moment.",
				);
				return yield* fail;
			case "notRunning":
				yield* Console.error(
					`No running Nisi sidecar found in ${outcome.dataDir}. Start the app, or set NISI_DATA_DIR to target a dev sandbox.`,
				);
				return yield* fail;
		}
	}).pipe(Effect.withSpan("cli.debug"));
