"use client";

import { Children, isValidElement, type ReactNode } from "react";
import { Checkbox } from "#/components/ui/checkbox";
import { useGuideContext } from "../guide-context";
import { useTick, useTickedCount } from "../guide-ticks";

type ItemProps = { id: string; children?: ReactNode };

/** One thing the reviewer has to do or decide; the tick is remembered per session by `id`, so keep ids stable when rewriting the guide. */
export function Item(props: ItemProps): React.ReactElement {
	const guide = useGuideContext();
	const [ticked, setTicked] = useTick(guide.sessionId, props.id);
	const inputId = `guide-tick-${guide.sessionId}-${props.id}`;
	return (
		<li>
			<label
				htmlFor={inputId}
				className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent"
			>
				<Checkbox
					checked={ticked}
					className="mt-0.5"
					id={inputId}
					onCheckedChange={(next) => setTicked(next === true)}
				/>
				<span
					className={ticked ? "text-muted-foreground line-through" : undefined}
				>
					{props.children}
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
			<div className="flex items-center justify-between border-b px-3 py-1.5">
				<span className="font-medium text-sm">Needs you</span>
				<span className="text-muted-foreground text-xs tabular-nums">
					{done} / {ids.length}
				</span>
			</div>
			<ul className="flex flex-col p-1">{props.children}</ul>
		</section>
	);
}
