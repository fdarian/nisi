/**
 * Storybook coverage for the walkthrough tab's top-level state machine
 * (`WalkthroughView`, `apps/desktop/AGENTS.md`'s "Walkthrough" note) — every
 * state a real generation would eventually produce, without needing a live
 * sidecar or an agent CLI run. `createMockOrpc` (`.storybook/mock-orpc.ts`)
 * stands in for the sidecar; `walkthrough.fixture.ts` is the PR content.
 *
 * `selection` is lifted to `PrView` in the real app (so a "reviewed in
 * `<block>`" marker elsewhere can select a block *and* switch tabs) — here
 * `StatefulWalkthroughView` below is the story-local stand-in for that
 * parent, holding the same state `WalkthroughView` expects lifted.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { WalkthroughSelection } from "#/lib/walkthrough-data";
import { createMockOrpc } from "../../../.storybook/mock-orpc";
import {
	FIXTURE_FILE_CONTENTS,
	FIXTURE_FILES,
	FIXTURE_FILES_WITH_DRIFT,
	FIXTURE_SESSION,
	FIXTURE_WALKTHROUGH,
	FIXTURE_WALKTHROUGH_FULLY_COVERED,
	FIXTURE_WALKTHROUGH_WITH_GAPS,
	TODOS_PATH,
} from "./walkthrough.fixture";
import { WalkthroughView } from "./walkthrough-view";

type WalkthroughViewProps = React.ComponentProps<typeof WalkthroughView>;

function StatefulWalkthroughView({
	initialSelection = null,
	...props
}: Omit<WalkthroughViewProps, "selection" | "onSelectionChange"> & {
	initialSelection?: WalkthroughSelection | null;
}): React.ReactElement {
	const [selection, setSelection] = useState(initialSelection);
	return (
		// `bg-pane-surface text-foreground` mirrors `AppShell`'s `INSET_PANE_CLASS`
		// — the real app never renders `WalkthroughView` directly against `body`
		// (`bg-neutral-100`, unthemed), always inside that themed surface. Without
		// it, dark mode renders `text-foreground`'s near-white text on the body's
		// always-light background instead of on a themed dark surface.
		<div className="flex h-screen flex-col bg-pane-surface text-foreground">
			<WalkthroughView
				{...props}
				onSelectionChange={setSelection}
				selection={selection}
			/>
		</div>
	);
}

const meta: Meta<typeof StatefulWalkthroughView> = {
	title: "Walkthrough/WalkthroughView",
	component: StatefulWalkthroughView,
	// None of these args (a `Proxy`-backed oRPC client, a session, a file
	// list) are meaningful to hand-edit via the Controls panel — each story
	// exists to show one fixed state, not to be tweaked live.
	parameters: { layout: "fullscreen", controls: { disable: true } },
};
export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The main state: a stored walkthrough, no drift, a reference block already
 * selected. `FIXTURE_WALKTHROUGH` carries no `uncoveredFiles` at all, so this
 * doubles as the "coverage unknown" state — a walkthrough generated before
 * that field existed — for `UncoveredFiles`: nothing renders below the
 * reader.
 */
export const Loaded: Story = {
	args: {
		orpc: createMockOrpc({
			storedWalkthrough: FIXTURE_WALKTHROUGH,
			fileContents: FIXTURE_FILE_CONTENTS,
		}),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES,
		initialSelection: { kind: "reference", id: "toggle-mutation" },
	},
};

/** Same walkthrough, but every changed line is claimed by some reference block — `UncoveredFiles` renders its quiet "covers every changed line" line, not a collapsible. */
export const CoverageComplete: Story = {
	args: {
		orpc: createMockOrpc({
			storedWalkthrough: FIXTURE_WALKTHROUGH_FULLY_COVERED,
			fileContents: FIXTURE_FILE_CONTENTS,
		}),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES,
		initialSelection: { kind: "reference", id: "toggle-mutation" },
	},
};

/** Same walkthrough, with real gaps (`FIXTURE_UNCOVERED_FILES`) — `UncoveredFiles` renders its collapsed-by-default footer, expandable into the per-file line counts. */
export const CoverageGaps: Story = {
	args: {
		orpc: createMockOrpc({
			storedWalkthrough: FIXTURE_WALKTHROUGH_WITH_GAPS,
			fileContents: FIXTURE_FILE_CONTENTS,
		}),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES,
		initialSelection: { kind: "reference", id: "toggle-mutation" },
	},
};

/**
 * Same gaps as `CoverageGaps`, but with one of the uncovered files clicked
 * instead of a reference block — the reference pane resolves it via
 * `WalkthroughView`'s `resolveSelection`, showing exactly `TODOS_PATH`'s
 * skipped ranges rather than a real narrated block. Also the easiest way to
 * see that rendering without actually clicking through in Storybook's
 * interaction panel.
 */
export const UncoveredFileSelected: Story = {
	args: {
		orpc: createMockOrpc({
			storedWalkthrough: FIXTURE_WALKTHROUGH_WITH_GAPS,
			fileContents: FIXTURE_FILE_CONTENTS,
		}),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES,
		initialSelection: { kind: "uncovered", path: TODOS_PATH },
	},
};

/** Nothing generated yet for this session — `GeneratePanel`'s empty state with a harness/model picker ready to go. */
export const NoWalkthroughYet: Story = {
	args: {
		orpc: createMockOrpc({ storedWalkthrough: null }),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES,
	},
};

/** A generation streaming in — `GenerationTimeline`'s turn-by-turn log, replayed on a loop with no terminal event so the story stays put. */
export const GenerationInProgress: Story = {
	args: {
		orpc: createMockOrpc({
			storedWalkthrough: null,
			runningGeneration: {
				harness: "claude-code",
				model: "claude-opus-4-5",
				events: [
					{ type: "bootstrapping" },
					{ type: "turn-started", turn: 1 },
					{
						type: "tool-call",
						turn: 1,
						toolName: "read",
						input: { file_path: "src/lib/todos.ts" },
					},
					{
						type: "tool-call",
						turn: 1,
						toolName: "read",
						input: { file_path: "src/components/todo-item.tsx" },
					},
					{ type: "turn-started", turn: 2 },
					{
						type: "tool-call",
						turn: 2,
						toolName: "bash",
						input: { command: "git log -p -- src/lib/todos.ts" },
					},
					{
						type: "validation-failed",
						turn: 2,
						feedback:
							"Section 'Debounced persistence' has no reference block covering src/lib/todos.ts's schedulePersist.",
					},
					{ type: "retrying", turn: 3 },
				],
			},
		}),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES,
	},
};

/** A file a selected block references has changed since generation — `OutdatedBanner` above the reader, all three drift badges represented. */
export const Drift: Story = {
	args: {
		orpc: createMockOrpc({
			storedWalkthrough: FIXTURE_WALKTHROUGH,
			fileContents: FIXTURE_FILE_CONTENTS,
		}),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES_WITH_DRIFT,
		initialSelection: { kind: "reference", id: "checkbox-ui" },
	},
};

/** First use, before the onboarding "which harnesses do you have set up?" gate has ever been answered — `settings.enabledHarnesses === null`. */
export const NoHarnessesEnabled: Story = {
	args: {
		orpc: createMockOrpc({
			storedWalkthrough: null,
			settings: { enabledHarnesses: null },
		}),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES,
	},
};
