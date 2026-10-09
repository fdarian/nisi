import { proseComponents } from "#/features/pull-request/prose-markdown";
import * as kit from "./kit";
import { GuideCode } from "./kit/ref";

/** The guide's first `# h1` is the page title; the app owns how it looks, so no kit component draws one. */
function GuideTitle(props: React.ComponentProps<"h1">): React.ReactElement {
	return (
		<h1
			className="m-0 font-heading font-semibold text-2xl leading-tight tracking-tight"
			{...props}
		/>
	);
}

/**
 * What the compiled MDX renders its markdown elements and un-imported tags
 * with. Kit components resolve without an import too, so a guide that forgets
 * `import { Checks } from "@nisi/guide"` still renders.
 */
export const GUIDE_COMPONENTS = {
	...proseComponents,
	...kit,
	h1: GuideTitle,
	code: GuideCode,
};
