"use client";

import type { GuideCheck } from "@repo/sidecar-api";
import { createContext, useContext } from "react";
import type { GuideRef } from "./refs";

type GuideContextValue = {
	sessionId: string;
	/** Paths in the session's current diff — `Ref` flags anything outside it, and inline code matching one becomes a `Ref`. */
	changedPaths: ReadonlySet<string>;
	/** Recorded command runs, and the head they're judged stale against. */
	checks: readonly GuideCheck[];
	headSha: string;
	/** The reference shown in the side pane, if any. */
	selectedRef: GuideRef | null;
	selectRef: (ref: GuideRef) => void;
};

const GuideContext = createContext<GuideContextValue | null>(null);

export const GuideProvider = GuideContext.Provider;

export function useGuideContext(): GuideContextValue {
	const value = useContext(GuideContext);
	if (value === null) {
		throw new Error("guide kit components must render inside the Guide tab");
	}
	return value;
}
