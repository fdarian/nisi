import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

/**
 * The tap's rendered cask file — generated exclusively by
 * `scripts/update-homebrew-cask.ts`'s `renderCask` and pushed to
 * `fdarian/homebrew-tap`'s default branch (`main`). This is read instead of
 * GitHub's release API because a release can ship before CI pushes the tap
 * bump (observed: v0.2.4 released while the cask was still 0.2.3) — reading
 * the tap is reading the exact thing `brew upgrade --cask nisi` itself would
 * see, so this never offers an update brew can't yet deliver.
 */
const TAP_CASK_URL =
	"https://raw.githubusercontent.com/fdarian/homebrew-tap/main/Casks/nisi.rb";

export type Semver = {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	/** `null` for a plain release; the text after the `-` for a prerelease (`"beta.1"` in `0.3.0-beta.1`). */
	readonly prerelease: string | null;
};

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/** `x.y.z` plus an optional `-prerelease` suffix. `undefined` for anything else — callers treat that as "can't compare", not as a crash. */
export const parseSemver = (raw: string): Semver | undefined => {
	const match = SEMVER_PATTERN.exec(raw.trim());
	if (match === null) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? null,
	};
};

/** `-1`/`0`/`1` comparing `a` to `b`. A prerelease sorts below the plain release of the same `major.minor.patch` (`0.3.0-beta.1` < `0.3.0`); two prereleases of the same triple compare lexically. */
export const compareSemver = (a: Semver, b: Semver): -1 | 0 | 1 => {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
	if (a.prerelease === b.prerelease) return 0;
	if (a.prerelease === null) return 1;
	if (b.prerelease === null) return -1;
	return a.prerelease < b.prerelease ? -1 : 1;
};

/** `true` only when `candidate` is a strictly newer version than `current` — `false` on a tie, a regression, or either string failing to parse as a `Semver`. */
export const isNewerVersion = (candidate: string, current: string): boolean => {
	const candidateSemver = parseSemver(candidate);
	const currentSemver = parseSemver(current);
	if (candidateSemver === undefined || currentSemver === undefined) {
		return false;
	}
	return compareSemver(candidateSemver, currentSemver) > 0;
};

const VERSION_LINE_PATTERN = /^\s*version\s+"([^"]+)"/m;

/**
 * Pulls the `version "…"` line out of the tap's rendered cask file — the
 * two-space-indented, double-quoted form `renderCask` always produces, so
 * this is a fixed-format match rather than a lenient Ruby-syntax sniff.
 */
export const parseCaskFileVersion = (rubySource: string): string | undefined =>
	VERSION_LINE_PATTERN.exec(rubySource)?.[1];

/** The tap fetch itself failed, or came back in a shape this couldn't read — never a reason to fall back to a made-up version, only to leave `UpdateState` where it was and retry on the next check (see `updater/service.ts`). */
export class TapFetchError extends Schema.TaggedErrorClass<TapFetchError>()(
	"TapFetchError",
	{ reason: Schema.String },
) {}

/** Fetches `TAP_CASK_URL` and reads its declared version. */
export const fetchTapVersion: Effect.Effect<
	string,
	TapFetchError,
	HttpClient.HttpClient
> = Effect.gen(function* () {
	const client = yield* HttpClient.HttpClient;
	const body = yield* client.get(TAP_CASK_URL).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.flatMap((response) => response.text),
		Effect.mapError((cause) => new TapFetchError({ reason: cause.message })),
	);

	const version = parseCaskFileVersion(body);
	if (version === undefined) {
		return yield* new TapFetchError({
			reason: 'tap cask file has no version "…" line',
		});
	}
	return version;
});
