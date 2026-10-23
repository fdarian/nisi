"use client";

import { hasSearchQualifier } from "@repo/git/search-query";
import { GitBranchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FetchingIndicator } from "#/components/fetching-indicator";
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
import {
	friendlyOpenPullRequestError,
	friendlySearchError,
	githubAvatarUrl,
	type IndexedPullRequest,
	type OpenPullRequestParams,
	type PullRequestRepository,
	type PullRequestSearchResult,
	useIndexedPullRequests,
	useOpenPullRequest,
	usePullRequestRepositories,
	useRecentPullRequests,
	useSearchPullRequests,
} from "#/features/pull-request/data/pull-requests-data";
import { OriginMovedDialog } from "#/features/pull-request/open/origin-moved-dialog";
import {
	deriveIndexedPrStatus,
	derivePrStatus,
} from "#/features/pull-request/pr-status";
import { PrStatusIcon } from "#/features/pull-request/pr-status-icon";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import {
	type BranchMatchRange,
	branchMatchRanges,
	filterIndexedPullRequests,
} from "./filter-indexed-pull-requests";
import { paletteRepositories, repositoryKey } from "./palette-repositories";

/**
 * Debounce for the `gh` fallback search only; filtering the open-PR index
 * isn't debounced. GitHub's search API allows 30 requests/minute
 * authenticated — but that budget only applies to requests actually *sent*, and a debounce (not a
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
	repositories: readonly PullRequestRepository[];
	onRepositoriesChange: (repositories: PullRequestRepository[]) => void;
	open: boolean;
	/** Whether the palette starts on the repository picker instead of the PR search each time it opens. */
	opensOnRepositoryPicker: boolean;
	onOpenChange: (open: boolean) => void;
	orpc: SidecarQueryUtils;
	/** Fires once `pullRequests.open` resolves — the caller sets `requestedActiveSessionId` (`app-shell.tsx`) so the new tab activates. */
	onSessionOpened: (sessionId: string) => void;
	/** Resolves a matching already-open tab before asking the sidecar to create/reuse a session. */
	findExistingSessionId: (params: OpenPullRequestParams) => string | undefined;
};

function authorInitials(author: string): string {
	return author.slice(0, 2).toUpperCase();
}

