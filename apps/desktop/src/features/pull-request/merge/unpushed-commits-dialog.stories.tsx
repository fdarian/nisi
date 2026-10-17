/**
 * Storybook coverage for `UnpushedCommitsDialog`'s two non-`"clean"`
 * outcomes (with and without the on-origin tab, and each state of the
 * suggested-push action) — no `orpc` dependency to
 * mock here, unlike `PrMergeButton`'s own stories: this component is pure
 * presentation over whatever `useUnpushedCommitsCheck` resolved.
 */

import type { PushEvent } from "@repo/sidecar-api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
	type BranchCommit,
	type PushState,
	reducePushState,
} from "#/features/pull-request/data/pr-data";
import { UnpushedCommitsDialog } from "./unpushed-commits-dialog";

const meta: Meta<typeof UnpushedCommitsDialog> = {
	title: "Pr/UnpushedCommitsDialog",
	component: UnpushedCommitsDialog,
	parameters: { layout: "centered", controls: { disable: true } },
	args: {
		// Logged rather than no-ops so a story can be driven end-to-end (click
		// "Merge anyway"/"Cancel", confirm the right callback fired) without
		// wiring up real merge state here — this component doesn't own any.
		onMergeAnyway: () => console.log("UnpushedCommitsDialog: merge anyway"),
		onOpenChange: (open: boolean) =>
			console.log(`UnpushedCommitsDialog: onOpenChange(${open})`),
	},
};
export default meta;

type Story = StoryObj<typeof meta>;

const LOCAL_BRANCH = "claude/s3-mock-replacement-8602c4";
const REMOTE_REF = `origin/${LOCAL_BRANCH}`;

const MINUTE = 60_000;

/** `minutesAgo` is resolved when the module loads, so the relative times stay plausible in a long-lived Storybook session. */
function commit(
	sha: string,
	subject: string,
	minutesAgo: number,
): BranchCommit {
	return {
		sha,
		subject,
		authoredAt: new Date(Date.now() - minutesAgo * MINUTE).toISOString(),
	};
}

const REALISTIC_COMMITS = [
	commit(
		"a3f9c21e5b7d4086c1d2e3f40516273849a0b1c2",
		"Replace S3 mock with in-memory store",
		12,
	),
	commit(
		"7be04d8a1c3f5927e6d8b0a4c2f1e3d5b7a9c8e6",
		"Fix bucket policy fixture",
		95,
	),
];

/** Older than every unpushed commit above, newest first — what's already on `REMOTE_REF`. */
const ORIGIN_COMMITS = [
	commit(
		"5c1e8a07d3b94f62a0e7c9d1b3f5a7e9c2d4b6f8",
		"Add S3 client wrapper around the AWS SDK",
		60 * 26,
	),
	commit(
		"e20b7d49a1c63f85d7b9e1a3c5f7092b4d6e8a0c",
		"Move storage config into environment schema",
		60 * 27,
	),
	commit(
		"0fa38c6d2e4b7915c3a5e7d9f1b3a5c7e9d2f4b6",
		"Extract upload retry policy",
		60 * 50,
	),
	commit(
		"b94d1f0e7a3c5826e8d0b2f4a6c8e0d2b4f6a8c1",
		"Cover presigned URL expiry in tests",
		60 * 52,
	),
];

const BASE_REF = "main";

/** Two unpushed commits with full detail — plural wording, tabbed graph. */
export const Unpushed: Story = {
	args: {
		check: {
			status: "unpushed",
			remoteRef: REMOTE_REF,
			ahead: 2,
			behind: 0,
			diverged: false,
			commits: REALISTIC_COMMITS,
			origin: {
				baseRef: BASE_REF,
				count: ORIGIN_COMMITS.length,
				commits: ORIGIN_COMMITS,
			},
		},
	},
};

/** Exactly one unpushed commit — singular wording. */
export const SingleUnpushedCommit: Story = {
	args: {
		check: {
			status: "unpushed",
			remoteRef: REMOTE_REF,
			ahead: 1,
			behind: 0,
			diverged: false,
			commits: REALISTIC_COMMITS.slice(0, 1),
			origin: null,
		},
	},
};

/** The remote branch diverged from the local one (rebased, or pushed on top) — `ahead` and `commits` are only the local commits whose changes it lacks. */
export const DivergedRemote: Story = {
	args: {
		check: {
			status: "unpushed",
			remoteRef: REMOTE_REF,
			ahead: 2,
			behind: 4,
			diverged: true,
			commits: REALISTIC_COMMITS,
			origin: null,
		},
	},
};

