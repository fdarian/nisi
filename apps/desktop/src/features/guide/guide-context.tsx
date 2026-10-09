"use client";

import type { GuideCheck, GuideSymbol } from "@repo/sidecar-api";
import { createContext, type ReactNode, useContext } from "react";
import type { GuideFile } from "./areas";
import type { GuideReviews } from "./guide-reviews";
import type { GuideTarget } from "./guide-target";
import type { GuideRef } from "./refs";

/**
 * What the author-time validator learns by rendering the guide: components
 * report themselves here as they render, so nothing parses the MDX. Only the
 * validator supplies one, and reporting is idempotent (a re-render repeats it).
 */
export type GuideCollector = {
	areas: { id: string; title: string; paths: readonly string[] }[];
	/** Every `<Areas>` rendered. */
	areasBlocks: number;
	refs: GuideRef[];
	/** The `area` of every Sequence step, to check it names a real Area. */
	stepAreas: string[];
	/** Each `Note`'s label and body, to check its paragraphs stay short. */
	notes: { label: string; children: ReactNode }[];
};

type GuideContextValue = {
	sessionId: string;
	/** The session diff's files with their stats; an Area's card is computed from them. */
	files: readonly GuideFile[];
	/** `files`' paths — `Ref` flags anything outside it, and inline code matching one becomes a `Ref`. */
	changedPaths: ReadonlySet<string>;
	/** Recorded command runs, and the head they're judged stale against. */
	checks: readonly GuideCheck[];
	headSha: string;
	/** The reference shown in the side pane, if any. */
	selectedRef: GuideRef | null;
	/** `scope` is the paths of the Area the click came from (`useAreaScope`): the pane lists all of them, scrolled to `ref`. Without it the pane shows just `ref`'s file. */
	selectRef: (
		ref: GuideRef,
		scope?: readonly string[],
		span?: GuideTarget["span"],
	) => void;
	/** Area ids in document order; an Area's color is its index here. Set by `Areas`, read by anything that colors by area (a Sequence step comes before the Areas it names). */
	areaOrder: readonly string[];
	setAreaOrder: (ids: readonly string[]) => void;
	/** The Area card under the pointer, so a Sequence can dim the steps of every other area. */
	hoveredArea: string | null;
	setHoveredArea: (id: string | null) => void;
	/** Names declared exactly once in a changed file; inline code that is just such a name links to its declaration. */
	symbols: ReadonlyMap<string, GuideSymbol>;
	/** The review state Area rows tick. Absent in the static preview, which shows no checkboxes. */
	reviews?: GuideReviews;
	/** The static preview: every Tour frame stacked, both Sequence states shown, Area file lists open. Set by `nisi guide render`, never by the app. */
	expanded?: boolean;
	collector?: GuideCollector;
};

const GuideContext = createContext<GuideContextValue | null>(null);

export const GuideProvider = GuideContext.Provider;

const AreaScopeContext = createContext<readonly string[] | undefined>(
	undefined,
);

/** Set by `Area` around its bullets and file list, so a `Ref` or row inside one can open the pane on the whole Area. */
export const AreaScopeProvider = AreaScopeContext.Provider;

export function useAreaScope(): readonly string[] | undefined {
	return useContext(AreaScopeContext);
}

export function useGuideContext(): GuideContextValue {
	const value = useContext(GuideContext);
	if (value === null) {
		throw new Error("guide kit components must render inside the Guide tab");
	}
	return value;
}
