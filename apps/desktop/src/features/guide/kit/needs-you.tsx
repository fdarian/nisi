"use client";

import { Children, isValidElement, type ReactNode } from "react";
import { Checkbox } from "#/components/ui/checkbox";
import { useGuideContext } from "../guide-context";
import { useTick, useTickedCount } from "../guide-ticks";
import { InlineCode } from "./inline-code";

type ItemProps = { id: string; title: string; children?: ReactNode };

/** One thing for the reviewer to do or decide. `title` is the action, phrased for them; the children are the one-line how or why. The tick is remembered per session by `id`, so keep ids stable when rewriting the guide. */
export function Item(props: ItemProps): React.ReactElement {
	const guide = useGuideContext();
	if (typeof props.title !== "string") {
		throw new Error(
			`<Item id="${props.id}"> needs a title: the action for the reviewer, with the detail as children`,
		);
	}
	const [ticked, setTicked] = useTick(guide.sessionId, props.id);
	const inputId = `guide-tick-${guide.sessionId}-${props.id}`;
	return (
		<li>
			<label
				htmlFor={inputId}
				className="flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 hover:bg-accent"
			>
				<Checkbox
					checked={ticked}
					className="mt-0.5"
					id={inputId}
					onCheckedChange={(next) => setTicked(next === true)}
				/>
				<span className="flex min-w-0 flex-col">
					<span
						className={
							ticked ? "text-muted-foreground line-through" : undefined
						}
					>
						<InlineCode text={props.title} />
					</span>
					{props.children !== undefined && (
						<span className="text-muted-foreground text-xs">
							{props.children}
						</span>
					)}
				</span>
			</label>
		</li>
	);
}

export function NeedsYou(props: { children: ReactNode }): React.ReactElement {
	const guide = useGuideContext();
	const ids = Children.toArray(props.children).flatMap((child) =>
		isValidElement<ItemProps>(child) && child.type === Item
			? [child.props.id]
			: [],
	);
	const done = useTickedCount(guide.sessionId, ids);
	return (
		<section className="overflow-hidden rounded-lg border bg-card">
			<div className="border-b px-3 py-1.5 text-muted-foreground text-xs tabular-nums">
				{done} / {ids.length} done
			</div>
			<ul className="m-0 flex list-none flex-col p-1">{props.children}</ul>
		</section>
	);
}