/** 12 unpushed commits and 8 on origin — the sidecar lists 5 of each and the graph shows "+7 more" / "+3 more". */
export const ManyUnpushedCommits: Story = {
	args: {
		check: {
			status: "unpushed",
			remoteRef: REMOTE_REF,
			ahead: 12,
			behind: 0,
			diverged: false,
			commits: Array.from({ length: 5 }, (_, index) =>
				commit(
					`${(0xc0ffee0 + index * 0x1111).toString(16)}9d8c7b6a5f4e3d2c1b0a`,
					`Step ${12 - index} of the S3 mock replacement`,
					20 + index * 55,
				),
			),
			origin: {
				baseRef: BASE_REF,
				count: 8,
				commits: Array.from({ length: 5 }, (_, index) =>
					commit(
						`${(0xabcde00 + index * 0x2222).toString(16)}1f2e3d4c5b6a79880a1b`,
						`Groundwork ${8 - index} for the storage layer`,
						60 * 30 + index * 90,
					),
				),
			},
		},
	},
};

/** Long subjects truncate to a single line instead of wrapping or widening the dialog. */
export const LongSubjects: Story = {
	args: {
		check: {
			status: "unpushed",
			remoteRef: REMOTE_REF,
			ahead: 2,
			behind: 0,
			diverged: false,
			commits: [
				commit(
					"1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c",
					"Replace the S3 client mock with an in-memory object store that supports multipart uploads, bucket policies and presigned URLs",
					3,
				),
				commit(
					"9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d",
					"Fix flaky bucket policy fixture ordering when the test runner shards across workers on CI",
					1_500,
				),
			],
			origin: {
				baseRef: BASE_REF,
				count: 2,
				commits: [
					commit(
						"6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b",
						"Introduce a pluggable object-store interface so tests and production can swap implementations without touching callers",
						60 * 40,
					),
					commit(
						"3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
						"Document the storage module",
						60 * 41,
					),
				],
			},
		},
	},
};

/** Same data as `Unpushed`, opened on the "On origin" tab. */
export const OriginTab: Story = {
	args: Unpushed.args,
	play: async ({ canvasElement }) => {
		// The dialog renders in a portal, outside `canvasElement`.
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(await body.findByRole("tab", { name: /On origin/ }));
		await expect(
			await body.findByRole("tab", { name: /On origin/, selected: true }),
		).toBeVisible();
	},
};

/** `NO_REMOTE_REF` (or any other check failure) — worded as "couldn't verify" rather than naming a count. */
export const Unverifiable: Story = {
	args: {
		check: {
			status: "unverifiable",
			message: "This branch has no remote to compare against.",
		},
	},
};

const PUSH_COMMAND = `git push --progress origin HEAD:${LOCAL_BRANCH}`;

const PUSH_EVENTS: ReadonlyArray<PushEvent> = [
	{ type: "step", command: PUSH_COMMAND },
	...[
		"Enumerating objects: 9, done.",
		"Counting objects: 100% (9/9), done.",
		"Delta compression using up to 10 threads",
		"Compressing objects: 100% (4/4), done.",
		"Writing objects: 100% (5/5), 1.12 KiB | 1.12 MiB/s, done.",
		"Total 5 (delta 3), reused 0 (delta 0), pack-reused 0",
		"remote: Resolving deltas: 100% (3/3), completed with 3 local objects.",
		"To github.com:acme/storage.git",
		`   5c1e8a0..a3f9c21  ${LOCAL_BRANCH} -> ${LOCAL_BRANCH}`,
	].map((text): PushEvent => ({ type: "line", text })),
	{ type: "done" },
];

const REJECTED_EVENTS: ReadonlyArray<PushEvent> = [
	{ type: "step", command: PUSH_COMMAND },
	...[
		"To github.com:acme/storage.git",
		` ! [rejected]        ${LOCAL_BRANCH} -> ${LOCAL_BRANCH} (non-fast-forward)`,
		"error: failed to push some refs to 'github.com:acme/storage.git'",
		"hint: Updates were rejected because the tip of your current branch is behind",
		"hint: its remote counterpart. If you want to integrate the remote changes,",
		"hint: use 'git pull' before pushing again.",
	].map((text): PushEvent => ({ type: "line", text })),
	{
		type: "failed",
		reason: "rejected",
		message: `${REMOTE_REF} has commits your branch doesn't; pull them before pushing.`,
	},
];

