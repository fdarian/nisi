import type { ReactNode } from "react";
import { GuideCode } from "./ref";

/**
 * A `title` prop is a string, not markdown, so its backticked segments are
 * turned into the same inline code the body gets (including path and symbol
 * autolinking). An unpaired backtick stays literal.
 */
export function InlineCode(props: { text: string }): ReactNode {
	const segments = props.text.split(/`([^`]+)`/);
	return segments.map((segment, index) =>
		// split with one capture group alternates plain, code, plain, …
		index % 2 === 1 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
			<GuideCode key={index}>{segment}</GuideCode>
		) : (
			segment
		),
	);
}
