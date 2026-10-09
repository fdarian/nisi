import type { GuideResult } from "@repo/sidecar-api";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { GuideFile } from "./areas";
import { evaluateGuide } from "./evaluate";
import { GUIDE_COMPONENTS } from "./guide-components";
import { type GuideCollector, GuideProvider } from "./guide-context";

/**
 * The guide as the Guide tab's first render would draw it, with no DOM: what
 * `validate.ts` inspects and `render.ts` previews. Throws what the tab's error
 * boundary would show. `NeedsYou` reads tick state from `localStorage`, so the
 * caller has to provide one.
 */
export function renderGuideHtml(
	result: Extract<GuideResult, { kind: "ok" }>,
	files: readonly GuideFile[],
	options: { expanded: boolean; collector?: GuideCollector },
): string {
	const Guide = evaluateGuide(result.version, result.code);
	const render = (areaOrder: readonly string[], collector?: GuideCollector) =>
		renderToString(
			createElement(
				GuideProvider,
				{
					value: {
						sessionId: "static",
						files,
						changedPaths: new Set(files.map((file) => file.path)),
						checks: result.checks,
						headSha: result.headSha,
						selectedRef: null,
						selectRef: () => {},
						areaOrder,
						setAreaOrder: () => {},
						hoveredArea: null,
						setHoveredArea: () => {},
						expanded: options.expanded,
						collector,
					},
				},
				createElement(Guide, { components: GUIDE_COMPONENTS as never }),
			),
		).replace(/<!-- -->/g, "");
	// The tab learns the Areas' order in a layout effect, which a server render
	// never runs; a first pass reads it so the second can color by it.
	const first: GuideCollector = {
		areas: [],
		areasBlocks: 0,
		refs: [],
		stepAreas: [],
	};
	render([], first);
	return render(
		first.areas.map((area) => area.id),
		options.collector,
	);
}
