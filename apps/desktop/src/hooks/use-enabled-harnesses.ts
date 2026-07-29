"use client";

import { useCallback, useState } from "react";
import type { HarnessId } from "#/lib/walkthrough-data";

const STORAGE_KEY = "nisi:walkthrough-enabled-harnesses";
const VALID_HARNESS_IDS: readonly HarnessId[] = [
	"claude-code",
	"codex",
	"opencode",
	"pi",
];

function readStoredHarnesses(): readonly HarnessId[] | null {
	if (typeof window === "undefined") return null;
	const raw = window.localStorage.getItem(STORAGE_KEY);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((id): id is HarnessId =>
			VALID_HARNESS_IDS.includes(id as HarnessId),
		);
	} catch {
		return null;
	}
}

/**
 * Which harnesses the user has declared they have set up locally — `null`
 * means never configured (the onboarding checkboxes should show), distinct
 * from an empty array (configured, chose none so far). There's no
 * server-side concept of this: PLAN.md's Phase 3 note is that a harness's
 * availability can't be detected up front (no `isAvailable` API on any
 * adapter), so this is purely a client-side declaration, persisted the same
 * way as the sidebar/diff view-mode preferences (`use-sidebar-view-mode.ts`).
 */
export function useEnabledHarnesses(): [
	readonly HarnessId[] | null,
	(next: readonly HarnessId[]) => void,
] {
	const [enabled, setEnabled] = useState<readonly HarnessId[] | null>(
		readStoredHarnesses,
	);

	const setPersisted = useCallback((next: readonly HarnessId[]) => {
		setEnabled(next);
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	}, []);

	return [enabled, setPersisted];
}
