"use client";

import { createContext, useContext } from "react";

type GuideContextValue = {
	sessionId: string;
	/** Paths in the session's current diff — `Ref` flags anything outside it. */
	changedPaths: ReadonlySet<string>;
	openFile: (path: string, line?: number) => void;
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
