/**
 * Point-driven file focus for the diff pane — resolving the rendered
 * `<diffs-container>` under a client-coordinate point, including content in
 * its shadow root such as the sticky header. The hit-test function is an
 * argument so this remains a pure lookup over the point and host registry.
 */

export type DiffHoverPoint = {
	clientX: number;
	clientY: number;
};

export type DiffHoverHostRegistry = ReadonlyMap<Element, string>;

export type DiffHoverElementFromPoint = (
	point: DiffHoverPoint,
) => Element | null;

function parentElementOrShadowHost(element: Element): Element | undefined {
	if (element.parentElement !== null) return element.parentElement;

	const root = element.getRootNode();
	if (!("host" in root)) return undefined;
	const host = root.host;
	return host instanceof Element ? host : undefined;
}

/** Returns the rendered file under `point`, or `undefined` for a gap. */
export function findHoveredFileId(
	point: DiffHoverPoint,
	hosts: DiffHoverHostRegistry,
	elementFromPoint: DiffHoverElementFromPoint,
): string | undefined {
	if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) {
		return undefined;
	}

	const target = elementFromPoint(point);
	if (target === null) return undefined;

	let element: Element | undefined = target;
	while (element !== undefined) {
		const path = hosts.get(element);
		if (path !== undefined) return path;
		element = parentElementOrShadowHost(element);
	}
	return undefined;
}
