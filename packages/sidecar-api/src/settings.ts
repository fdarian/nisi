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
 * nothing server-side ever needs to read it. See PLAN.md, Phase 4.
 */
export const Settings = Schema.Struct({
	enabledHarnesses: Schema.Array(HarnessId),
	sidebarViewMode: SidebarViewMode,
	diffStyleMode: DiffStyleMode,
});
export type Settings = Schema.Schema.Type<typeof Settings>;

/** Every field optional — `update` merges a patch over the current settings, so omitted fields survive untouched. */
export const SettingsUpdate = Schema.Struct({
	enabledHarnesses: Schema.optional(Schema.Array(HarnessId)),
	sidebarViewMode: Schema.optional(SidebarViewMode),
	diffStyleMode: Schema.optional(DiffStyleMode),
});
export type SettingsUpdate = Schema.Schema.Type<typeof SettingsUpdate>;

export const settingsContract = {
	get: oc.output(Settings),
	update: oc.input(SettingsUpdate).output(Settings),
};
