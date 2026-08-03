/**
 * Storybook coverage for the walkthrough tab's top-level state machine
 * (`WalkthroughView`, `apps/desktop/AGENTS.md`'s "Walkthrough" note) — every
 * state a real generation would eventually produce, without needing a live
 * sidecar or an agent CLI run. `createMockOrpc` (`.storybook/mock-orpc.ts`)
 * stands in for the sidecar; `walkthrough.fixture.ts` is the PR content.
 *
 * `selectedBlockId` is lifted to `PrView` in the real app (so a "reviewed in
 * `<block>`" marker elsewhere can select a block *and* switch tabs) — here
 * `StatefulWalkthroughView` below is the story-local stand-in for that
 * parent, holding the same state `WalkthroughView` expects lifted.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { createMockOrpc } from "../../../.storybook/mock-orpc";
import {
	FIXTURE_FILE_CONTENTS,
	FIXTURE_FILES,
	FIXTURE_FILES_WITH_DRIFT,
	FIXTURE_SESSION,
	FIXTURE_WALKTHROUGH,
} from "./walkthrough.fixture";
import { WalkthroughView } from "./walkthrough-view";

type WalkthroughViewProps = React.ComponentProps<typeof WalkthroughView>;

function StatefulWalkthroughView({
	initialSelectedBlockId = null,
	...props
}: Omit<WalkthroughViewProps, "selectedBlockId" | "onSelectBlock"> & {
	initialSelectedBlockId?: string | null;
}): React.ReactElement {
	const [selectedBlockId, setSelectedBlockId] = useState(
		initialSelectedBlockId,
	);
	return (
		// `bg-pane-surface text-foreground` mirrors `AppShell`'s `INSET_PANE_CLASS`
		// — the real app never renders `WalkthroughView` directly against `body`
		// (`bg-neutral-100`, unthemed), always inside that themed surface. Without
		// it, dark mode renders `text-foreground`'s near-white text on the body's
		// always-light background instead of on a themed dark surface.
		<div className="flex h-screen flex-col bg-pane-surface text-foreground">
			<WalkthroughView
				{...props}
				onSelectBlock={setSelectedBlockId}
				selectedBlockId={selectedBlockId}
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

/** The main state: a stored walkthrough, no drift, a reference block already selected. */
export const Loaded: Story = {
	args: {
		orpc: createMockOrpc({
			storedWalkthrough: FIXTURE_WALKTHROUGH,
			fileContents: FIXTURE_FILE_CONTENTS,
		}),
		session: FIXTURE_SESSION,
		files: FIXTURE_FILES,
		initialSelectedBlockId: "toggle-mutation",
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
		initialSelectedBlockId: "checkbox-ui",
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
