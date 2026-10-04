export function DevBranch() {
	const label =
		__DEV_BRANCH__ === undefined
			? `Build ${__APP_COMMIT_SHA__.slice(0, 7)}`
			: __DEV_BRANCH__;

	return (
		<footer
			className="pointer-events-none shrink-0 truncate py-0.5 bg-sidebar text-tertiary text-[10px]"
			title={label}
		>
			{label}
		</footer>
	);
}
