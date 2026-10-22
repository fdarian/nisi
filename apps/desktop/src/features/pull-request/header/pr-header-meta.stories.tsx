/**
 * Design exploration for a header that also names the PR's author and its
 * branches. Not wired into `PrHeader` — `PrHeaderShell`'s `meta` slot is the
 * only live-code seam, and nothing passes it yet.
 */

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
import { PrHeaderMeta } from "./pr-header-meta";
import { PrHeaderShell } from "./pr-header-shell";

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
});

const TITLE = "Hold a session on the head it is showing until Refresh";

type StoryProps = {
	meta: React.ReactNode;
	width: number;
	repo?: string;
	refLabel?: string;
	title?: string;
	pr?: boolean;
};

function HeaderStory(props: StoryProps): React.ReactElement {
	return (
		<SidecarEventsProvider client={STORY_CLIENT}>
			<div style={{ width: props.width }}>
				<PrHeaderShell
					repo={props.repo ?? "fdarian/nisi"}
					refLabel={props.refLabel}
					title={props.title ?? TITLE}
					stat={
						<PrDiffStat
							stat={{ status: "ready", additions: 324, deletions: 100 }}
						/>
					}
					meta={props.meta}
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
	args: { width: 900, refLabel: "#179" },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const PrSentence: Story = {
	args: {
		meta: (
			<PrHeaderMeta
				author="fdarian"
				baseRef="main"
				headRef="claude/pr-title-redesign-d6f5ea"
				mode="pr"
				variant="sentence"
			/>
		),
	},
};

export const PrArrow: Story = {
	args: {
		meta: (
			<PrHeaderMeta
				author="fdarian"
				baseRef="main"
				headRef="claude/pr-title-redesign-d6f5ea"
				mode="pr"
				variant="arrow"
			/>
		),
	},
};

export const PrAuthorLoading: Story = {
	args: {
		meta: (
			<PrHeaderMeta
				author={undefined}
				baseRef="main"
				headRef="claude/pr-title-redesign-d6f5ea"
				mode="pr"
				variant="sentence"
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
				author="fdarian"
				baseRef={LONG_BASE}
				headRef={LONG_HEAD}
				mode="pr"
				variant="sentence"
			/>
		),
	},
};

export const PrLongBranchNamesArrow: Story = {
	args: {
		meta: (
			<PrHeaderMeta
				author="fdarian"
				baseRef={LONG_BASE}
				headRef={LONG_HEAD}
				mode="pr"
				variant="arrow"
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
				author="fdarian"
				baseRef={LONG_BASE}
				headRef={LONG_HEAD}
				mode="pr"
				variant="sentence"
			/>
		),
	},
};

export const BranchMode: Story = {
	args: {
		repo: "nisi",
		refLabel: undefined,
		pr: false,
		title: "claude/pr-title-redesign-d6f5ea",
		meta: <PrHeaderMeta baseRef="main" mode="branch" />,
	},
};

export const BranchModeLongBase: Story = {
	args: {
		repo: "nisi",
		refLabel: undefined,
		pr: false,
		title: "claude/pr-title-redesign-d6f5ea",
		meta: <PrHeaderMeta baseRef={LONG_BASE} mode="branch" />,
	},
};

export const BranchModeNarrow: Story = {
	args: {
		width: 480,
		repo: "nisi",
		refLabel: undefined,
		pr: false,
		title: "claude/pr-title-redesign-d6f5ea",
		meta: <PrHeaderMeta baseRef={LONG_BASE} mode="branch" />,
	},
};
