"use client";

/**
 * The left pane: every section's markdown body, in order, followed by two
 * footnotes to the prose — `UncoveredFiles` (what the walkthrough skipped)
 * and a persistent `RegenerateControl` (below the reader, not gated on
 * drift like `OutdatedBanner`) — all in the same scroll flow. The one thing
 * that matters in the prose itself is `[text](ref:<id>)` — react-markdown
 * resolves those to plain `<a href="ref:<id>">` elements, which this
 * intercepts via a custom `a` renderer: no navigation, just selecting the
 * block in the right pane. The link renders as an inline `<button>` with all
 * default button chrome stripped, so it reads as part of the prose rather
 * than a UI control.
 */
import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { RegenerateControl } from "#/components/walkthrough/regenerate-control";
import { UncoveredFiles } from "#/components/walkthrough/uncovered-files";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { cn } from "#/lib/utils";
import type {
	HarnessId,
	UncoveredFile,
	WalkthroughSection,
	WalkthroughSelection,
} from "#/lib/walkthrough-data";

const REF_PREFIX = "ref:";

type NarrativePaneProps = {
	sections: readonly WalkthroughSection[];
	selection: WalkthroughSelection | null;
	outdatedBlockIds: ReadonlySet<string>;
	knownBlockIds: ReadonlySet<string>;
	onSelectionChange: (selection: WalkthroughSelection) => void;
	uncoveredFiles: readonly UncoveredFile[] | undefined;
	orpc: SidecarQueryUtils;
	/** The harness/model the *current* stored walkthrough was generated with — `RegenerateControl`'s default. */
	defaultHarness: HarnessId;
	defaultModel: string | null;
	onRegenerate: (harness: HarnessId, model: string | undefined) => void;
};

export function NarrativePane({
	sections,
	selection,
	outdatedBlockIds,
	knownBlockIds,
	onSelectionChange,
	uncoveredFiles,
	orpc,
	defaultHarness,
	defaultModel,
	onRegenerate,
}: NarrativePaneProps): React.ReactElement {
	const components = useMarkdownComponents(
		selection,
		outdatedBlockIds,
		knownBlockIds,
		onSelectionChange,
	);

	return (
		<div className="min-h-0 flex-1 overflow-auto px-6 py-5">
			<div className="mx-auto flex max-w-2xl flex-col gap-8 pb-12">
				{sections.map((section) => (
					<section className="flex flex-col gap-2" key={section.title}>
						<h2 className="font-heading font-semibold text-base text-foreground">
							{section.title}
						</h2>
						<div className="flex flex-col gap-3 text-foreground text-sm leading-relaxed">
							<ReactMarkdown
								components={components}
								// react-markdown's default `urlTransform` sanitizes any URI
								// scheme outside its http(s)/mailto/etc. allowlist down to an
								// empty string — `ref:<id>` isn't a real scheme, so without
								// this override every reference link would render as
								// `href=""` (a self-link, no less: clicking it navigates and
								// reloads the whole app). This content is our own sidecar's
								// output, not arbitrary user HTML, so passing URLs through
								// unchanged is safe here.
								urlTransform={(url) => url}
							>
								{section.body}
							</ReactMarkdown>
						</div>
					</section>
				))}

				<UncoveredFiles
					onSelectionChange={onSelectionChange}
					selection={selection}
					uncoveredFiles={uncoveredFiles}
				/>
				{/*
				 * A sibling of `UncoveredFiles`, not nested inside it — regeneration
				 * has to stay available even when `uncoveredFiles` is `undefined`
				 * (nothing rendered above) or `[]` (a one-line "covers everything"
				 * note, not a collapsible with room for a trailing action). Styled
				 * quiet/ghost, not `OutdatedBanner`'s warning treatment: this sits
				 * at the end of a document the reader just finished, not a call to
				 * fix something wrong.
				 */}
				<div className="flex items-center justify-end pt-4">
					<RegenerateControl
						buttonVariant="ghost"
						defaultHarness={defaultHarness}
						defaultModel={defaultModel}
						onRegenerate={onRegenerate}
						orpc={orpc}
					/>
				</div>
			</div>
		</div>
	);
}

function useMarkdownComponents(
	selection: WalkthroughSelection | null,
	outdatedBlockIds: ReadonlySet<string>,
	knownBlockIds: ReadonlySet<string>,
	onSelectionChange: (selection: WalkthroughSelection) => void,
): Components {
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
			a: ({ href, children }) => {
				const blockId = href?.startsWith(REF_PREFIX)
					? href.slice(REF_PREFIX.length)
					: null;

				if (blockId === null) {
					return (
						<a
							className="underline underline-offset-2"
							href={href}
							rel="noreferrer"
							target="_blank"
						>
							{children}
						</a>
					);
				}

				const isKnown = knownBlockIds.has(blockId);
				const isOutdated = outdatedBlockIds.has(blockId);
				const isSelected =
					selection?.kind === "reference" && selection.id === blockId;

				return (
					<button
						className={cn(
							"inline cursor-pointer border-0 bg-transparent p-0 font-medium text-inherit underline decoration-dotted underline-offset-2 hover:decoration-solid disabled:cursor-not-allowed disabled:opacity-64",
							isSelected && "rounded-sm bg-accent/60",
						)}
						disabled={!isKnown}
						onClick={() =>
							onSelectionChange({ kind: "reference", id: blockId })
						}
						title={isKnown ? undefined : "This reference no longer exists"}
						type="button"
					>
						{children}
						{isOutdated && (
							<span
								aria-label="Outdated"
								className="ml-1 inline-block size-1.5 shrink-0 -translate-y-px rounded-full bg-orange-500 align-middle"
								role="img"
								title="This reference may be out of date"
							/>
						)}
					</button>
				);
			},
		}),
		[knownBlockIds, onSelectionChange, outdatedBlockIds, selection],
	);
}
