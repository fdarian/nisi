import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

/** Keeps portaled overlays from surviving after their tab stops being active. */
export function useDismissOnInactive(
	active: boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (active) return;
		setOpen(false);
	}, [active]);

	return [active && open, setOpen];
}
