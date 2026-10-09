import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { createMockOrpc } from "../../../.storybook/mock-orpc";
import {
	FIXTURE_FILE_CONTENTS,
	FIXTURE_FILES,
	TODOS_PATH,
} from "../pull-request/walkthrough/walkthrough.fixture";
import {
	SESSIONS_142_PATCH,
	SESSIONS_142_PATH,
} from "./reference-side-pane.fixture";
import { ReferenceSidePane } from "./reference-side-pane";
import type { GuideRef } from "./refs";

const meta = {
	title: "Guide/ReferenceSidePane",
	component: ReferenceSidePane,
	parameters: { controls: { disable: true } },
	decorators: [
		(Story) => (
			<div className="flex h-screen justify-end bg-pane-surface text-foreground">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof ReferenceSidePane>;
export default meta;

type Story = StoryObj<typeof meta>;

const base = {
	orpc: createMockOrpc({ fileContents: FIXTURE_FILE_CONTENTS }),
	sessionId: "story",
	files: FIXTURE_FILES,
	onClose: () => {},
};

/** A `Ref` with lines: the header carries the Reviewed checkbox. */
export const LineRange: Story = {
	args: { ...base, reference: { path: TODOS_PATH, lines: "22-30" } },
};

export const WholeFile: Story = {
	args: { ...base, reference: { path: TODOS_PATH } },
};

function Switching(): React.ReactElement {
	const [reference, setReference] = useState<GuideRef>({ path: TODOS_PATH });
	return (
		<div className="flex h-screen w-full">
			<div className="flex flex-1 gap-2 p-4">
				<button
					onClick={() => setReference({ path: TODOS_PATH })}
					type="button"
				>
					whole
				</button>
				<button
					onClick={() => setReference({ path: TODOS_PATH, lines: "22-30" })}
					type="button"
				>
					lines
				</button>
			</div>
			<ReferenceSidePane {...base} reference={reference} />
		</div>
	);
}

export const SwitchingRefs: Story = {
	args: { ...base, reference: { path: TODOS_PATH } },
	render: () => <Switching />,
};

export const OutsideHunks: Story = {
	args: { ...base, reference: { path: TODOS_PATH, lines: "60-70" } },
};

const ERRORS_PATH = "packages/git/src/errors.ts";
const ERRORS_PATCH =
	'diff --git a/packages/git/src/errors.ts b/packages/git/src/errors.ts\nindex 5cce99a..f163ab6 100644\n--- a/packages/git/src/errors.ts\n+++ b/packages/git/src/errors.ts\n@@ -368,6 +368,13 @@ export type PullRequestStateError =\n \t| GhRateLimited\n \t| PullRequestNotFound;\n \n+/** Every way `fetchPullRequestStates` can fail \u2014 a whole-repository listing has no single PR to be "not found", so a refused or broken `gh` call is `GitHubUnreachable`. */\n+export type PullRequestStatesError =\n+\t| GhOutputDecodeError\n+\t| GhNotAuthenticated\n+\t| GhRateLimited\n+\t| GitHubUnreachable;\n+\n export type PullRequestMergeabilityError =\n \t| GhOutputDecodeError\n \t| GhNotAuthenticated\n';

/** The #149 case: a Ref to a pure-addition hunk, which synthesizes to `@@ -371,0 +371,7 @@` with no context. */
export const PureAddition: Story = {
	args: {
		...base,
		orpc: createMockOrpc({
			fileContents: {
				[ERRORS_PATH]: { patch: ERRORS_PATCH, truncated: false, review: null },
			},
		}),
		files: [
			{
				path: ERRORS_PATH,
				status: "modified",
				category: "implementation",
				additions: 7,
				deletions: 0,
				fingerprint: "errors-fingerprint",
				binary: false,
				review: null,
			},
		],
		reference: { path: ERRORS_PATH, lines: "371-377" },
	},
};

/** Real data from PR #142: the `sessions.ts` patch the sidecar returned, referenced at lines 59-67. */
export const RealSessions142: Story = {
	args: {
		...base,
		orpc: createMockOrpc({
			fileContents: {
				[SESSIONS_142_PATH]: {
					patch: SESSIONS_142_PATCH,
					truncated: false,
					review: null,
				},
			},
		}),
		files: [
			{
				path: SESSIONS_142_PATH,
				status: "modified",
				category: "implementation",
				additions: 34,
				deletions: 9,
				fingerprint: "f4ebc3b0",
				binary: false,
				review: null,
			},
		],
		reference: { path: SESSIONS_142_PATH, lines: "59-67" },
	},
};
