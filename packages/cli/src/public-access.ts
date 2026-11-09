import { ORPCError } from "@orpc/client";
import type { PublicAccessStatus } from "@repo/sidecar-api";
import type { SidecarClient } from "@repo/sidecar-api/client";
import { makeSidecarClient } from "@repo/sidecar-api/client";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { callGuideSidecar, describeGuideFailure } from "./guide/sidecar.ts";
import { dataDirConfig, isOwnTimeout, readHandshake } from "./handoff.ts";

const REQUEST_TIMEOUT_MS = 8_000;
/** A quick tunnel usually registers within ~10s; cloudflared retries edge connections for a while before giving up. */
const SETTLE_TIMEOUT_MS = 60_000;

const LINK_WARNING =
	"Anyone with this link has full access to Nisi on this Mac. Restarting Nisi invalidates it.";

type Goal = {
	readonly enabled: boolean;
	/** `apply(enabled)` leaves this status alone, so no `public-access-changed` will follow. */
	readonly reached: (status: PublicAccessStatus) => boolean;
	/** Where waiting stops: the goal, or a state the sidecar won't leave on its own. */
	readonly settled: (status: PublicAccessStatus) => boolean;
};

const turnOn: Goal = {
	enabled: true,
	reached: (status) => status.type === "on",
	settled: (status) => status.type === "on" || status.type === "error",
};

const turnOff: Goal = {
	enabled: false,
	reached: (status) => status.type === "off",
	settled: (status) => status.type === "off",
};

/**
 * Subscribes before reading the status so no transition can slip between the
 * read and the listening. A status read right after `settings.update` is never
 * trusted: the sidecar forks `apply` and answers before it runs, so a leftover
 * `error` would read as this attempt's outcome.
 */
async function switchTo(
	client: SidecarClient,
	goal: Goal,
	signal: AbortSignal,
): Promise<PublicAccessStatus> {
	const options = { signal };
	const events = await client.events.subscribe(undefined, options);
	for await (const event of events) {
		if (event.type === "stream-ready") {
			const before = await client.publicAccess.status(undefined, options);
			await client.settings.update(
				{ publicAccessEnabled: goal.enabled },
				options,
			);
			if (goal.reached(before)) return before;
		} else if (event.type === "public-access-changed") {
			const status = await client.publicAccess.status(undefined, options);
			if (goal.settled(status)) return status;
		}
	}
	throw new Error("Nisi closed its event stream.");
}

const runSwitch = <E>(
	client: SidecarClient,
	goal: Goal,
	fail: Effect.Effect<never, E>,
) =>
	Effect.gen(function* () {
		const signal = AbortSignal.timeout(SETTLE_TIMEOUT_MS);
		return yield* Effect.tryPromise({
			try: () => switchTo(client, goal, signal),
			catch: (error) => error,
		}).pipe(
			Effect.catch((error) => {
				if (signal.aborted)
					return Console.error(
						`Public Access didn't settle within ${SETTLE_TIMEOUT_MS / 1000}s. Check \`nisi public-access status\`.`,
					).pipe(Effect.andThen(fail));
				const message = error instanceof Error ? error.message : String(error);
				return Console.error(`Lost contact with Nisi: ${message}`).pipe(
					Effect.andThen(fail),
				);
			}),
		);
	});

type RunningCall<A> =
	| { readonly _tag: "ok"; readonly client: SidecarClient; readonly data: A }
	| { readonly _tag: "notRunning"; readonly dataDir: string }
	| { readonly _tag: "rejected"; readonly message: string }
	| { readonly _tag: "unresponsive" };

