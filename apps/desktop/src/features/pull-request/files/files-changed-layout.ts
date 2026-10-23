/** `w-72` in px — the shell animates width as a number, so it can't read the class. Keep in step with `filesSidebarClassName`. */
export const filesSidebarWidthPx = 288;
/** A 24px icon button plus `px-diff-pane-inset` (12px) either side. */
export const filesSidebarRailWidthPx = 48;
export const filesSidebarClassName =
	"flex h-full w-72 shrink-0 flex-col bg-pane-surface-nested px-diff-pane-inset pb-2";
export const filesMainClassName = "flex min-h-0 flex-1 flex-col pt-2 gap-2";
export const filesToolbarClassName =
	"rounded-xl bg-diff-surface px-3 py-2 flex shrink-0 items-center justify-between ml-(--diff-pane-inset-start,var(--spacing-diff-pane-inset)) mr-diff-pane-inset text-muted-foreground text-xs";
