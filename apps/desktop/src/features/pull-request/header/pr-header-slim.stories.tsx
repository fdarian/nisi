/**
 * Design exploration: a two-row PR header. The breadcrumb row is gone; the repo
 * and `#N` fold into the context row, which sits above (A), or below (B, C) the
 * title row. Nothing here is wired into the live header.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowLeftIcon, GitBranchIcon, MoreHorizontalIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import type {
	PullRequestMergeStatus,
	PullRequestStack,
} from "#/features/pull-request/data/pr-data";
import { PrAutoMergeIndicator } from "#/features/pull-request/merge/pr-auto-merge-indicator";
import { PrMergeButton } from "#/features/pull-request/merge/pr-merge-button";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { SidecarEventsProvider } from "#/infra/sidecar-events";
import {
	createMockOrpc,
	createMockSidecarClient,
} from "../../../../.storybook/mock-orpc";
import { PrBaseStaleNotice } from "./pr-base-stale-notice";
import { PrCiStatus } from "./pr-ci-status";
import { PrDiffStat } from "./pr-diff-stat";
import { Author, BranchChip } from "./pr-header-meta";
import { PrStackBadge } from "./pr-stack-badge";

const OWNER = "fdarian";
const REPO = "nisi";
const NUMBER = 184;
const TITLE = "Watch git refs instead of polling sessions every 2s";
const HEAD_REF = "claude/competent-lamarr-d1cd14";
const BASE_REF = "main";
const AUTHOR = "fdarian";
const REPO_ROOT = "/tmp/storybook-repo";

const MERGE_STATUS: PullRequestMergeStatus = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isDraft: false,
	allowedMethods: ["merge", "squash", "rebase"],
	defaultMethod: "squash",
};

const STACK: PullRequestStack = {
	number: NUMBER,
	size: 2,
	baseRefName: BASE_REF,
	position: 2,
	entries: [
		{
			position: 1,
			number: 183,
			title: "Carry the PR author login on the PR session target",
			headRefName: "stack/one",
			baseRefName: BASE_REF,
			state: "OPEN",
			isDraft: false,
		},
		{
			position: 2,
			number: NUMBER,
			title: TITLE,
			headRefName: HEAD_REF,
			baseRefName: "stack/one",
			state: "OPEN",
			isDraft: false,
		},
	],
};

const STORY_CLIENT = createMockSidecarClient();

const PR_ORPC = createMockOrpc({
	mergeStatus: MERGE_STATUS,
	stack: STACK,
	checks: [{ name: "Tests", status: "running" }],
});

type Variant = "context-top" | "number-in-title" | "context-below";

type SlimHeaderProps = {
	variant: Variant;
	mode: "pr" | "branch";
	orpc: SidecarQueryUtils;
	baseMayBeStale?: boolean;
};

const CONTEXT_ROW_CLASS =
	"flex h-5 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-muted-foreground text-xs";

function Separator(): React.ReactElement {
	return <span className="shrink-0">·</span>;
}

function StackBadge(props: { orpc: SidecarQueryUtils }): React.ReactElement {
	return (
		<PrStackBadge
			findExistingSessionId={() => undefined}
			isSelectedTab
			number={NUMBER}
			onSessionOpened={() => {}}
			orpc={props.orpc}
			owner={OWNER}
			repo={REPO}
			watched
		/>
	);
}

/** `fdarian/nisi #184 [stack] · avatar fdarian · main ← head`, or the branch-mode equivalent. */
function ContextRow(props: {
	mode: "pr" | "branch";
	/** B shows `#184` in the title row instead. */
	showNumber: boolean;
	orpc: SidecarQueryUtils;
	baseMayBeStale: boolean;
}): React.ReactElement {
	const repo = (
		<span className="shrink-0 font-medium text-foreground/70">
			{OWNER}/{REPO}
		</span>
	);
	const staleNotice = props.baseMayBeStale && (
		<PrBaseStaleNotice
			baseRef={BASE_REF}
			isRetrying={false}
			onRetry={() => {}}
		/>
	);

	if (props.mode === "branch") {
		return (
			<div className={CONTEXT_ROW_CLASS}>
				{repo}
				<Separator />
				<GitBranchIcon className="size-3.5 shrink-0" />
				<span className="shrink-0">Local diff against</span>
				<BranchChip name={BASE_REF} />
				{staleNotice}
			</div>
		);
	}

	return (
		<div className={CONTEXT_ROW_CLASS}>
			{repo}
			{props.showNumber && (
				<>
					<span className="shrink-0">#{NUMBER}</span>
					<StackBadge orpc={props.orpc} />
				</>
			)}
			<Separator />
			<Author login={AUTHOR} />
			<BranchChip name={BASE_REF} />
			<ArrowLeftIcon className="size-3 shrink-0" />
			<BranchChip icon name={HEAD_REF} />
			{staleNotice}
		</div>
	);
}

