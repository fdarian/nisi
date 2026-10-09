import type { GuideRef } from "./refs";

/** What the Guide's diff pane is showing: `ref` is where it scrolls to, `scope` the files it lists (an Area's paths), or `null` for `ref`'s file alone. Replaced, not mutated, on every click so a repeat click scrolls again. */
export type GuideTarget = {
	ref: GuideRef;
	scope: readonly string[] | null;
	/** A clicked symbol's token on `ref`'s line, to highlight in the pane. */
	span?: { charStart: number; charEnd: number };
};
