import { homedir } from "node:os";
import { join } from "node:path";
import { isDefinedError, safe } from "@orpc/client";
import {
	makeSidecarClient,
	type OpenSessionTarget,
	type Session,
} from "@repo/sidecar-api";
import { Config, Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { launchApp } from "./app-launch.ts";

/**
 * Per-POST-attempt timeout — long enough for a live sidecar, short enough that a dead one
 * never hangs the CLI. A dead sidecar still fails near-instantly regardless of this value
 * (connection refused doesn't wait for the abort timer), so raising it only costs time in
 * the genuinely-broken case.
 *
 * `sessions.open` shells out to `gh repo view` and `gh pr view` concurrently (see
 * `resolveReviewTarget`) — two real network round trips to GitHub's API, measured at
 * ~1.2-2.5s combined when run sequentially, so comfortably under this budget even run one
 * at a time. This value doesn't need to be exact, though: crossing it no longer misreads a
 * live sidecar as dead — see `isOwnTimeout` — it only decides how long a single poll
 * iteration waits before trying again.
 */
const POST_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 300;

/**
 * How long to wait for a freshly-launched app to boot its sidecar before
 * giving up. A compiled release app launches in low single-digit seconds, so
 * 15s has real headroom — overridable for a slow machine (or a `tauri dev`
 * cold boot, which is far slower than the compiled release app this is tuned
 * for).
 */
const pollTimeoutConfig = Config.number("NISI_LAUNCH_TIMEOUT_MS").pipe(
	Config.withDefault(15_000),
);

const SidecarHandshake = Schema.Struct({
	port: Schema.Number,
	token: Schema.String,
});

/** Same default as the sidecar's own handshake file — see `apps/desktop/sidecar/index.ts`. */
const dataDirConfig = Config.string("NISI_DATA_DIR").pipe(
	Config.withDefault(
		join(homedir(), "Library", "Application Support", "com.nisi.desktop"),
	),
);

/**
 * Same `<dataDir>/logs/sidecar.log` the sidecar itself writes to (see
 * `apps/desktop/sidecar/logging.ts`) — the CLI never writes this file
 * itself, it only needs the path to point the user at it when a handoff
 * doesn't go the way they expected.
 */
export const logFilePathConfig = dataDirConfig.pipe(
	Effect.map((dataDir) => join(dataDir, "logs", "sidecar.log")),
);

export type HandoffOutcome =
	| { readonly _tag: "opened"; readonly session: Session }
	| { readonly _tag: "rejected"; readonly message: string }
	| { readonly _tag: "unreachable" }
	| { readonly _tag: "unresponsive" }
	| { readonly _tag: "launchFailed"; readonly reason: string };

/**
 * `AbortSignal.timeout()` rejects `fetch` with a `TimeoutError` `DOMException` — distinct from
 * every other network failure (connection refused, DNS, etc.), which surface as a plain `Error`.
 * That's the one signal available for telling "our own deadline elapsed" apart from "nothing's
 * listening": the former means a socket accepted the connection and the sidecar just hasn't
 * answered yet, the latter means there's no sidecar to answer at all.
 */
const isOwnTimeout = (error: unknown): boolean =>
	error instanceof DOMException && error.name === "TimeoutError";

/** A missing or mid-write `sidecar.json` is worth one more poll, not a hard failure — mirrors Rust's `wait_for_sidecar_json`. */
const readHandshake = (sidecarJsonPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const exists = yield* fs.exists(sidecarJsonPath);
		if (!exists) {
			yield* Effect.logDebug("sidecar.json not found", { sidecarJsonPath });
			return undefined;
		}
		const raw = yield* fs.readFileString(sidecarJsonPath);
		const handshake = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(SidecarHandshake)(JSON.parse(raw)),
			catch: () => undefined,
		});
		yield* Effect.logDebug("read sidecar.json", {
			sidecarJsonPath,
			port: handshake?.port,
		});
		return handshake;
	}).pipe(
		Effect.tapError((cause) =>
			Effect.logDebug("sidecar.json unreadable/malformed", {
				sidecarJsonPath,
				cause,
			}),
		),
		Effect.orElseSucceed(() => undefined),
	);

/**
 * One attempt against whatever's on disk right now. `safe()` tells a real
 * response from the sidecar (a declared contract error or success — either
 * way the sidecar is alive) apart from a transport-level failure. The latter
 * splits two ways: a connection failure (`unreachable`) means no sidecar to
 * answer at all, so it's the only case that should trigger spawning the app;
 * our own abort (`unresponsive`) means a live sidecar just hasn't answered
 * yet, which a second app instance would do nothing to fix.
 */
