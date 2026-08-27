/**
 * `fullStream`'s `error` parts carry whatever a harness adapter's own
 * transport failed with — an unconfigured provider ("No API key found for
 * the selected model. Use /login…"), a revoked token, a model the CLI
 * rejects. The stream still ends *normally* after one, so nothing throws and
 * the turn simply produces no further output — a caller that doesn't read
 * these parts explicitly sees a silent no-op turn instead of the precise
 * failure the harness already described.
 *
 * Returns `undefined` for a part carrying no payload at all. OpenCode's
 * bridge emits a bare `{ type: "error" }` partway through a busy session (see
 * `patches/@ai-sdk%2Fharness@1.0.46.patch`, which is what lets it decode
 * rather than tear the stream down); it says nothing, arrives on runs that
 * are otherwise fine, and must not abort a turn that is about to succeed.
 * Anything with real content still fails the turn.
 */
export const describeStreamError = (error: unknown): string | undefined => {
	if (error === undefined || error === null) return undefined;
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error.length === 0 ? undefined : error;
	if (
		typeof error === "object" &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message;
	}
	return JSON.stringify(error);
};