function TitleRow(props: {
	mode: "pr" | "branch";
	/** B appends the muted `#184` (and the stack badge) right after the title. */
	showNumber: boolean;
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	return (
		<div className="flex min-w-0 items-baseline gap-2">
			<h1 className="truncate font-heading font-semibold text-base">
				{props.mode === "pr" ? TITLE : HEAD_REF}
			</h1>
			{props.mode === "pr" && props.showNumber && (
				<span className="inline-flex shrink-0 items-center gap-1.5 self-center text-base text-muted-foreground">
					<span>#{NUMBER}</span>
					<StackBadge orpc={props.orpc} />
				</span>
			)}
			<PrDiffStat stat={{ status: "ready", additions: 552, deletions: 129 }} />
		</div>
	);
}

function SlimHeader(props: SlimHeaderProps): React.ReactElement {
	const numberInTitle = props.variant === "number-in-title";
	const context = (
		<ContextRow
			baseMayBeStale={props.baseMayBeStale === true}
			mode={props.mode}
			orpc={props.orpc}
			showNumber={!numberInTitle}
		/>
	);
	const title = (
		<TitleRow mode={props.mode} orpc={props.orpc} showNumber={numberInTitle} />
	);

	return (
		<div className="flex items-center gap-3 border-b py-2 pr-6 pl-4">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{props.variant === "context-top" ? (
					<>
						{context}
						{title}
					</>
				) : (
					<>
						{title}
						{context}
					</>
				)}
			</div>
			{props.mode === "pr" && (
				<div className="flex items-center gap-2">
					<div className="flex items-center gap-1">
						<PrCiStatus
							isSelectedTab
							number={NUMBER}
							orpc={props.orpc}
							owner={OWNER}
							repo={REPO}
							repoRoot={REPO_ROOT}
							watched
						/>
						<PrAutoMergeIndicator
							isSelectedTab
							number={NUMBER}
							orpc={props.orpc}
							owner={OWNER}
							repo={REPO}
							repoRoot={REPO_ROOT}
							watched
						/>
					</div>
					<PrMergeButton
						baseRef={BASE_REF}
						isSelectedTab
						number={NUMBER}
						orpc={props.orpc}
						owner={OWNER}
						repo={REPO}
						repoRoot={REPO_ROOT}
						watched
					/>
				</div>
			)}
			<Button aria-label="More actions" size="icon-sm" variant="ghost">
				<MoreHorizontalIcon />
			</Button>
		</div>
	);
}

const meta: Meta<typeof SlimHeader> = {
	title: "Pr/PrHeaderSlim",
	component: SlimHeader,
	decorators: [
		(Story) => (
			<SidecarEventsProvider client={STORY_CLIENT}>
				<Story />
			</SidecarEventsProvider>
		),
	],
	parameters: { layout: "fullscreen", controls: { disable: true } },
	args: { orpc: PR_ORPC },
};
export default meta;

type Story = StoryObj<typeof meta>;

/** Row 1: `fdarian/nisi #184 · author · main ← head`; row 2: title + stat. */
export const ContextOnTopPullRequest: Story = {
	args: { variant: "context-top", mode: "pr" },
};
export const ContextOnTopBranch: Story = {
	args: { variant: "context-top", mode: "branch" },
};

/** Row 1: title, muted `#184`, stat; row 2: `fdarian/nisi · author · main ← head`. */
export const NumberInTitlePullRequest: Story = {
	args: { variant: "number-in-title", mode: "pr" },
};
export const NumberInTitleBranch: Story = {
	args: { variant: "number-in-title", mode: "branch" },
};

/** Row 1: title + stat; row 2: `fdarian/nisi #184 · author · main ← head`. */
export const ContextBelowPullRequest: Story = {
	args: { variant: "context-below", mode: "pr" },
};
export const ContextBelowBranch: Story = {
	args: { variant: "context-below", mode: "branch" },
};

/** The stale-base notice icon closes the context row; shown on C only since the placement is the same in all three. */
export const ContextBelowStaleBase: Story = {
	args: { variant: "context-below", mode: "pr", baseMayBeStale: true },
};
