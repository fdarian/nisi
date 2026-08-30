import { join } from "node:path";
import { safe } from "@orpc/client";
import { makeSidecarClient } from "@repo/sidecar-api";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

/** What a second process needs to health-check the current lock holder. */
const LockOwner = Schema.Struct({
	port: Schema.Number,
	token: Schema.String,
});
type LockOwner = typeof LockOwner.Type;

/** How long to wait for a liveness check against a lock's recorded owner before treating it as dead. Local loopback, so failure/success both resolve fast — this only needs to be long enough that a live sidecar under momentary load isn't misread as dead. */
const LIVENESS_CHECK_TIMEOUT_MS = 1_000;

/**
 * A lock file that exists but doesn't parse yet is almost always its own
 * creator's `writeFileString` still landing — `acquireOnce` below creates the
 * file via `wx` and writes its content in the same call, so there's a
 * microscopic window where a concurrent reader can observe 0 (or partial)
 * bytes. This many retries, this far apart, is comfortably more than the
 * sub-millisecond a same-machine small write takes to land.
 */
const READ_RETRY_ATTEMPTS = 5;
const READ_RETRY_DELAY_MS = 20;

/** Bounds the acquire/recover loop so a lock that keeps coming back dead (or a filesystem that's simply broken) fails loudly instead of spinning forever. */
const MAX_ACQUIRE_ATTEMPTS = 5;

/**
 * Refused to boot because another sidecar is already live for this data dir
 * — see `acquireSidecarLock` below.
 */
export class SidecarAlreadyRunning extends Schema.TaggedError<SidecarAlreadyRunning>()(
	"SidecarAlreadyRunning",
	{ port: Schema.Number },
) {}

/** Gave up acquiring the lock after repeatedly finding (and clearing) a dead owner. */
export class LockAcquisitionFailed extends Schema.TaggedError<LockAcquisitionFailed>()(
	"LockAcquisitionFailed",
	{ attempts: Schema.Number },
) {}

const lockPathFor = (dataDir: string) => join(dataDir, "sidecar.lock");
const sidecarJsonPathFor = (dataDir: string) => join(dataDir, "sidecar.json");

const isAlreadyExists = (error: PlatformError): boolean =>
	error.reason._tag === "AlreadyExists";

/**
 * True if `owner`'s sidecar answers `health.check` over the same authed oRPC
 * channel the frontend and CLI use. This — not the lock file's age, and not
 * a PID that might have been reused — is the only way to tell "the process
 * that made this lock crashed" apart from "it's genuinely still running."
 */
const isOwnerAlive = (owner: LockOwner) =>
	Effect.promise(() =>
		safe(
			makeSidecarClient(owner).health.check(undefined, {
				signal: AbortSignal.timeout(LIVENESS_CHECK_TIMEOUT_MS),
			}),
		),
	).pipe(Effect.map((result) => result.isSuccess));

/** Reads and parses the lock file, retrying briefly — see `READ_RETRY_ATTEMPTS`'s doc. `undefined` covers both "gone" and "still unparseable after retrying." */
const readOwner = (
	path: string,
	attemptsLeft: number,
): Effect.Effect<LockOwner | undefined, never, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const raw = yield* fs
			.readFileString(path)
			.pipe(Effect.orElseSucceed(() => undefined));
		if (raw === undefined) return undefined;

		const parsed = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(LockOwner)(JSON.parse(raw)),
			catch: () => undefined,
		}).pipe(Effect.orElseSucceed(() => undefined));
		if (parsed !== undefined) return parsed;

		if (attemptsLeft <= 0) return undefined;
		yield* Effect.sleep(`${READ_RETRY_DELAY_MS} millis`);
		return yield* readOwner(path, attemptsLeft - 1);
	});

/** One `O_EXCL` create attempt. `true` means this call created (and now owns) the file; `false` means someone else already holds it. */
const acquireOnce = (
	path: string,
	owner: LockOwner,
): Effect.Effect<boolean, never, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		return yield* fs
			.writeFileString(path, JSON.stringify(owner), {
				flag: "wx",
				mode: 0o600,
			})
			.pipe(
				Effect.as(true),
				Effect.catchTag("PlatformError", (error) =>
					isAlreadyExists(error) ? Effect.succeed(false) : Effect.die(error),
				),
			);
	});

const acquire = (
	path: string,
	owner: LockOwner,
	attemptsLeft: number,
): Effect.Effect<
	void,
	SidecarAlreadyRunning | LockAcquisitionFailed,
	FileSystem
