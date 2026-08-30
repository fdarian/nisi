"use client";

/**
 * The Overview tab's left pane in PR mode: the PR description, laid out like
 * a GitHub comment — the author's avatar in a gutter to the left of a
 * bordered card holding the rendered markdown body. The PR title itself
 * isn't repeated here — `pr-header.tsx` already shows it.
 */
import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import type { OverviewDescription } from "#/lib/pr-data";
import { githubAvatarUrl } from "#/lib/pull-requests-data";

/** Mirrors `open-pull-request-palette.tsx`'s helper of the same name — too small (one line) to be worth sharing across the two files. */
function authorInitials(login: string): string {
	return login.slice(0, 2).toUpperCase();
}

type DescriptionPaneProps = {
	description: OverviewDescription;
};

export function DescriptionPane({
	description,
}: DescriptionPaneProps): React.ReactElement {
	const components = useMarkdownComponents();
	const body = description.body;

	return (
		<div className="min-h-0 flex-1 overflow-auto px-6 py-5">
			<div className="mx-auto flex max-w-2xl gap-3 pb-12">
				<Avatar className="mt-0.5 size-8 shrink-0">
					<AvatarImage alt="" src={githubAvatarUrl(description.authorLogin)} />
					<AvatarFallback>
						{authorInitials(description.authorLogin)}
					</AvatarFallback>
				</Avatar>
				<div className="min-w-0 flex-1 rounded-lg border bg-background px-4 py-3 text-foreground text-sm leading-relaxed">
					{body === null || body.trim() === "" ? (
						<p className="text-muted-foreground italic">
							No description provided.
						</p>
					) : (
						<div className="flex flex-col gap-3">
							<ReactMarkdown components={components}>{body}</ReactMarkdown>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * Same styled-component-override pattern as `narrative-pane.tsx`'s
 * `useMarkdownComponents`, minus its `ref:`-link interception — a PR
 * description is arbitrary GitHub-authored markdown, not the sidecar's own
 * `ref:`-scheme output, so a plain link stays a plain link (and
 * react-markdown's default `urlTransform` sanitization is left in place
 * rather than overridden the way `NarrativePane` overrides it for its own
 * scheme).
 */
function useMarkdownComponents(): Components {
	return useMemo<Components>(
		() => ({
			p: (props) => <p className="text-foreground" {...props} />,
			ul: (props) => <ul className="list-disc space-y-1 pl-5" {...props} />,
			ol: (props) => <ol className="list-decimal space-y-1 pl-5" {...props} />,
			strong: (props) => (
				<strong className="font-semibold text-foreground" {...props} />
			),
			code: (props) => (
				<code
					className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8125em]"
					{...props}
				/>
			),
			a: ({ href, children }) => (
				<a
					className="underline underline-offset-2"
					href={href}
					rel="noreferrer"
					target="_blank"
				>
					{children}
				</a>
			),
		}),
		[],
	);
}
