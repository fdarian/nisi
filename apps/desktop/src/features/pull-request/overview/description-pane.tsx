"use client";

/**
 * The Overview tab's left pane in PR mode: the PR description, laid out like
 * a GitHub comment — the author's avatar in a gutter to the left of a
 * bordered card holding the rendered markdown body. The PR title itself
 * isn't repeated here — `pr-header.tsx` already shows it.
 */
import { useRef } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { ProseSelectionPopover } from "#/features/prose-selection/prose-selection-popover";
import { useProseSelection } from "#/features/prose-selection/use-prose-selection";
import type { OverviewDescription } from "#/features/pull-request/data/pr-data";
import { githubAvatarUrl } from "#/features/pull-request/data/pull-requests-data";
import { ProseMarkdown } from "#/features/pull-request/prose-markdown";
import type { SidecarQueryUtils } from "#/infra/backend-context";

/** Mirrors `open-pull-request-palette.tsx`'s helper of the same name — too small (one line) to be worth sharing across the two files. */
function authorInitials(login: string): string {
	return login.slice(0, 2).toUpperCase();
}

type DescriptionPaneProps = {
	sessionId: string;
	orpc: SidecarQueryUtils;
	description: OverviewDescription;
};

export function DescriptionPane({
	sessionId,
	orpc,
	description,
}: DescriptionPaneProps): React.ReactElement {
	const body = description.body;
	const scroller = useRef<HTMLDivElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const selection = useProseSelection(card, "description");

	return (
		<div
			className="min-w-0 min-h-0 flex-1 overflow-auto pl-3 pr-6 py-5"
			ref={scroller}
		>
			<div className="mx-auto flex max-w-2xl gap-3 pb-12">
				<Avatar className="mt-0.5 size-8 shrink-0">
					<AvatarImage alt="" src={githubAvatarUrl(description.authorLogin)} />
					<AvatarFallback>
						{authorInitials(description.authorLogin)}
					</AvatarFallback>
				</Avatar>
				<div
					className="min-w-0 flex-1 rounded-lg border bg-background px-4 py-3 text-foreground text-sm leading-relaxed"
					ref={card}
				>
					{body === null || body.trim() === "" ? (
						<p className="text-muted-foreground italic">
							No description provided.
						</p>
					) : (
						<div className="flex flex-col gap-3">
							<ProseMarkdown>{body}</ProseMarkdown>
						</div>
					)}
				</div>
			</div>
			<ProseSelectionPopover
				anchorRect={selection.anchorRect}
				clear={selection.clear}
				orpc={orpc}
				reference={selection.reference}
				scroller={scroller}
				sessionId={sessionId}
			/>
		</div>
	);
}
