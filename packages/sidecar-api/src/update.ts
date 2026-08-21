import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * macOS-only, Homebrew-cask-only self update — see root `AGENTS.md`'s
 * "auto-update" notes (once written) or the design doc this shipped from.
 * `unsupported` covers both "not installed via the `nisi` cask" and "`brew`
 * isn't on this machine" — the sidecar can't tell those apart in any way
 * that would change what the UI does (nothing, either way), so they collapse
 * into one terminal state rather than two.
 *
 * Transitions: the background check (an hourly poll, first run ~10s after
 * boot) drives `idle ⇄ available` only — it never touches `downloading`,
 * `ready`, or `failed`, so an hourly tick can't stomp on a download in
 * flight or an artifact already waiting for a restart. `update.download`
 * drives `available|failed → downloading → ready|failed`. `failed` carries
 * the version that failed plus why; the frontend re-renders it as
 * `available` after surfacing the message once (see the pill's spec), so a
 * retry is just another `update.download` call — the backend accepts that
 * from `failed` the same as from `available`.
 *
 * Once `unsupported`, the sidecar stops checking for the rest of the
 * process's life — whether this install came from Homebrew never changes
 * without a reinstall, which is a restart anyway.
 */
export const UpdateState = Schema.Union([
	Schema.Struct({ type: Schema.Literal("unsupported") }),
	Schema.Struct({ type: Schema.Literal("idle") }),
	Schema.Struct({ type: Schema.Literal("available"), version: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("downloading"),
		version: Schema.String,
	}),
	Schema.Struct({ type: Schema.Literal("ready"), version: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("failed"),
		version: Schema.String,
		message: Schema.String,
	}),
]);
export type UpdateState = Schema.Schema.Type<typeof UpdateState>;

export const updateContract = {
	/** Cheap — an in-memory `Ref` read. Safe to poll on a short interval; see the frontend's `update-data.ts` for the actual cadence. */
	status: oc.output(UpdateState),
	/**
	 * Starts (or retries) fetching the update `available`/`failed` is
	 * currently offering — forks the `brew fetch` and returns immediately, so
	 * the caller doesn't block on a DMG download. A no-op when there's
	 * nothing to fetch (`idle`, `unsupported`, already `downloading`, or
	 * already `ready`). Progress and outcome both show up through `status`.
	 */
	download: oc.output(Schema.Void),
	/**
	 * Writes and spawns the detached restart helper that waits for this app
	 * to quit, runs `brew upgrade --cask nisi` against the artifact
	 * `download` already cached, then relaunches — see the restart helper's
	 * own module for the shell script. A no-op unless the state is `ready`.
	 * Returns as soon as the helper is spawned; the frontend quits the app
	 * itself right after this resolves.
	 */
	restart: oc.output(Schema.Void),
};
