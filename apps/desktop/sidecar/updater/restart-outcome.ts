import { join } from "node:path";
import { getDataDirConfig } from "@repo/db";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";

/**
 * Written by `restart-helper.ts`'s shell script after every
 * `brew upgrade --cask nisi` attempt — `versionBefore`/`versionAfter` come
 * from `brew list --cask --versions nisi` run right before and right after
 * the upgrade, `exitCode` from the upgrade itself. Read back here on the
 * next boot so an upgrade that silently did nothing (see `homebrew.ts`'s
 * `runBrew` doc: a frozen tap clone makes `brew upgrade` exit 0 having
 * upgraded nothing) doesn't just quietly re-offer "Update available"
 * forever.
 */
const RestartOutcome = Schema.Struct({
	versionBefore: Schema.String,
	versionAfter: Schema.String,
	exitCode: Schema.Number,
});
type RestartOutcome = typeof RestartOutcome.Type;

/**
 * Shared with `restart-helper.ts` so the writer (the shell script) and this
 * reader always agree on where the marker lives — the same `update/` dir
 * `restart.log` is already in.
 */
export const restartOutcomePathFor = (dataDir: string): string =>
	join(dataDir, "update", "restart-outcome.json");

export type RestartReconciliation =
	| { readonly kind: "none" }
	| {
			readonly kind: "upgrade-stalled";
			readonly version: string;
			readonly exitCode: number;
	  };

/**
 * Pure decision, kept separate from the filesystem read below so it's
 * testable without touching brew or disk. An upgrade is stalled exactly
 * when the installed version didn't move — whether `brew upgrade` exited
 * nonzero, or exited 0 having silently done nothing (the actual bug this
 * whole mechanism exists to catch), both look identical from here: no
 * version movement.
 */
export const reconcileRestartOutcome = (
	outcome: RestartOutcome,
): RestartReconciliation =>
	outcome.versionBefore === outcome.versionAfter
		? {
				kind: "upgrade-stalled",
				version: outcome.versionAfter,
				exitCode: outcome.exitCode,
			}
		: { kind: "none" };

/**
 * Reads and clears the restart helper's outcome marker, if one survived
 * from a previous session's `restart()`. A missing file (nothing to
 * reconcile — the common case) and unparseable JSON (a torn write, or a
 * marker from some future/incompatible shape) both read as "nothing to
 * reconcile" rather than failing boot over what's ultimately best-effort
 * bookkeeping. Removes the file as soon as it's read, successfully parsed
 * or not, so a bad marker can't wedge every future boot into re-reconciling
 * the same stale attempt.
 */
export const readRestartOutcome: Effect.Effect<
	RestartReconciliation,
	never,
	FileSystem
> = Effect.gen(function* () {
	const fs = yield* FileSystem;
	const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
	const path = restartOutcomePathFor(dataDir);

	const raw = yield* fs
		.readFileString(path)
		.pipe(Effect.orElseSucceed(() => undefined));
	if (raw === undefined) return { kind: "none" };

	yield* fs.remove(path, { force: true }).pipe(Effect.orDie);

	const parsed = yield* Effect.try({
		try: () => Schema.decodeUnknownSync(RestartOutcome)(JSON.parse(raw)),
		catch: () => undefined,
	}).pipe(Effect.orElseSucceed(() => undefined));
	if (parsed === undefined) {
		yield* Effect.logWarning(
			"found a restart-outcome marker but couldn't parse it -- discarding",
			{ path },
		);
		return { kind: "none" };
	}

	const reconciliation = reconcileRestartOutcome(parsed);
	yield* Effect.logInfo(
		"reconciled the previous restart helper's brew upgrade",
		{
			versionBefore: parsed.versionBefore,
			versionAfter: parsed.versionAfter,
			exitCode: parsed.exitCode,
			result: reconciliation.kind,
		},
	);
	return reconciliation;
});
