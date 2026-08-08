/**
 * Storybook coverage for `UnpushedCommitsDialog`'s two non-`"clean"`
 * outcomes — no `orpc` dependency to mock here, unlike `PrMergeButton`'s own
 * stories: this component is pure presentation over whatever
 * `useUnpushedCommitsCheck` resolved.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
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

/** A real unpushed commit found on the branch — plural wording, names the remote ref. */
export const Unpushed: Story = {
	args: {
		check: { status: "unpushed", count: 2, remoteRef: "origin/main" },
	},
};

/** Exactly one unpushed commit — singular wording ("commit"/"isn't"). */
export const SingleUnpushedCommit: Story = {
	args: {
		check: { status: "unpushed", count: 1, remoteRef: "origin/main" },
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
