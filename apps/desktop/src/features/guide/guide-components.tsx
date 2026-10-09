import { proseComponents } from "#/features/pull-request/prose-markdown";
import * as kit from "./kit";
import { GuideCode } from "./kit/ref";

/**
 * What the compiled MDX renders its markdown elements and un-imported tags
 * with. Kit components resolve without an import too, so a guide that forgets
 * `import { Checks } from "@nisi/guide"` still renders.
 */
export const GUIDE_COMPONENTS = {
	...proseComponents,
	...kit,
	code: GuideCode,
};