const attempt = (
	sidecarJsonPath: string,
	cwd: string,
	target: OpenSessionTarget,
): Effect.Effect<HandoffOutcome, never, FileSystem> =>
	Effect.gen(function* () {
		const handshake = yield* readHandshake(sidecarJsonPath);
		if (handshake === undefined) {
			return { _tag: "unreachable" } as const;
		}

		yield* Effect.logDebug("POSTing sessions.open", {
			port: handshake.port,
			cwd,
			target,
		});

		const client = makeSidecarClient(handshake);
		const result = yield* Effect.promise(() =>
			safe(
				client.sessions.open(
					{ cwd, target },
					{ signal: AbortSignal.timeout(POST_TIMEOUT_MS) },
				),
			),
		);

		if (result.isSuccess) {
			yield* Effect.logDebug("sessions.open succeeded", {
				port: handshake.port,
				sessionId: result.data.id,
			});
			return { _tag: "opened", session: result.data } as const;
		}
		if (isDefinedError(result.error)) {
			yield* Effect.logDebug("sessions.open rejected", {
				port: handshake.port,
				message: result.error.message,
			});
			return { _tag: "rejected", message: result.error.message } as const;
		}
		if (isOwnTimeout(result.error)) {
			yield* Effect.logDebug("sessions.open classified as unresponsive", {
				port: handshake.port,
			});
			return { _tag: "unresponsive" } as const;
		}
		yield* Effect.logDebug("sessions.open classified as unreachable", {
			port: handshake.port,
			error: String(result.error),
		});
		return { _tag: "unreachable" } as const;
	});

/** Keeps retrying through either flavor of "no answer yet" — only a conclusive outcome ends the poll early. */
const pollUntilReachable = (
	sidecarJsonPath: string,
	cwd: string,
	target: OpenSessionTarget,
	deadline: number,
): Effect.Effect<HandoffOutcome, never, FileSystem> =>
	Effect.gen(function* () {
		const outcome = yield* attempt(sidecarJsonPath, cwd, target);
		const conclusive = outcome._tag === "opened" || outcome._tag === "rejected";
		if (conclusive || Date.now() >= deadline) {
			return outcome;
		}
		yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`);
		return yield* pollUntilReachable(sidecarJsonPath, cwd, target, deadline);
	});

/** Everything up to "is there a session?" — deliberately says nothing about which window is in front. */
const openSession = (
	sidecarJsonPath: string,
	cwd: string,
	target: OpenSessionTarget,
): Effect.Effect<
	HandoffOutcome,
	never,
	FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const first = yield* attempt(sidecarJsonPath, cwd, target);
		if (first._tag === "opened" || first._tag === "rejected") {
			return first;
		}

		const pollTimeoutMs = yield* pollTimeoutConfig.pipe(Effect.orDie);

		// A live sidecar that just hasn't answered yet is not a dead app —
		// spawning a second instance wouldn't fix a slow answer, so skip
		// straight to polling the same one instead of `launchApp`.
		if (first._tag === "unresponsive") {
			return yield* pollUntilReachable(
				sidecarJsonPath,
				cwd,
				target,
				Date.now() + pollTimeoutMs,
			);
		}

		const launched = yield* Effect.match(launchApp, {
			onFailure: (error) =>
				({ _tag: "launchFailed", reason: error.reason }) as const,
			onSuccess: () => undefined,
		});
		if (launched !== undefined) {
			return launched;
		}

		return yield* pollUntilReachable(
			sidecarJsonPath,
			cwd,
			target,
			Date.now() + pollTimeoutMs,
		);
	});

/**
 * The seam (see apps/desktop/AGENTS.md's "The seam" section): read
 * `sidecar.json` and POST; if nothing answers, spawn the app detached, then
 * poll the same file/POST pair until the newly-booted sidecar responds or we
 * give up. Always the same POST either way, so the app has exactly one
 * ingest path rather than one for argv-at-boot and another for a running
 * instance. `target` is the CLI's own `nisi`/`nisi pr`/`nisi diff [<base>]`
 * selection (`packages/cli/src/index.ts`), passed straight through to
 * `sessions.open` — this module doesn't interpret it.
 *
 * Only the cold-start path (`openSession`'s `launchApp` call) brings a window
 * forward from here — an already-running app focuses itself on receiving the
 * `session-opened` event it just got POSTed (`pr-data.ts`'s `useSessions`),
 * since that event, unlike `launchApp`, always names the right app: a second
 * `open -a` here would have no way to tell a dev sandbox instance from a
 * production install (see `app-launch.ts`'s doc comment).
 */
export const handoff = (
	cwd: string,
	target: OpenSessionTarget,
): Effect.Effect<
	HandoffOutcome,
	never,
	FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const dataDir = yield* dataDirConfig.pipe(Effect.orDie);
		const sidecarJsonPath = join(dataDir, "sidecar.json");
		yield* Effect.logDebug("resolved data dir", {
			dataDir,
			sidecarJsonPath,
			logFile: join(dataDir, "logs", "sidecar.log"),
		});

		return yield* openSession(sidecarJsonPath, cwd, target);
	});
