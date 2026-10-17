/**
 * Storybook coverage for `UnpushedCommitsDialog`'s two non-`"clean"`
 * outcomes (with and without per-commit detail) — no `orpc` dependency to
 * mock here, unlike `PrMergeButton`'s own stories: this component is pure
 * presentation over whatever `useUnpushedCommitsCheck` resolved.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { UnpushedCommit } from "#/features/pull-request/data/pr-data";
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
): UnpushedCommit {
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

/** Two unpushed commits with full detail — plural wording, graph, local branch header. */
export const Unpushed: Story = {
	args: {
		check: {
			status: "unpushed",
			count: 2,
			remoteRef: REMOTE_REF,
			localBranch: LOCAL_BRANCH,
			commits: REALISTIC_COMMITS,
		},
	},
};

/** Exactly one unpushed commit — singular wording. */
export const SingleUnpushedCommit: Story = {
	args: {
		check: {
			status: "unpushed",
			count: 1,
			remoteRef: REMOTE_REF,
			localBranch: LOCAL_BRANCH,
			commits: REALISTIC_COMMITS.slice(0, 1),
		},
	},
};

/** 12 unpushed commits — the graph caps at 5 and shows "+7 more". */
export const ManyUnpushedCommits: Story = {
	args: {
		check: {
			status: "unpushed",
			count: 12,
			remoteRef: REMOTE_REF,
			localBranch: LOCAL_BRANCH,
			commits: Array.from({ length: 12 }, (_, index) =>
				commit(
					`${(0xc0ffee0 + index * 0x1111).toString(16)}9d8c7b6a5f4e3d2c1b0a`,
					`Step ${12 - index} of the S3 mock replacement`,
					20 + index * 55,
				),
			),
		},
	},
};

/** Long subjects truncate to a single line instead of wrapping or widening the dialog. */
export const LongSubjects: Story = {
	args: {
		check: {
			status: "unpushed",
			count: 2,
			remoteRef: REMOTE_REF,
			localBranch: LOCAL_BRANCH,
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
		},
	},
};

/** Count only, no `commits` or `localBranch` — what the sidecar returns today. */
export const WithoutCommitDetails: Story = {
	args: {
		check: { status: "unpushed", count: 2, remoteRef: REMOTE_REF },
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
