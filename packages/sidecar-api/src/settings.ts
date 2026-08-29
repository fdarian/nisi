import { oc } from "@orpc/contract";
import { Schema } from "effect";
import { HarnessId } from "./walkthrough.ts";

/**
 * Tree/flat display preference for the files sidebar — mirrors
 * `apps/desktop/src/hooks/use-sidebar-view-mode.ts`'s `SidebarViewMode`,
 * redeclared here rather than imported since this package stays
 * dependency-free from the frontend, same as every other domain type it
 * mirrors.
 */
export const SidebarViewMode = Schema.Literals(["tree", "flat"]);
export type SidebarViewMode = Schema.Schema.Type<typeof SidebarViewMode>;

/** Split/unified diff display preference — mirrors `use-diff-style-mode.ts`'s `DiffStyleMode`. */
export const DiffStyleMode = Schema.Literals(["unified", "split"]);
export type DiffStyleMode = Schema.Schema.Type<typeof DiffStyleMode>;

/**
 * A handful of user preferences that live in the sidecar rather than the
 * webview's `localStorage` — the deciding line is whether the sidecar itself
 * needs to read the value. `enabledHarnesses` is the one that forced this:
 * `walkthrough.harnesses()` runs in the sidecar process when it spawns an
 * agent, so it can't be webview-only state. `sidebarViewMode`/`diffStyleMode`
 * are folded in alongside it rather than left in `localStorage` — they're
 * pure view state today, but real user preferences that ought to survive a
 * data-dir move, and the mechanism costs nothing extra once it exists for
 * `enabledHarnesses`. Theme stays in `localStorage` (`next-themes`) since
 * nothing server-side ever needs to read it.
 *
 * `enabledHarnesses` is `null` until the user has ever declared a choice —
 * distinct from `[]`, which means "deliberately disabled every harness".
 * `null` is what lets the walkthrough onboarding picker's first-use gate
 * fire (see `apps/desktop/AGENTS.md`'s former "two disagreeing sources"
 * gotcha, now resolved): a fresh install reports unset, not "all four
 * chosen". Everything that spawns off `enabledHarnesses` treats `null` as
 * "every harness allowed" rather than "none" — see
 * `apps/desktop/sidecar/harness/harnesses.ts`'s `listHarnesses`.
 */
export const Settings = Schema.Struct({
	enabledHarnesses: Schema.NullOr(Schema.Array(HarnessId)),
	sidebarViewMode: SidebarViewMode,
	diffStyleMode: DiffStyleMode,
	/**
	 * Scheme string of the user's preferred editor (`vscode`/`cursor`/`zed`/
	 * `windsurf`), or `null` when never chosen. Loose `Schema.String`, not a
	 * literal union — mirrors `@repo/settings`'s `Settings.preferredEditor`,
	 * which stays independent of the frontend's/Rust's candidate list for the
	 * same reason `enabledHarnesses` does.
	 */
	preferredEditor: Schema.NullOr(Schema.String),
	hideReviewed: Schema.Boolean,
	includeUncommitted: Schema.Boolean,
	/** Gates the entire walkthrough feature — see `@repo/settings`'s `Settings.walkthroughEnabled`. */
	walkthroughEnabled: Schema.Boolean,
});
export type Settings = Schema.Schema.Type<typeof Settings>;

/**
 * Every field optional — `update` merges a patch over the current settings,
 * so omitted fields survive untouched. `enabledHarnesses` can additionally be
 * set back to `null` (an included key whose value is `null`, as opposed to an
 * omitted key) to revert to "unset", not just to a chosen array.
 */
export const SettingsUpdate = Schema.Struct({
	enabledHarnesses: Schema.optional(Schema.NullOr(Schema.Array(HarnessId))),
	sidebarViewMode: Schema.optional(SidebarViewMode),
	diffStyleMode: Schema.optional(DiffStyleMode),
	preferredEditor: Schema.optional(Schema.NullOr(Schema.String)),
	hideReviewed: Schema.optional(Schema.Boolean),
	includeUncommitted: Schema.optional(Schema.Boolean),
	walkthroughEnabled: Schema.optional(Schema.Boolean),
});
export type SettingsUpdate = Schema.Schema.Type<typeof SettingsUpdate>;

export const settingsContract = {
	get: oc.output(Settings),
	update: oc.input(SettingsUpdate).output(Settings),
};