/**
 * Cmd+T and the tab strip's ghost "+" button both open this (Cmd+P too, on the repository picker) — a floating
 * search dialog listing open pull requests: the user's own latest, for a
 * blank query, or the sidecar's open-PR index filtered on every keystroke
 * (`filterIndexedPullRequests`) for a typed one. A live GraphQL search
 * scoped to author-or-review-requested (see `@repo/git`'s
 * `searchPullRequests`, including the search-qualifier passthrough) answers
 * only what the index can't: a query it finds nothing for, one using GitHub
 * qualifiers, or a repository chip it has no rows for. Picking one hands
 * off to `pullRequests.open`, which creates or reuses a worktree — prompting
 * for a local checkout path first if this repo's never been opened before —
 * and opens it as a session the same way any other tab gets opened.
 *
 * `query` (what the input shows and the index filters) and `debouncedQuery`
 * (when the `gh` search is allowed to fire, via
 * `#/features/pull-request/data/pull-requests-data.ts`'s `useSearchPullRequests`) are
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
export function OpenPullRequestPalette(
	props: OpenPullRequestPaletteProps,
): React.ReactElement {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [pickingRepository, setPickingRepository] = useState(false);
	const [repositoryQuery, setRepositoryQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const indexedRows = useIndexedPullRequests(props.orpc);
	const recent = useRecentPullRequests(props.orpc, props.open);
	const repositoryKeys = props.repositories.map(repositoryKey);
	// Blank and unscoped is the recent-PRs list; anything else is a search.
	const isBlank = query.trim() === "" && props.repositories.length === 0;
	const localMatches =
		isBlank || indexedRows === undefined
			? []
			: filterIndexedPullRequests(indexedRows, query, repositoryKeys);
	// The index can only answer what it holds: GitHub qualifiers are `gh`
	// syntax, and a chip for a repo with no indexed rows may just not be
	// indexed (yet). Anything else it found nothing for is left to `gh` too —
	// the PR may be one the index doesn't cover.
	const needsGh =
		!isBlank &&
		(localMatches.length === 0 ||
			hasSearchQualifier(query) ||
			indexedRows === undefined ||
			props.repositories.some((chip) =>
				indexedRows.every(
					(row) =>
						repositoryKey(row).toLowerCase() !==
						repositoryKey(chip).toLowerCase(),
				),
			));
	// Keyed on `query` itself, not the debounced copy: the request only fires
	// once they agree, and until then a cached answer for the exact query shows.
	const search = useSearchPullRequests(
		props.orpc,
		query,
		props.open && needsGh && query === debouncedQuery,
		repositoryKeys,
	);
	// `keepPreviousData` rows belong to some earlier query (often the blank
	// recent list); showing them would let Enter open an unrelated PR, so the
	// gh path shows nothing until its own answer lands.
	const results: readonly (PullRequestSearchResult | IndexedPullRequest)[] =
		isBlank
			? recent.results
			: needsGh
				? search.isPlaceholderData
					? []
					: search.results
				: localMatches;
	const searchError = isBlank ? recent.error : needsGh ? search.error : null;
	const searchErrorMessage = friendlySearchError(searchError);
	// Local filtering is instant, so only the `gh` path loads. A pending
	// debounce counts: between the keystroke and the request firing, nothing
	// else on screen says the palette noticed the typing.
	const isLoading = isBlank
		? recent.isSearching
		: needsGh && (search.isSearching || query !== debouncedQuery);
	const saved = usePullRequestRepositories(props.orpc, props.open);
	const repositories = paletteRepositories(
		recent.results,
		saved.data === undefined ? [] : saved.data,
		props.repositories,
		repositoryQuery,
	);
	const repositoryErrorMessage = saved.isError
		? "Couldn't load saved repositories — try reopening the palette."
		: friendlySearchError(recent.error);

	const openPr = useOpenPullRequest(props.orpc, (sessionId) => {
		props.onSessionOpened(sessionId);
		props.onOpenChange(false);
	});

	// Resets to a blank query every time the dialog opens, not just the app's
	// first mount of this component — reopening a stale palette should feel
	// the same as opening it cold. Deliberately keyed on `open` alone:
	// `openPr.reset` is a fresh closure every render and would otherwise fire
	// this on every render the palette happens to be open for, not just the
	// transition into it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
	useEffect(() => {
		if (!props.open) return;
		setQuery("");
		setDebouncedQuery("");
		setPickingRepository(props.opensOnRepositoryPicker);
		setRepositoryQuery("");
		openPr.reset();
	}, [props.open]);

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

	// First fetch with nothing to show yet: just the input and its "Fetching"
	// indicator, rather than an empty list and footer that would pop in once
	// results land. A pending open error still needs the footer to say so.
	const collapsed =
		!pickingRepository &&
		isLoading &&
		results.length === 0 &&
		searchErrorMessage === null &&
		footerMessage === null;

	// The moved-repository dialog stands in for the palette rather than
	// stacking on top of it; confirming re-opens the PR, whose `onOpened` above
	// then selects it.
	const hasOriginMoved = openPr.originMoved !== null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: only the appearance of the prompt should close the palette
	useEffect(() => {
		if (hasOriginMoved) props.onOpenChange(false);
	}, [hasOriginMoved]);

	return (
		<>
			<CommandDialog onOpenChange={props.onOpenChange} open={props.open}>
				<CommandDialogPopup
					onKeyDownCapture={(event) => {
						if (event.metaKey && event.key.toLowerCase() === "p") {
							event.preventDefault();
							event.stopPropagation();
							setRepositoryQuery("");
							setPickingRepository(true);
							inputRef.current?.focus();
						} else if (pickingRepository && event.key === "Escape") {
							// Capture before the dialog handles Escape, so cancelling the picker never closes it.
							event.preventDefault();
							event.stopPropagation();
							setPickingRepository(false);
						}
					}}
				>
					<CommandPanel>
						{pickingRepository ? (
							<Command
								key="repositories"
								filter={null}
								items={repositories}
								onValueChange={setRepositoryQuery}
								value={repositoryQuery}
							>
								<div className="flex items-center">
									<div className="min-w-0 flex-1">
										<CommandInput
											ref={inputRef}
											placeholder="Filter repository..."
										/>
									</div>
									<span className="mr-4 flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
										Apply <Kbd>↵</Kbd>
									</span>
								</div>
								<Separator />
								<CommandEmpty>
									{repositoryErrorMessage !== null
										? repositoryErrorMessage
										: saved.isPending || recent.isSearching
											? "Loading repositories…"
											: "No repositories found."}
								</CommandEmpty>
								<CommandList>
									{(repository: PullRequestRepository) => (
										<CommandItem
											key={repositoryKey(repository)}
											value={repository}
											onClick={() => {
												props.onRepositoriesChange([
													...props.repositories,
													repository,
												]);
												setPickingRepository(false);
											}}
										>
											<span className="text-muted-foreground">
												{repository.owner}
											</span>
											<span className="ml-2">{repository.repo}</span>
										</CommandItem>
									)}
								</CommandList>
								{repositoryErrorMessage !== null && repositories.length > 0 && (
									<p className="px-4 pb-2 text-destructive-foreground text-xs">
										{repositoryErrorMessage}
									</p>
								)}
							</Command>
						) : (
							<Command
								key="pull-requests"
								filter={null}
								items={results}
								onValueChange={setQuery}
								value={query}
							>
								<CommandInput
									ref={inputRef}
									placeholder="Open pull requests…"
									startContent={
										props.repositories.length > 0 ? (
											<div className="flex shrink-0 items-center gap-1">
												{/* ComboboxChip requires a Combobox root; mirror its styling inside this Autocomplete instead. */}
												{props.repositories.map((repository) => (
													<span
														key={repositoryKey(repository)}
														className="group flex items-center rounded-[calc(var(--radius-md)-1px)] bg-accent px-2 py-1 font-medium text-accent-foreground text-xs"
													>
														<span className="text-muted-foreground">
															{repository.owner}
														</span>
														<span className="ms-1">{repository.repo}</span>
														<button
															type="button"
															aria-label={`Remove ${repositoryKey(repository)} filter`}
															className="w-0 shrink-0 cursor-pointer overflow-hidden opacity-0 outline-none group-hover:ms-1 group-hover:w-3.5 group-hover:opacity-80 group-focus-within:ms-1 group-focus-within:w-3.5 group-focus-within:opacity-80 hover:opacity-100 focus-visible:opacity-100"
															onClick={() => {
																props.onRepositoriesChange(
																	props.repositories.filter(
																		(candidate) =>
																			repositoryKey(candidate) !==
																			repositoryKey(repository),
																	),
																);
																inputRef.current?.focus();
															}}
														>
															<XIcon className="size-3.5" />
														</button>
													</span>
												))}
											</div>
										) : undefined
									}
									endContent={isLoading ? <FetchingIndicator /> : undefined}
									onKeyDown={(event) => {
										if (
											event.key === "Backspace" &&
											query === "" &&
											props.repositories.length > 0
										) {
											event.preventDefault();
											props.onRepositoriesChange(
												props.repositories.slice(0, -1),
											);
										}
									}}
								/>
								{!collapsed && (
									<>
										<Separator />
										<CommandEmpty>
											{searchErrorMessage ?? "No pull requests found."}
										</CommandEmpty>
									</>
								)}
								<CommandList>
									{(pr: PullRequestSearchResult | IndexedPullRequest) => (
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
												query={query}
											/>
										</CommandItem>
									)}
								</CommandList>
							</Command>
						)}
					</CommandPanel>
					{!collapsed && (
						<CommandFooter>
							<span className="flex items-center gap-1.5">
								<Kbd>{pickingRepository ? "Esc" : "↵"}</Kbd>{" "}
								{pickingRepository ? "Cancel" : "Open"}
							</span>
							{!pickingRepository && footerMessage !== null && (
								<span className="text-destructive-foreground">
									{footerMessage}
								</span>
							)}
							<span className="ml-auto flex items-center gap-1.5">
								<Kbd>⌘P</Kbd> Filter Project
							</span>
						</CommandFooter>
					)}
				</CommandDialogPopup>
			</CommandDialog>
			<OriginMovedDialog prompt={openPr.originMoved} />
		</>
	);

	function handleSelect(pr: PullRequestSearchResult | IndexedPullRequest) {
		if (openPr.isPending) return;
		const params = { owner: pr.owner, repo: pr.repo, number: pr.number };
		const existingSessionId = props.findExistingSessionId(params);
		if (existingSessionId !== undefined) {
			props.onSessionOpened(existingSessionId);
			props.onOpenChange(false);
			return;
		}
		openPr.open(params);
	}
}

