"use client";

import { cn } from "cn";
import { type RefObject, useEffect, useState } from "react";

type Section = { element: HTMLElement; title: string; key: string };

/** The `h2`s of the rendered guide, re-read whenever it renders something new (`version`). */
function useSections(
	content: RefObject<HTMLElement | null>,
	version: string,
): Section[] {
	const [sections, setSections] = useState<Section[]>([]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger; the headings come from the DOM, not from it
	useEffect(() => {
		const root = content.current;
		if (root === null) return;
		const seen = new Map<string, number>();
		setSections(
			Array.from(root.querySelectorAll<HTMLElement>("h2"), (element) => {
				const title = element.textContent ?? "";
				const occurrence = seen.get(title) ?? 0;
				seen.set(title, occurrence + 1);
				return { element, title, key: `${title}#${occurrence}` };
			}),
		);
	}, [content, version]);
	return sections;
}

/**
 * Index of the section being read: the last heading above the top fifth of the
 * scroll container. The observer only says *when* a heading crosses that line;
 * the answer is recomputed from layout each time.
 */
function useActiveSection(
	sections: readonly Section[],
	scroller: RefObject<HTMLElement | null>,
): number {
	const [active, setActive] = useState(0);
	useEffect(() => {
		const root = scroller.current;
		if (root === null || sections.length === 0) return;
		const recompute = () => {
			const line = root.getBoundingClientRect().top + root.clientHeight * 0.2;
			let current = 0;
			sections.forEach((section, index) => {
				if (section.element.getBoundingClientRect().top <= line)
					current = index;
			});
			setActive(current);
		};
		const observer = new IntersectionObserver(recompute, {
			root,
			rootMargin: "0px 0px -80% 0px",
			threshold: [0, 1],
		});
		for (const section of sections) observer.observe(section.element);
		return () => observer.disconnect();
	}, [sections, scroller]);
	return active;
}

/** Floating "On this page", built from the guide's `h2`s; the app's, not something the MDX writes. */
export function GuideToc(props: {
	content: RefObject<HTMLElement | null>;
	scroller: RefObject<HTMLElement | null>;
	version: string;
}): React.ReactElement | null {
	const sections = useSections(props.content, props.version);
	const active = useActiveSection(sections, props.scroller);
	if (sections.length < 2) return null;
	return (
		<nav aria-label="On this page" className="flex flex-col gap-1">
			<span className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				On this page
			</span>
			{sections.map((section, index) => (
				<button
					className={cn(
						"cursor-pointer truncate border-l-2 py-0.5 pl-2.5 text-left text-[12.5px]",
						index === active
							? "border-sky-500 text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground",
					)}
					key={section.key}
					onClick={() =>
						section.element.scrollIntoView({
							behavior: "smooth",
							block: "start",
						})
					}
					type="button"
				>
					{section.title}
				</button>
			))}
		</nav>
	);
}
