"use client";

import { useEffect, useState } from "react";

/**
 * Live window-focus state from DOM `focus`/`blur`, seeded from
 * `document.hasFocus()` rather than assuming `true`, since a session watch
 * predicate built on top of this (`pr-data.ts`'s `useSessionWatch`)
 * shouldn't briefly claim "focused" for a window that was opened in the
 * background. `visibilitychange` covers a tab or window being hidden without
 * a blur.
 */
export function useWindowFocused(): boolean {
	const [focused, setFocused] = useState(() => document.hasFocus());

	useEffect(() => {
		const updateFromDocument = () => setFocused(document.hasFocus());
		updateFromDocument();
		document.addEventListener("visibilitychange", updateFromDocument);
		window.addEventListener("focus", updateFromDocument);
		window.addEventListener("blur", updateFromDocument);
		return () => {
			document.removeEventListener("visibilitychange", updateFromDocument);
			window.removeEventListener("focus", updateFromDocument);
			window.removeEventListener("blur", updateFromDocument);
		};
	}, []);

	return focused;
}