// Index rows carry no mergeability or CI, so they get the narrower status.
function rowStatus(pr: PullRequestSearchResult | IndexedPullRequest) {
	if (!("mergeable" in pr)) return deriveIndexedPrStatus(pr);
	return derivePrStatus({
		state: pr.state,
		isDraft: pr.isDraft,
		mergeable: pr.mergeable,
		mergeStateStatus: pr.mergeStateStatus,
		ciRunning: pr.rollupState === "PENDING" || pr.rollupState === "EXPECTED",
	});
}

function MatchedBranch(props: {
	branch: string;
	ranges: readonly BranchMatchRange[];
}): React.ReactElement {
	const parts: React.ReactNode[] = [];
	let cursor = 0;
	for (const range of props.ranges) {
		if (range.start > cursor)
			parts.push(props.branch.slice(cursor, range.start));
		parts.push(
			<mark
				key={range.start}
				className="bg-transparent font-medium text-foreground"
			>
				{props.branch.slice(range.start, range.end)}
			</mark>,
		);
		cursor = range.end;
	}
	if (cursor < props.branch.length) parts.push(props.branch.slice(cursor));
	return (
		<>
			<span aria-hidden>·</span>
			<GitBranchIcon className="size-3 shrink-0" />
			<span className="truncate font-mono">{parts}</span>
		</>
	);
}

