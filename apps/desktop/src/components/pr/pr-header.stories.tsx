/**
 * Storybook coverage for the "Mark as Ready" overflow-menu item —
 * verifies it only renders while `mergeStatus.isDraft` is true, reusing the
 * same query `PrMergeButton` already polls (see `pr-header.tsx`'s
 * `MarkReadyMenuItem`).
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PullRequestMergeStatus, SessionTarget } from "#/lib/pr-data";
import { createMockOrpc } from "../../../.storybook/mock-orpc";
import { PrHeader } from "./pr-header";

const BASE_STATUS: PullRequestMergeStatus = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isDraft: false,
	allowedMethods: ["merge", "squash", "rebase"],
	defaultMethod: "merge",
};

const PR_TARGET: SessionTarget = {
	kind: "pr",
	number: 42,
	title: "Add widgets",
	baseRef: "main",
	headRef: "feature-42",
	owner: "acme",
	repo: "widgets",
};

const meta: Meta<typeof PrHeader> = {
	title: "Pr/PrHeader",
	component: PrHeader,
	parameters: { layout: "fullscreen", controls: { disable: true } },
	args: {
		repoRoot: "/tmp/storybook-repo",
		sessionId: "story-session",
		stat: { additions: 12, deletions: 4 },
		onCloseTab: () => {},
		watched: true,
	},
};
export default meta;

type Story = StoryObj<typeof meta>;

/** A draft PR — the overflow menu's "..." trigger gains "Mark as Ready" once `mergeStatus` resolves. */
export const DraftPullRequest: Story = {
	args: {
		target: PR_TARGET,
		orpc: createMockOrpc({
			mergeStatus: { ...BASE_STATUS, isDraft: true, mergeStateStatus: "DRAFT" },
		}),
	},
};

/** A non-draft PR — the overflow menu never gains the "Mark as Ready" item. */
export const ReadyPullRequest: Story = {
	args: {
		target: PR_TARGET,
		orpc: createMockOrpc({ mergeStatus: BASE_STATUS }),
	},
};
