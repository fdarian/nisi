"use client";

import { GitPullRequestIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { Badge } from "#/components/ui/badge";
import {
	Command,
	CommandDialog,
	CommandDialogPopup,
	CommandEmpty,
	CommandFooter,
	CommandInput,
	CommandItem,
	CommandList,
	CommandPanel,
} from "#/components/ui/command";
import { Kbd } from "#/components/ui/kbd";
import { Separator } from "#/components/ui/separator";
import { Spinner } from "#/components/ui/spinner";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import {
	friendlyOpenPullRequestError,
	friendlySearchError,
	githubAvatarUrl,
	type PullRequestSearchResult,
	useOpenPullRequest,
	useSearchPullRequests,
} from "#/lib/pull-requests-data";

/**
 * GitHub's search API allows 30 requests/minute authenticated — but that
 * budget only applies to requests actually *sent*, and a debounce (not a
 * throttle) means sustained typing with no pause sends none at all: the
 * timer keeps getting pushed back by every keystroke, so a request only
 * fires once the user stops. What actually costs requests is bursty
 * stop-start typing — a word, a pause, another word — and each pause here
 * costs at most one request (`useSearchPullRequests` keys TanStack Query on
 * the exact query string, so retyping something already searched this
 * session is free). 400ms is short enough to feel live between words, long
 * enough that a normal typing cadence (each keystroke well under 400ms
 * apart) never fires mid-word — dividing GitHub's 30/min budget evenly
 * across keystrokes (60/30 = 2000ms) would be the wrong number to aim for:
 * nobody pauses on every character, and a 2s debounce would make the palette
 * feel broken long before the rate limit was ever in danger.
 */
const SEARCH_DEBOUNCE_MS = 400;

type OpenPullRequestPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	orpc: SidecarQueryUtils;
	/** Fires once `pullRequests.open` resolves — the caller sets `requestedActiveSessionId` (`app-shell.tsx`) so the new tab activates. */
	onSessionOpened: (sessionId: string) => void;
};

function authorInitials(author: string): string {
	return author.slice(0, 2).toUpperCase();
}

/**
 * Cmd+T and the tab strip's ghost "+" button both open this — a floating
 * search dialog listing open pull requests: the user's own latest, for a
 * blank query, or a live `gh search prs` scoped to author-or-review-requested
 * for a typed one (see `@repo/git`'s `searchPullRequests` for the full
 * behavior, including the search-qualifier passthrough). Picking one hands
 * off to `pullRequests.open`, which creates or reuses a worktree — prompting
 * for a local checkout path first if this repo's never been opened before —
 * and opens it as a session the same way any other tab gets opened.
 *
 * `query` (what the input shows) and `debouncedQuery` (what's actually
 * searched, via `#/lib/pull-requests-data.ts`'s `useSearchPullRequests`) are
 * deliberately two separate pieces of state, debounced by hand below rather
 * than through a generic `useDebouncedValue(query, ms)` hook — the
 * reset-on-open effect needs both to snap back to `""` instantly, with no
 * debounce delay, or reopening the palette after a previous search would
 * flash that stale query's results for `SEARCH_DEBOUNCE_MS` before the
 * default list took over. A generic debounce hook fed straight from `query`
 * can't distinguish "the user typed" from "the palette just reset the query
 * out from under it" — both look like an ordinary value change from inside
 * the hook.
 */