function PullRequestRow(props: {
	pr: PullRequestSearchResult | IndexedPullRequest;
	query: string;
	isOpening: boolean;
}): React.ReactElement {
	const branchRanges =
		"headRefName" in props.pr
			? branchMatchRanges(props.pr.headRefName, props.query)
			: [];
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2.5">
			<PrStatusIcon status={rowStatus(props.pr)} />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 truncate">
						<span className="text-muted-foreground">#{props.pr.number}</span>{" "}
						{props.pr.title}
					</span>
					{props.pr.isDraft && (
						<Badge className="shrink-0" size="sm" variant="outline">
							Draft
						</Badge>
					)}
				</div>
				<div className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
					<span className="shrink-0">
						{props.pr.owner}/{props.pr.repo}
					</span>
					{"headRefName" in props.pr && branchRanges.length > 0 && (
						<MatchedBranch
							branch={props.pr.headRefName}
							ranges={branchRanges}
						/>
					)}
				</div>
			</div>
			{props.isOpening ? (
				<Spinner className="size-4 shrink-0 text-muted-foreground" />
			) : (
				<Avatar className="size-6 shrink-0 text-[10px]">
					<AvatarImage alt="" src={githubAvatarUrl(props.pr.author)} />
					<AvatarFallback>{authorInitials(props.pr.author)}</AvatarFallback>
				</Avatar>
			)}
		</div>
	);
}
