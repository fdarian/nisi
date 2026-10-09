import type { ReactNode } from "react";
import { PinnedImage, splitPins } from "./pinned-image";

/** One screenshot. `Pin` children number points on it; anything else among the children is ignored. */
export function Shot(props: {
	src: string;
	alt: string;
	caption?: ReactNode;
	children?: ReactNode;
}): React.ReactElement {
	const pins = splitPins(props.children).pins;
	return (
		<figure className="m-0 overflow-hidden rounded-lg border bg-card">
			<PinnedImage alt={props.alt} pins={pins} src={props.src} />
			{props.caption !== undefined && (
				<figcaption className="border-t px-3 py-2 text-muted-foreground text-xs">
					{props.caption}
				</figcaption>
			)}
		</figure>
	);
}
