/** `nisi diff`'s `<base>` positional, parsed into what it actually names. */
export type BaseArgument = {
	readonly baseRef: string;
	readonly headRef?: string;
};

/**
 * Parses `diff`'s `<base>` positional — either a bare ref (`main`, diffed
 * against `HEAD`) or a range spelling (`main..feature` / `main...feature`).
 * Both dot forms mean exactly the same thing here, deliberately not git's own
 * two-dot-vs-three-dot distinction: a review tool always wants
 * `merge-base(base, head) -> head`, the same resolution the bare-ref form
 * already gets from `@repo/git`'s `resolveMergeBase` — never a literal
 * two-dot diff of `base`'s tip against `head`'s tip.
 *
 * Splits on the *first* run of 2–3 dots, matching non-greedily — safe because
 * git itself forbids `..` anywhere inside a single ref name (see
 * `git-check-ref-format(1)`), so the first such run in the string can only be
 * the range delimiter, never part of either ref, even when a ref legitimately
 * contains single dots (`release.1.0`).
 */
export const parseBaseArgument = (raw: string): BaseArgument => {
	const match = /^(.+?)\.{2,3}(.+)$/.exec(raw);
	if (match === null) return { baseRef: raw };

	const baseRef = match[1];
	const headRef = match[2];
	if (baseRef === undefined || headRef === undefined) return { baseRef: raw };

	return { baseRef, headRef };
};
