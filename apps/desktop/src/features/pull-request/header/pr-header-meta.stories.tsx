/** Design coverage for the header's context row (repo, author and branches) inside `PrHeaderShell`. */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { PrCiStatus } from "#/features/pull-request/header/pr-ci-status";
import { PrDiffStat } from "#/features/pull-request/header/pr-diff-stat";
import { PrMergeButton } from "#/features/pull-request/merge/pr-merge-button";
import { SidecarEventsProvider } from "#/infra/sidecar-events";
import {
	createMockOrpc,
	createMockSidecarClient,
} from "../../../../.storybook/mock-orpc";
import { PrBaseStaleNotice } from "./pr-base-stale-notice";
import { PrHeaderMeta } from "./pr-header-meta";
import { PrHeaderShell } from "./pr-header-shell";
import { PrStackBadge } from "./pr-stack-badge";

const STORY_CLIENT = createMockSidecarClient();
const ORPC = createMockOrpc({
	mergeStatus: {
		state: "OPEN",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		isDraft: false,
		allowedMethods: ["merge", "squash", "rebase"],
		defaultMethod: "squash",
	},
	checks: [{ name: "Tests", status: "passing" }],
	stack: {
		number: 7,
		size: 2,
		baseRefName: "main",
		position: 2,
		entries: [
			{
				position: 1,
				number: 178,
				title: "Add the data layer",
				headRefName: "stack/one",
				baseRefName: "main",
				state: "OPEN",
				isDraft: false,
			},
			{
				position: 2,
				number: 179,
				title: "Hold a session on the head it is showing until Refresh",
				headRefName: "stack/two",
				baseRefName: "stack/one",
				state: "OPEN",
				isDraft: false,
			},
		],
	},
});

const TITLE = "Hold a session on the head it is showing until Refresh";

type StoryProps = {
	meta: React.ReactNode;
	width: number;
	repo?: string;
	/** Shows `#179` after the title, with the stack badge when `stacked`. */
	numbered?: boolean;
	stacked?: boolean;
	staleBase?: boolean;
	title?: string;
	pr?: boolean;
};

function HeaderStory(props: StoryProps): React.ReactElement {
	return (
		<SidecarEventsProvider client={STORY_CLIENT}>
			<div style={{ width: props.width }}>
				<PrHeaderShell
					repo={props.repo ?? "fdarian/nisi"}
					number={
						props.numbered === true ? (
							<>
								<span>#179</span>
								{props.stacked === true && (
									<PrStackBadge
										findExistingSessionId={() => undefined}
										isSelectedTab
										number={179}
										onSessionOpened={() => {}}
										orpc={ORPC}
										owner="fdarian"
										repo="nisi"
										watched
									/>
								)}
							</>
						) : undefined
					}
					title={props.title ?? TITLE}
					stat={
						<PrDiffStat
							stat={{ status: "ready", additions: 324, deletions: 100 }}
						/>
					}
					meta={props.meta}
					trailing={
						props.staleBase === true && (
							<PrBaseStaleNotice
								baseRef="main"
								isRetrying={false}
								onRetry={() => {}}
							/>
						)
					}
					actions={
						props.pr === false ? undefined : (
							<>
								<PrCiStatus
									isSelectedTab
									number={179}
									orpc={ORPC}
									owner="fdarian"
									repo="nisi"
									repoRoot="/tmp/storybook-repo"
									watched
								/>
								<PrMergeButton
									baseRef="main"
									isSelectedTab
									number={179}
									orpc={ORPC}
									owner="fdarian"
									repo="nisi"
									repoRoot="/tmp/storybook-repo"
									watched
								/>
							</>
						)
					}
					menu={
						<Button aria-label="More actions" size="icon-sm" variant="ghost">
							<MoreHorizontalIcon />
						</Button>
					}
				/>
			</div>
		</SidecarEventsProvider>
	);
}

const meta: Meta<typeof HeaderStory> = {
	title: "Pr/PrHeaderRedesign",
	component: HeaderStory,
	parameters: { layout: "fullscreen", controls: { disable: true } },
	args: { width: 900, numbered: true },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const PrArrow: Story = {
	args: {
		meta: (
			<PrHeaderMeta
				authorLogin="fdarian"
				baseRef="main"
				headRef="claude/pr-title-redesign-d6f5ea"
				mode="pr"
			/>
		),
	},
};

export const PrStacked: Story = {
	args: {
		stacked: true,
		meta: (
			<PrHeaderMeta
				authorLogin="fdarian"
				baseRef="main"
				headRef="claude/pr-title-redesign-d6f5ea"
				mode="pr"
			/>
		),
	},
};

/** A failed base fetch: the warning icon closes the context row. */
export const PrStaleBase: Story = {
	args: {
		stacked: true,
		staleBase: true,
		meta: (
			<PrHeaderMeta
				authorLogin="fdarian"
				baseRef="main"
				headRef="claude/pr-title-redesign-d6f5ea"
				mode="pr"
			/>
		),
	},
};

/** A session persisted before the author column existed: the avatar, login and separator are simply absent. */
export const PrNullAuthor: Story = {
	args: {
		meta: (
			<PrHeaderMeta
				authorLogin={null}
				baseRef="main"
				headRef="claude/pr-title-redesign-d6f5ea"
				mode="pr"
			/>
		),
	},
};

const LONG_HEAD = "claude/hold-session-on-shown-head-until-refresh-d6f5ea";
const LONG_BASE = "release/2026-10-feature-freeze";

export const PrLongBranchNames: Story = {
	args: {
		meta: (
			<PrHeaderMeta
				authorLogin="fdarian"
				baseRef={LONG_BASE}
				headRef={LONG_HEAD}
				mode="pr"
			/>
		),
	},
};

/** Narrow window: branch chips truncate (full name in the tooltip) instead of pushing the actions off. */
export const PrNarrow: Story = {
	args: {
		width: 480,
		meta: (
			<PrHeaderMeta
				authorLogin="fdarian"
				baseRef={LONG_BASE}
				headRef={LONG_HEAD}
				mode="pr"
			/>
		),
	},
};

export const BranchMode: Story = {
	args: {
		repo: "nisi",
		numbered: false,
		pr: false,
		title: "claude/pr-title-redesign-d6f5ea",
		meta: <PrHeaderMeta baseRef="main" mode="branch" />,
	},
};

export const BranchModeStaleBase: Story = {
	args: {
		repo: "nisi",
		numbered: false,
		staleBase: true,
		pr: false,
		title: "claude/pr-title-redesign-d6f5ea",
		meta: <PrHeaderMeta baseRef="main" mode="branch" />,
	},
};

export const BranchModeLongBase: Story = {
	args: {
		repo: "nisi",
		numbered: false,
		pr: false,
		title: "claude/pr-title-redesign-d6f5ea",
		meta: <PrHeaderMeta baseRef={LONG_BASE} mode="branch" />,
	},
};

export const BranchModeNarrow: Story = {
	args: {
		width: 480,
		repo: "nisi",
		numbered: false,
		pr: false,
		title: "claude/pr-title-redesign-d6f5ea",
		meta: <PrHeaderMeta baseRef={LONG_BASE} mode="branch" />,
	},
};
