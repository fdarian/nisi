/**
 * Temporary Storybook coverage for `PrMergeButton`'s split-button UX, added
 * only to visually verify the GitHub-style split button (chevron flush
 * against the primary button, dropdown method picker) and the merged-state
 * fix (`resolveButtonState` no longer wedges on "Checking mergeability…"
 * once `state` is terminal) without a live sidecar/PR. Not meant to stick
 * around as permanent coverage — delete freely once verified.
 */
import type { PushEvent } from "@repo/sidecar-api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import type {
	PullRequestMergeStatus,
	PullRequestStack,
} from "#/features/pull-request/data/pr-data";
import { createMockOrpc } from "../../../../.storybook/mock-orpc";
import { PrMergeButton } from "./pr-merge-button";

const BASE_STATUS: PullRequestMergeStatus = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isDraft: false,
	allowedMethods: ["merge", "squash", "rebase"],
	defaultMethod: "merge",
};

const STACK: PullRequestStack = {
	number: 7,
	size: 2,
	baseRefName: "main",
	position: 2,
	entries: [
		{
			position: 1,
			number: 41,
			title: "Add the data layer",
			headRefName: "stack/one",
			baseRefName: "main",
			state: "OPEN",
			isDraft: false,
		},
		{
			position: 2,
			number: 42,
			title: "Add widgets",
			headRefName: "stack/two",
			baseRefName: "stack/one",
			state: "OPEN",
			isDraft: false,
		},
	],
};

const meta: Meta<typeof PrMergeButton> = {
	title: "Pr/PrMergeButton",
	component: PrMergeButton,
	parameters: { layout: "centered", controls: { disable: true } },
	args: {
		repoRoot: "/tmp/storybook-repo",
		owner: "acme",
		repo: "widgets",
		number: 42,
		baseRef: "main",
		watched: true,
		isSelectedTab: true,
	},
};

export const AutoMergeWithUnpushedCommits: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: { ...BASE_STATUS, mergeStateStatus: "BLOCKED" },
			unpushedCommits: {
				remoteRef: "origin/feature",
				ahead: 2,
				behind: 0,
				diverged: false,
				commits: [
					{
						sha: "a3f9c21e5b7d4086c1d2e3f40516273849a0b1c2",
						subject: "Replace S3 mock with in-memory store",
						authoredAt: new Date().toISOString(),
					},
					{
						sha: "7be04d8a1c3f5927e6d8b0a4c2f1e3d5b7a9c8e6",
						subject: "Fix bucket policy fixture",
						authoredAt: new Date().toISOString(),
					},
				],
				origin: null,
			},
		}),
	},
};
export default meta;

type Story = StoryObj<typeof meta>;

/** Repo allows all three methods — split button with a flush chevron opening the method picker. */
export const MultipleMethods: Story = {
	args: {
		orpc: createMockOrpc({ mergeStatus: BASE_STATUS }),
	},
};

/** Repo allows only one method — plain button, no chevron, no dropdown. */
export const SingleMethod: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: {
				...BASE_STATUS,
				allowedMethods: ["squash"],
				defaultMethod: "squash",
			},
		}),
	},
};

/**
 * A merged PR — GitHub stops computing `mergeable` once merged, so it's
 * still reported as `"UNKNOWN"` here on purpose. Before the Task B fix this
 * rendered "Checking mergeability…" forever; it should read "Merged" and be
 * disabled.
 */
export const Merged: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: { ...BASE_STATUS, state: "MERGED", mergeable: "UNKNOWN" },
		}),
	},
};

/**
 * `mergeStatus` fails and never once succeeds (e.g. the git worktree was
 * relocated out from under the session) — `statusQuery.data` stays
 * `undefined` forever. Before the fix, `resolveButtonState`'s
 * `status === undefined` guard caught this ahead of the `isError` check and
 * wedged the button on "Checking mergeability…" permanently; it should read
 * "Merge unavailable" and be disabled, with the error message in the title
 * tooltip.
 */
export const FailedQuery: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatusError:
				"Couldn't check whether this pull request can be merged.",
		}),
	},
};

/** A top stacked PR — the primary action merges both unmerged layers and shows the count pill. */
export const Stacked: Story = {
	args: {
		orpc: createMockOrpc({ mergeStatus: BASE_STATUS, stack: STACK }),
	},
};

export const AutoMergeWhileChecksPending: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: { ...BASE_STATUS, mergeStateStatus: "BLOCKED" },
		}),
	},
};

export const SingleMethodAutoMerge: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: {
				...BASE_STATUS,
				allowedMethods: ["squash"],
				defaultMethod: "squash",
				mergeStateStatus: "BLOCKED",
			},
		}),
	},
};

export const AutoMergeScheduled: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: { ...BASE_STATUS, mergeStateStatus: "BLOCKED" },
			scheduledMerge: { method: "squash" },
		}),
	},
};

const UNPUSHED = {
	remoteRef: "origin/feature",
	ahead: 2,
	behind: 0,
	diverged: false,
	commits: [
		{
			sha: "a3f9c21e5b7d4086c1d2e3f40516273849a0b1c2",
			subject: "Replace S3 mock with in-memory store",
			authoredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
		},
		{
			sha: "7be04d8a1c3f5927e6d8b0a4c2f1e3d5b7a9c8e6",
			subject: "Fix bucket policy fixture",
			authoredAt: new Date(Date.now() - 95 * 60_000).toISOString(),
		},
	],
	origin: null,
};

const pushLines = (...texts: readonly string[]): PushEvent[] =>
	texts.map((text) => ({ type: "line", text }));

const PUSH_SUCCESS: PushEvent[] = [
	{ type: "step", command: "git push --progress origin HEAD:feature" },
	...pushLines(
		"Writing objects: 100% (5/5), 1.12 KiB | 1.12 MiB/s, done.",
		"To github.com:acme/widgets.git",
		"   5c1e8a0..a3f9c21  feature -> feature",
	),
	{ type: "done" },
];

const openMergeDialog: Story["play"] = async ({ canvasElement }) => {
	const canvas = within(canvasElement);
	await userEvent.click(
		await canvas.findByRole("button", { name: /Merge pull request/ }),
	);
};

/** Opens the unpushed dialog on load; clicking "Push 2 commits" streams a mocked push, re-checks (now clean), and the primary becomes "Merge". */
export const PushFlow: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: BASE_STATUS,
			unpushedCommits: UNPUSHED,
			pushBranch: () => PUSH_SUCCESS,
		}),
	},
	play: openMergeDialog,
};

/** The plain push is rejected, the row switches to "Pull --rebase & push", and that run succeeds. */
export const PushRejectedThenRebase: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: BASE_STATUS,
			unpushedCommits: UNPUSHED,
			pushBranch: ({ rebase }) =>
				rebase
					? [
							{
								type: "step",
								command: "git pull --rebase --autostash origin feature",
							},
							...pushLines(
								"Successfully rebased and updated refs/heads/feature.",
							),
							{
								type: "step",
								command: "git push --progress origin HEAD:feature",
							},
							...pushLines("   5c1e8a0..b4d2e11  feature -> feature"),
							{ type: "done" },
						]
					: [
							{
								type: "step",
								command: "git push --progress origin HEAD:feature",
							},
							...pushLines(
								" ! [rejected]        feature -> feature (non-fast-forward)",
							),
							{
								type: "failed",
								reason: "rejected",
								message:
									"origin/feature has commits your branch doesn't; pull them before pushing.",
							},
						],
		}),
	},
	play: openMergeDialog,
};
