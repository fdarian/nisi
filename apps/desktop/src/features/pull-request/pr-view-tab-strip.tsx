"use client";

import { cn } from "cn";
import { XIcon } from "lucide-react";
import { TabsList, TabsPrimitive, TabsTrigger } from "#/components/ui/tabs";
import {
	CodeIndexLspControl,
	CodeIndexLspControlPlaceholder,
} from "#/features/code-index/lsp/code-index-lsp-control";
import type { Session } from "#/features/pull-request/data/pr-data";
import {
	fileTabId,
	fileTabPath,
} from "#/features/pull-request/data/session-ui-store";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { splitPath } from "#/lib/tree-paths";
import type { KeyBindings } from "#/lib/use-key-bindings";
import { useKeyBindings } from "#/lib/use-key-bindings";

/** Shared by `PrView` and the pending-open panel, so both lay their tab strip and content out identically. */
export const PR_VIEW_TABS_CLASS = "flex min-h-0 flex-1 flex-col gap-0";

/**
 * Overview and Files Changed always exist regardless of the walkthrough
 * setting; Walkthrough only joins the strip when it's enabled. A single
 * array, not three separately-gated `TabsTrigger`s, is what lets
 * `PrViewTabStrip` derive the `1`/`2`/`3` (or `1`/`2`, walkthrough off)
 * shortcuts from each tab's own index instead of hardcoding which digit
 * means what.
 */
export function prViewTabs(walkthroughEnabled: boolean): readonly PrViewTab[] {
	const list: PrViewTab[] = [{ value: "overview", label: "Overview" }];
	if (walkthroughEnabled) {
		list.push({ value: "walkthrough", label: "Walkthrough" });
	}
	list.push({ value: "files", label: "Files Changed" });
	return list;
}

export type PrViewTab = { value: string; label: string };

/**
 * The Overview/Walkthrough/Files Changed tab strip, plus the digit
 * shortcuts that switch between them — co-located because they're the same
 * feature. Always rendered (unlike the old Walkthrough-only strip this
 * replaced): Overview and Files Changed exist regardless of the walkthrough
 * setting, so there's no longer a "hide the whole strip" case. The digit
 * bound to each tab is just its index in `tabs` (`PrView` builds that array
 * with Walkthrough already included-or-not), so collapsing from three tabs
 * to two never leaves a dead key bound to a tab that isn't showing — file
 * tabs (below) deliberately aren't part of this binding, so opening/closing
 * one never shifts what `1`/`2`/`3` mean.
 *
 * `openFiles` renders as a second block after a vertical divider, inside
 * the *same* `TabsList`/`Tabs.Root` as the static tabs — not a separate one
 * — so `TabsList`'s shared `Tabs.Indicator` (the underline, `variant="underline"`)
 * keeps tracking whichever tab is actually active for free: the moment a
 * file tab is selected, the indicator moves off the static tabs onto it,
 * which *is* "the static tabs lose their underline." Each file tab layers
 * its own rounded filled-pill active state on top via `data-active:` classes
 * instead of relying on that thin underline to read as "selected."
 */
export function PrViewTabStrip({
	tabs,
	openFiles,
	activeTab,
	setActiveTab,
	onCloseFile,
	isSelectedTab,
	session,
	orpc,
}: {
	session: Session;
	orpc: SidecarQueryUtils;
	activeTab: string;
	tabs: readonly PrViewTab[];
	openFiles: readonly string[];
	setActiveTab: (tab: string) => void;
	onCloseFile: (path: string) => void;
	isSelectedTab: boolean;
}): React.ReactElement {
	const bindings: KeyBindings = {};
	tabs.forEach((tab, index) => {
		bindings[String(index + 1)] = () => setActiveTab(tab.value);
	});
	useKeyBindings(bindings, { enabled: isSelectedTab });

	return (
		<TabStripFrame
			trailing={<CodeIndexLspControl orpc={orpc} sessionId={session.id} />}
		>
			<TabsList
				className={cn(
					TAB_LIST_CLASS,
					fileTabPath(activeTab) !== null &&
						"[&_[data-slot=tab-indicator]]:hidden",
				)}
				variant="underline"
			>
				{tabs.map((tab) => (
					<TabsTrigger key={tab.value} value={tab.value}>
						{tab.label}
					</TabsTrigger>
				))}
				{openFiles.length > 0 && (
					<div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
				)}
				{openFiles.map((path) => (
					<FileViewerTab
						key={path}
						onClose={() => onCloseFile(path)}
						path={path}
					/>
				))}
			</TabsList>
		</TabStripFrame>
	);
}

/**
 * The strip as it will look, but inert — for the pending-open panel, which
 * paints before there is a session to bind shortcuts, open files or an LSP to.
 * Must sit inside a `Tabs` root.
 */
export function PrViewTabStripSkeleton(props: {
	tabs: readonly PrViewTab[];
}): React.ReactElement {
	return (
		<TabStripFrame trailing={<CodeIndexLspControlPlaceholder />}>
			<TabsList className={TAB_LIST_CLASS} variant="underline">
				{props.tabs.map((tab) => (
					<TabsTrigger disabled key={tab.value} value={tab.value}>
						{tab.label}
					</TabsTrigger>
				))}
			</TabsList>
		</TabStripFrame>
	);
}

const TAB_LIST_CLASS = "-translate-x-2.5 mx-4";

function TabStripFrame(props: {
	children: React.ReactNode;
	trailing: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="border-b flex items-center justify-between pr-6.5">
			{props.children}
			{props.trailing}
		</div>
	);
}

/**
 * One open file's tab — deliberately not the shared `TabsTrigger`
 * (`#/components/ui/tabs`, styled for the underline variant's plain
 * text-color active state): the design calls for a rounded filled pill
 * instead, so this renders the underlying `TabsPrimitive.Tab` directly with
 * its own classes. Close affordance mirrors `chat-tab.tsx`'s `ChatTab`: a
 * sibling of the tab, absolutely positioned over its right edge rather than
 * nested inside, so it only ever reveals on hover/focus — never pinned open
 * just because the tab happens to be the active one.
 */
function FileViewerTab({
	path,
	onClose,
}: {
	path: string;
	onClose: () => void;
}): React.ReactElement {
	const { basename } = splitPath(path);
	return (
		<div className="group relative flex shrink-0">
			<TabsPrimitive.Tab
				className={cn(
					"flex h-7 select-none items-center self-center rounded-md px-3 font-medium text-muted-foreground text-xs outline-none",
					"cursor-pointer",
					"hover:bg-accent hover:text-foreground",
					"data-active:bg-accent data-active:text-foreground",
					"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					"transition-[color,background-color,box-shadow]",
				)}
				value={fileTabId(path)}
			>
				<span className="max-w-40 truncate group-focus-within:mask-r-from-[calc(100%-2.25rem)] group-focus-within:mask-r-to-[calc(100%-0.75rem)] group-hover:mask-r-from-[calc(100%-2.25rem)] group-hover:mask-r-to-[calc(100%-0.75rem)]">
					{basename}
				</span>
			</TabsPrimitive.Tab>
			<button
				aria-label={`Close ${basename}`}
				className="cursor-pointer -translate-y-1/2 absolute top-1/2 right-1.5 rounded-full p-0.5 opacity-0 hover:bg-background/60 group-focus-within:opacity-100 group-hover:opacity-100"
				onClick={onClose}
				type="button"
			>
				<XIcon className="size-3" />
			</button>
		</div>
	);
}
