export function DevCheckoutPath() {
	return (
		<footer
			className="pointer-events-none shrink-0 truncate bg-sidebar px-3 py-1 text-muted-foreground text-xs"
			title={__DEV_CHECKOUT_PATH__}
		>
			{__DEV_CHECKOUT_PATH__}
		</footer>
	);
}
