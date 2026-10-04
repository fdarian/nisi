export function DevBranch() {
	return (
		<footer
			className="pointer-events-none shrink-0 truncate py-0.5 bg-sidebar text-tertiary text-[10px]"
			title={__DEV_BRANCH__}
		>
			{__DEV_BRANCH__}
		</footer>
	);
}