const REBASE_CONFLICT_EVENTS: ReadonlyArray<PushEvent> = [
	{
		type: "step",
		command: `git pull --rebase --autostash origin ${LOCAL_BRANCH}`,
	},
	...[
		"From github.com:acme/storage",
		` * branch            ${LOCAL_BRANCH} -> FETCH_HEAD`,
		"Rebasing (1/2)",
		"Auto-merging src/storage/bucket-policy.ts",
		"CONFLICT (content): Merge conflict in src/storage/bucket-policy.ts",
		"error: could not apply 7be04d8... Fix bucket policy fixture",
	].map((text): PushEvent => ({ type: "line", text })),
	{ type: "step", command: "git rebase --abort" },
	{
		type: "failed",
		reason: "rebase-conflict",
		message:
			"The rebase hit conflicts and was aborted; your worktree is unchanged.",
	},
];

const OTHER_FAILURE_EVENTS: ReadonlyArray<PushEvent> = [
	{ type: "step", command: PUSH_COMMAND },
	{
		type: "line",
		text: "fatal: unable to access 'https://github.com/acme/storage.git/': Could not resolve host: github.com",
	},
	{
		type: "failed",
		reason: "other",
		message:
			"fatal: unable to access 'https://github.com/acme/storage.git/': Could not resolve host: github.com",
	},
];

function pushStateAfter(events: ReadonlyArray<PushEvent>): PushState {
	return events.reduce(reducePushState, { status: "idle" } as PushState);
}

function pushStory(
	push: PushState,
	check: Story["args"] = Unpushed.args,
): Story {
	return {
		args: {
			...check,
			push,
			onPush: (rebase) =>
				console.log(`UnpushedCommitsDialog: push (rebase: ${rebase})`),
		},
	};
}

/** The suggested-push action before anything has run. */
export const PushIdle: Story = pushStory({ status: "idle" });

/** `git push` in flight — the push row reads "Pushing…", Cancel and Merge anyway are blocked, Escape does nothing; the log scrolls as lines arrive. */
export const PushRunning: Story = pushStory(
	pushStateAfter(PUSH_EVENTS.slice(0, 6)),
);

/** Pushed — the log collapses behind "Show log" and the primary button becomes a plain Merge. */
export const PushSucceeded: Story = pushStory(pushStateAfter(PUSH_EVENTS));

/** A failure that isn't a rejection (here, no network) — destructive row, log open, the row becomes "Retry push". */
export const PushFailed: Story = pushStory(
	pushStateAfter(OTHER_FAILURE_EVENTS),
);

/** The branch is behind its remote, so a plain push can't succeed — rebase is the suggestion up front. */
export const PullRebaseSuggested: Story = pushStory(
	{ status: "idle" },
	{
		check: {
			status: "unpushed",
			remoteRef: REMOTE_REF,
			ahead: 2,
			behind: 3,
			diverged: true,
			commits: REALISTIC_COMMITS,
			origin: {
				baseRef: BASE_REF,
				count: ORIGIN_COMMITS.length,
				commits: ORIGIN_COMMITS,
			},
		},
	},
);

/** The check said ahead-only, but the push was rejected — the failed row now suggests the rebase. */
export const PushRejectedSuggestsRebase: Story = pushStory(
	pushStateAfter(REJECTED_EVENTS),
);

/** The rebase stopped on conflicts and was aborted — log stays open and explains the branch is untouched. */
export const RebaseConflict: Story = pushStory(
	pushStateAfter(REBASE_CONFLICT_EVENTS),
	{
		check: {
			status: "unpushed",
			remoteRef: REMOTE_REF,
			ahead: 2,
			behind: 3,
			diverged: true,
			commits: REALISTIC_COMMITS,
			origin: null,
		},
	},
);

const PUSH_EVENT_DELAY_MS = 300;

function PushInteractiveDialog(
	props: React.ComponentProps<typeof UnpushedCommitsDialog>,
) {
	const [push, setPush] = useState<PushState>({ status: "idle" });
	const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
	useEffect(
		() => () => {
			for (const timer of timers.current) clearTimeout(timer);
		},
		[],
	);

	const run = () => {
		if (push.status === "running" || push.status === "succeeded") return;
		setPush({ status: "running", log: [] });
		PUSH_EVENTS.forEach((event, index) => {
			timers.current.push(
				setTimeout(
					() => setPush((current) => reducePushState(current, event)),
					(index + 1) * PUSH_EVENT_DELAY_MS,
				),
			);
		});
	};

	return <UnpushedCommitsDialog {...props} onPush={run} push={push} />;
}

/** Click the push row to watch simulated `git push` output stream in and end in success; clicking again afterwards does nothing. */
export const PushInteractive: Story = {
	args: Unpushed.args,
	render: (args) => <PushInteractiveDialog {...args} />,
};