export function OpenPullRequestPalette({
	open,
	onOpenChange,
	orpc,
	onSessionOpened,
}: OpenPullRequestPaletteProps): React.ReactElement {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const { results, error: searchError } = useSearchPullRequests(
		orpc,
		debouncedQuery,
	);
	const searchErrorMessage = friendlySearchError(searchError);

	const openPr = useOpenPullRequest(orpc, (sessionId) => {
		onSessionOpened(sessionId);
		onOpenChange(false);
	});

	// Resets to a blank query every time the dialog opens, not just the app's
	// first mount of this component — reopening a stale palette should feel
	// the same as opening it cold. Deliberately keyed on `open` alone:
	// `openPr.reset` is a fresh closure every render and would otherwise fire
	// this on every render the palette happens to be open for, not just the
	// transition into it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setDebouncedQuery("");
		openPr.reset();
	}, [open]);

	// The debounce itself — see `SEARCH_DEBOUNCE_MS`'s doc comment for why
	// 400ms. Runs independently of the reset effect above; it also fires right
	// after a reset (scheduling `setDebouncedQuery("")` again), which is
	// harmless since `debouncedQuery` is already `""` by then.
	useEffect(() => {
		const timer = setTimeout(
			() => setDebouncedQuery(query),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

	/**
	 * Emacs-style Ctrl+N/Ctrl+P, alongside the arrow keys the Autocomplete
	 * already binds. Base UI's `Autocomplete.Root` (`command.tsx`'s `Command`)
	 * owns highlight state internally via floating-ui's `useListNavigation`,
	 * attached to the search input's own `onKeyDown` — there's no public prop
	 * to set the highlighted item or move it imperatively (only
	 * `onItemHighlighted`, a read-only callback), so the only way to drive
	 * that *same* state instead of tracking a second index of our own is to
	 * dispatch the identical key the arrow keys produce at that same input
	 * element and let Base UI's existing handler process it — this is
	 * genuinely synthesizing a key event, not a documented API, but it goes
	 * through the real navigation logic (same wrap-around, same mouse-hover
	 * interplay) rather than inventing a parallel one.
	 */
	const handlePaletteKeyDown = (event: React.KeyboardEvent) => {
		if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
			return;
		}
		const key = event.key.toLowerCase();
		if (key !== "n" && key !== "p") return;
		event.preventDefault();
		inputRef.current?.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: key === "n" ? "ArrowDown" : "ArrowUp",
				bubbles: true,
				cancelable: true,
			}),
		);
	};

	// The open-action error takes priority in the footer — it's about the
	// selection the user just made, more specific than a background search
	// failure. A search error only surfaces there when it's *not* already the
	// only thing in view (`CommandEmpty` covers that case, below) — i.e. when
	// stale results from an earlier successful search are still on screen.
	const footerMessage =
		openPr.error !== null && openPr.error !== undefined
			? friendlyOpenPullRequestError(openPr.error)
			: searchErrorMessage !== null && results.length > 0
				? searchErrorMessage
				: null;

	return (
		<CommandDialog onOpenChange={onOpenChange} open={open}>
			<CommandDialogPopup onKeyDown={handlePaletteKeyDown}>
				<CommandPanel>
					<Command
						filter={null}
						items={results}
						onValueChange={setQuery}
						value={query}
					>
						<CommandInput placeholder="Open pull requests…" ref={inputRef} />
						<Separator />
						<CommandEmpty>
							{searchErrorMessage ?? "No pull requests found."}
						</CommandEmpty>
						<CommandList>
							{(pr: PullRequestSearchResult) => (
								<CommandItem
									key={`${pr.owner}/${pr.repo}#${pr.number}`}
									onClick={() => handleSelect(pr)}
									value={pr}
								>
									<PullRequestRow
										isOpening={
											openPr.isPending &&
											openPr.pendingParams?.owner === pr.owner &&
											openPr.pendingParams?.repo === pr.repo &&
											openPr.pendingParams?.number === pr.number
										}
										pr={pr}
									/>
								</CommandItem>
							)}
						</CommandList>
					</Command>
				</CommandPanel>
				<CommandFooter>
					<span className="flex items-center gap-1.5">
						<Kbd>↵</Kbd> Open
					</span>
					{footerMessage !== null && (
						<span className="text-destructive-foreground">{footerMessage}</span>
					)}
				</CommandFooter>
			</CommandDialogPopup>
		</CommandDialog>
	);

	function handleSelect(pr: PullRequestSearchResult) {
		if (openPr.isPending) return;
		openPr.open({ owner: pr.owner, repo: pr.repo, number: pr.number });
	}
}

function PullRequestRow({
	pr,
	isOpening,
}: {
	pr: PullRequestSearchResult;
	isOpening: boolean;
}): React.ReactElement {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2.5">
			<GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 truncate">
						<span className="text-muted-foreground">#{pr.number}</span>{" "}
						{pr.title}
					</span>
					{pr.isDraft && (
						<Badge className="shrink-0" size="sm" variant="outline">
							Draft
						</Badge>
					)}
				</div>
				<div className="truncate text-muted-foreground text-xs">
					{pr.owner}/{pr.repo}
				</div>
			</div>
			{isOpening ? (
				<Spinner className="size-4 shrink-0 text-muted-foreground" />
			) : (
				<Avatar className="size-6 shrink-0 text-[10px]">
					<AvatarImage alt="" src={githubAvatarUrl(pr.author)} />
					<AvatarFallback>{authorInitials(pr.author)}</AvatarFallback>
				</Avatar>
			)}
		</div>
	);
}