/** Like `nisi debug`: a stopped app has no tunnel, so there's nothing to launch it for. */
const callRunning = <A>(
	call: (client: SidecarClient, signal: AbortSignal) => Promise<A>,
) =>
	Effect.gen(function* () {
		const dataDir = yield* dataDirConfig.pipe(Effect.orDie);
		const handshake = yield* readHandshake(dataDir);
		if (handshake === undefined)
			return { _tag: "notRunning", dataDir } as RunningCall<A>;
		const client = makeSidecarClient(handshake);
		return yield* Effect.tryPromise({
			try: () => call(client, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
			catch: (error) => error,
		}).pipe(
			Effect.map((data): RunningCall<A> => ({ _tag: "ok", client, data })),
			Effect.catch((error) =>
				Effect.succeed<RunningCall<A>>(
					error instanceof ORPCError
						? { _tag: "rejected", message: error.message }
						: isOwnTimeout(error)
							? { _tag: "unresponsive" }
							: { _tag: "notRunning", dataDir },
				),
			),
		);
	});

const reportCallFailure = <E>(
	outcome: Exclude<RunningCall<unknown>, { readonly _tag: "ok" }>,
	fail: Effect.Effect<never, E>,
) => {
	switch (outcome._tag) {
		case "notRunning":
			return Console.error(
				`No running Nisi sidecar found in ${outcome.dataDir}. Start the app, or set NISI_DATA_DIR to target a dev sandbox.`,
			).pipe(Effect.andThen(fail));
		case "rejected":
			return Console.error(
				`Nisi rejected the request: ${outcome.message}`,
			).pipe(Effect.andThen(fail));
		case "unresponsive":
			return Console.error(
				"Nisi is running but didn't respond in time. Try again in a moment.",
			).pipe(Effect.andThen(fail));
	}
};

const describeStatus = (status: PublicAccessStatus): string => {
	switch (status.type) {
		case "off":
			return "Off";
		case "starting":
			return "Starting tunnel…";
		case "on":
			return `On: ${status.link}`;
		case "error":
			return `Error: ${status.message}`;
	}
};

export const publicAccessCommand = <E>(fail: Effect.Effect<never, E>) => {
	const status = Command.make(
		"status",
		{
			json: Flag.Boolean("json").pipe(
				Flag.withDescription("Print the raw status as JSON."),
				Flag.withDefault(false),
			),
		},
		(options) =>
			Effect.gen(function* () {
				const outcome = yield* callRunning((client, signal) =>
					client.publicAccess.status(undefined, { signal }),
				);
				if (outcome._tag !== "ok")
					return yield* reportCallFailure(outcome, fail);
				yield* Console.log(
					options.json
						? JSON.stringify(outcome.data)
						: describeStatus(outcome.data),
				);
			}),
	).pipe(
		Command.withDescription(
			"Print whether the tunnel is off, starting, on (with its link) or failed. Never launches the app.",
		),
	);

	const on = Command.make("on", {}, () =>
		Effect.gen(function* () {
			const outcome = yield* callGuideSidecar((client, signal) =>
				client.settings
					.get(undefined, { signal })
					.then((settings) => ({ client, settings })),
			);
			if (outcome._tag !== "ok") {
				yield* Console.error(describeGuideFailure(outcome));
				return yield* fail;
			}
			if (!outcome.data.settings.publicAccessFeatureEnabled) {
				yield* Console.error(
					"Public Access is behind a feature flag. Turn it on in Nisi's Settings → Feature Flags first.",
				);
				return yield* fail;
			}
			const settled = yield* runSwitch(outcome.data.client, turnOn, fail);
			if (settled.type !== "on") {
				yield* Console.error(describeStatus(settled));
				return yield* fail;
			}
			yield* Console.log(settled.link);
			yield* Console.error(LINK_WARNING);
		}),
	).pipe(
		Command.withDescription(
			"Switch Public Access on, wait for the cloudflared tunnel, and print its link (stdout only, so $(nisi public-access on) works). Launches the app if it isn't running. Needs cloudflared and the Public Access feature flag.",
		),
	);

	const off = Command.make("off", {}, () =>
		Effect.gen(function* () {
			const outcome = yield* callRunning((client, signal) =>
				client.publicAccess.status(undefined, { signal }),
			);
			if (outcome._tag !== "ok") return yield* reportCallFailure(outcome, fail);
			yield* runSwitch(outcome.client, turnOff, fail);
			yield* Console.log("Public Access is off. The old link no longer works.");
		}),
	).pipe(
		Command.withDescription(
			"Switch Public Access off and stop the tunnel. Needs the app running.",
		),
	);

	return Command.make("public-access", {}, () =>
		Console.error("Specify one of: status, on, off").pipe(Effect.andThen(fail)),
	).pipe(
		Command.withDescription(
			"Manage Public Access: the cloudflared tunnel that makes this Nisi reachable from any browser. Honors NISI_DATA_DIR.",
		),
		Command.withSubcommands([status, on, off]),
	);
};
