"use client";

import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/** Emitted by the app menu's "About nisi" item — see `src-tauri/src/lib.rs`. */
const ABOUT_EVENT = "menu://about";

type AboutDialogState = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/** Owns the About dialog's open state; opened by the macOS app menu's "About nisi" item. */
export function useAboutDialog(): AboutDialogState {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		const unlisten = isTauri()
			? listen(ABOUT_EVENT, () => setOpen(true))
			: undefined;

		return () => {
			unlisten?.then((stop) => stop());
		};
	}, []);

	return { open, onOpenChange: setOpen };
}
