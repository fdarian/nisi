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
		if (existingOwner !== undefined && existingOwner.port === owner.port) {
			// A TCP port has exactly one owner, and the acquiring process is
			// demonstrably it — it bound `owner.port` before ever calling
			// `acquireSidecarLock` (see index.ts's boot order). So a lock file
			// recording that same port cannot belong to a live *other* process:
			// it's either this process's own previous incarnation, or a
			// `SIGKILL`'d sidecar whose ephemeral port the OS happened to hand
			// back. The former is the common case in dev — `scripts/dev.ts` pins
			// the sidecar port to a devsess sticky port for the whole session (see
			// root `AGENTS.md`'s "The seam"), so this branch fires not just for a
			// `bun --watch` restart mid-run, but for a fresh `bun dev` of the same
			// session after a previous one died without releasing its lock. Either
			// way, health-checking the recorded owner would just be this process
			// interrogating itself — it's already listening on `owner.port` by the
			// time this runs, so `isOwnerAlive` would always answer `true`, even
			// when there's no other owner at all. Skip the check entirely and fall
			// into the same clear-and-retry path a confirmed-dead owner takes.
			// Safe for the `port: 0` case too: an ephemeral rebind onto a port
			// some *other* live process already holds is exceedingly rare, so
			// this branch simply doesn't fire then.
			yield* Effect.logDebug(
				`existing sidecar lock (port ${existingOwner.port}) matches the port this process is already listening on — taking it over without a liveness check`,
			);
		} else if (existingOwner !== undefined) {
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
 * A losing process reads the lock's recorded owner. When it recorded the same
 * port `owner` is claiming, it's taken over without a health check — a TCP
 * port has exactly one owner, and the acquiring process is demonstrably it
 * (see `acquire`'s same-port branch above), so the only way this happens is a
 * dev restart against `scripts/dev.ts`'s pinned sticky port (common: it
 * persists across separate `bun dev` runs of one session, not just a
 * `bun --watch` restart mid-run) or, in prod, a `SIGKILL`'d sidecar whose
 * ephemeral port got reassigned — never a live rival. Any other recorded
 * owner is health-checked — never a staleness heuristic (file age, a PID
 * that might have been reused) — and, once confirmed dead, cleared and
 * retried. Bounded by `MAX_ACQUIRE_ATTEMPTS` so a lock that keeps coming back
 * dead fails loudly instead of spinning forever.
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
 * This is deliberately not deskkit's `acquireSidecar` (`deskkit/sidecar`),
 * even though `scripts/dev.ts` and the CLI's `handoff.ts` now read
 * `sidecar.json` via that same package's `awaitSidecarHandshake`/
 * `readSidecarJson`. deskkit's `acquireSidecar` folds the exclusivity claim
 * and the published handshake into one file, written directly via `wx` — no
 * rename — so a concurrent reader can observe a briefly empty or partial
 * `sidecar.json` (deskkit's own reader retries past this; its README says any
 * other reader must too). Rust's `wait_for_sidecar_json` doesn't: a parse
 * failure there is treated as fatal, not "keep polling," and that's
 * deliberate and tested (`fails_fast_on_a_malformed_file_instead_of_retrying_for_8s`
 * in `src-tauri/src/lib.rs`) — with no automatic retry on the frontend's
 * `get_backend` call above it, a single unlucky poll during that window would
 * surface as a permanent, unrecoverable error screen. Keeping `sidecar.json`
 * on this file's own atomic-rename write, separate from `sidecar.lock`'s
 * `wx`-only claim (which nothing outside this file reads), is what avoids
 * that.
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
