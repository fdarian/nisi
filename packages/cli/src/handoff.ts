import { homedir } from "node:os";
import { join } from "node:path";
import { isDefinedError, safe } from "@orpc/client";
import { makeSidecarClient, type Session } from "@repo/sidecar-api";
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
		if (!exists) return undefined;
		const raw = yield* fs.readFileString(sidecarJsonPath);
		return yield* Effect.try({
			try: () => Schema.decodeUnknownSync(SidecarHandshake)(JSON.parse(raw)),
			catch: () => undefined,
		});
	}).pipe(Effect.orElseSucceed(() => undefined));

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
): Effect.Effect<HandoffOutcome, never, FileSystem> =>
	Effect.gen(function* () {
		const handshake = yield* readHandshake(sidecarJsonPath);
		if (handshake === undefined) {
			return { _tag: "unreachable" } as const;
		}

		const client = makeSidecarClient(handshake);
		const result = yield* Effect.promise(() =>
			safe(
				client.sessions.open(
					{ cwd },
					{ signal: AbortSignal.timeout(POST_TIMEOUT_MS) },
				),
			),
		);

		if (result.isSuccess) {
			return { _tag: "opened", session: result.data } as const;
		}
		if (isDefinedError(result.error)) {
			return { _tag: "rejected", message: result.error.message } as const;
		}
		if (isOwnTimeout(result.error)) {
			return { _tag: "unresponsive" } as const;
		}
		return { _tag: "unreachable" } as const;
	});

/** Keeps retrying through either flavor of "no answer yet" — only a conclusive outcome ends the poll early. */
const pollUntilReachable = (
	sidecarJsonPath: string,
	cwd: string,
	deadline: number,
): Effect.Effect<HandoffOutcome, never, FileSystem> =>
	Effect.gen(function* () {
		const outcome = yield* attempt(sidecarJsonPath, cwd);
		const conclusive = outcome._tag === "opened" || outcome._tag === "rejected";
		if (conclusive || Date.now() >= deadline) {
			return outcome;
		}
		yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`);
		return yield* pollUntilReachable(sidecarJsonPath, cwd, deadline);
	});

/**
 * The seam from `PLAN.md`: read `sidecar.json` and POST; if nothing answers,
 * spawn the app detached, then poll the same file/POST pair until the
 * newly-booted sidecar responds or we give up. Always the same POST either
 * way, so the app has exactly one ingest path rather than one for argv-at-boot
 * and another for a running instance.
 */
export const handoff = (
	cwd: string,
): Effect.Effect<
	HandoffOutcome,
	never,
	FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const dataDir = yield* dataDirConfig.pipe(Effect.orDie);
		const sidecarJsonPath = join(dataDir, "sidecar.json");

		const first = yield* attempt(sidecarJsonPath, cwd);
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
			Date.now() + pollTimeoutMs,
		);
	});