> =>
	Effect.gen(function* () {
		const created = yield* acquireOnce(path, owner);
		if (created) return;

		if (attemptsLeft <= 0) {
			yield* Effect.logFatal(
				`giving up on the sidecar lock at ${path} after repeatedly finding a dead owner — a filesystem or process problem is likely masking the real error`,
			);
			return yield* new LockAcquisitionFailed({
				attempts: MAX_ACQUIRE_ATTEMPTS,
			});
		}

		const existingOwner = yield* readOwner(path, READ_RETRY_ATTEMPTS);
		if (existingOwner !== undefined) {
			const alive = yield* isOwnerAlive(existingOwner);
			if (alive) {
				yield* Effect.logFatal(
					`refusing to start: another sidecar is already live on port ${existingOwner.port} for this data dir — two sidecars sharing one NISI_DATA_DIR would race over sidecar.json and the SQLite database`,
				);
				return yield* new SidecarAlreadyRunning({ port: existingOwner.port });
			}
			yield* Effect.logDebug(
				`existing sidecar lock (port ${existingOwner.port}) didn't answer — clearing it as a dead owner`,
			);
		} else {
			yield* Effect.logDebug(
				"existing sidecar lock didn't parse even after retrying — clearing it as an unreadable/dead owner",
			);
		}

		const fs = yield* FileSystem;
		yield* fs.remove(path, { force: true }).pipe(Effect.orDie);
		return yield* acquire(path, owner, attemptsLeft - 1);
	});

/**
 * Atomically claims ownership of `dataDir`'s sidecar lock via `wx` (POSIX
 * `O_EXCL`) — the create either succeeds or fails, with no window in between
 * for a second process racing the same open() to also succeed. This closes
 * the gap the old file-based `refuseIfAlreadyRunning` check-then-act left
 * open: two sidecars booting at the same instant could both find no live
 * `sidecar.json`, both proceed, and both write — whichever wrote last "won,"
 * silently splitting the app window and the CLI onto different sidecars.
 *
 * A losing process reads the lock's recorded owner and health-checks it —
 * never a staleness heuristic (file age, a PID that might have been reused)
 * — and, once confirmed dead, clears it and retries. Bounded by
 * `MAX_ACQUIRE_ATTEMPTS` so a lock that keeps coming back dead fails loudly
 * instead of spinning forever.
 *
 * A `SIGKILL`'d owner never runs its release effect (see `releaseSidecarLock`
 * below), so its lock file survives on disk — but that's exactly the case
 * this liveness check exists for: the next boot finds the lock, health-checks
 * the dead port, gets no answer, and recovers the same way it would for any
 * other dead owner.
 */
export const acquireSidecarLock = (
	dataDir: string,
	owner: { readonly port: number; readonly token: string },
): Effect.Effect<
	void,
	SidecarAlreadyRunning | LockAcquisitionFailed,
	FileSystem
> => acquire(lockPathFor(dataDir), owner, MAX_ACQUIRE_ATTEMPTS);

/** Releases the lock acquired by `acquireSidecarLock` — wire this into `Effect.acquireRelease`'s release alongside the resource it guards. */
export const releaseSidecarLock = (
	dataDir: string,
): Effect.Effect<void, never, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		yield* fs.remove(lockPathFor(dataDir), { force: true });
	}).pipe(Effect.orDie);

/**
 * Publishes `sidecar.json` via a temp file in the same directory + `rename()`
 * — rename is atomic on one filesystem, so a reader (Rust's
 * `wait_for_sidecar_json`, the CLI's `readHandshake`) can only ever observe
 * the old content or the new content, never a partial write in between.
 *
 * Safe to call unconditionally, with no existence/staleness check first: a
 * successful `acquireSidecarLock` already proved this process is the data
 * dir's sole legitimate sidecar, so there's nothing to check before
 * overwriting whatever `sidecar.json` currently holds.
 */
export const publishSidecarJson = (
	dataDir: string,
	content: { readonly port: number; readonly token: string },
): Effect.Effect<void, never, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const tmpPath = join(dataDir, `.sidecar.json.tmp-${crypto.randomUUID()}`);
		yield* fs.writeFileString(tmpPath, JSON.stringify(content), {
			mode: 0o600,
		});
		yield* fs.rename(tmpPath, sidecarJsonPathFor(dataDir));
	}).pipe(Effect.orDie);
