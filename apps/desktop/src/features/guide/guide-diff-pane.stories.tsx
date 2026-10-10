import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ResizablePanel, ResizablePanelGroup } from "#/components/ui/resizable";
import type {
	FileChange,
	FileContent,
	ReviewStateEntry,
} from "#/features/pull-request/data/pr-data";
import { createMockOrpc } from "../../../.storybook/mock-orpc";
import { FIXTURE_SESSION } from "../pull-request/walkthrough/walkthrough.fixture";
import { GuideDiffPane } from "./guide-diff-pane";
import { GuideResizeHandle } from "./guide-resize-handle";
import type { GuideTarget } from "./guide-target";

const meta = {
	title: "Guide/GuideDiffPane",
	parameters: { controls: { disable: true }, layout: "fullscreen" },
} satisfies Meta;
export default meta;

type Story = StoryObj;

const TODOS_PATH = "src/lib/todos.ts";
const TODO_ITEM_PATH = "src/components/todo-item.tsx";
const LINES = 60;
const CHANGED_LINES = [10, 45];

/** 60 numbered lines with two one-line edits, so a scroll target is observable. */
function fixtureFile(path: string): {
	file: FileChange;
	content: FileContent;
} {
	const line = (n: number, edited: boolean) =>
		`export const value${n} = ${edited ? n * 10 : n};`;
	const all = (edited: boolean) =>
		Array.from({ length: LINES }, (_, index) =>
			line(index + 1, edited && CHANGED_LINES.includes(index + 1)),
		);
	const hunk = (at: number) => [
		`@@ -${at - 3},7 +${at - 3},7 @@`,
		...[at - 3, at - 2, at - 1].map((n) => ` ${line(n, false)}`),
		`-${line(at, false)}`,
		`+${line(at, true)}`,
		...[at + 1, at + 2, at + 3].map((n) => ` ${line(n, false)}`),
	];
	return {
		file: {
			path,
			status: "modified",
			category: "implementation",
			additions: CHANGED_LINES.length,
			deletions: CHANGED_LINES.length,
			fingerprint: `fixture-${path}`,
			binary: false,
			hunks: CHANGED_LINES.map((at) => ({
				startLine: at,
				endLine: at,
				additions: 1,
				deletions: 1,
			})),
			review: null,
		},
		content: {
			oldContent: `${all(false).join("\n")}\n`,
			newContent: `${all(true).join("\n")}\n`,
			patch: [
				`diff --git a/${path} b/${path}`,
				`--- a/${path}`,
				`+++ b/${path}`,
				...CHANGED_LINES.flatMap(hunk),
				"",
			].join("\n"),
			truncated: false,
			review: null,
		},
	};
}

const FIXTURES = [
	TODOS_PATH,
	TODO_ITEM_PATH,
	"src/components/todo-list.tsx",
].map(fixtureFile);
const FIXTURE_FILES = FIXTURES.map((fixture) => fixture.file);
const orpc = createMockOrpc({
	files: FIXTURE_FILES,
	fileContents: Object.fromEntries(
		FIXTURES.map((fixture) => [fixture.file.path, fixture.content]),
	),
});

function Split(props: { initial: GuideTarget }): React.ReactElement {
	const [target, setTarget] = useState<GuideTarget | null>(props.initial);
	const [reviewState, setReviewState] = useState<
		ReadonlyMap<string, ReviewStateEntry>
	>(new Map());
	return (
		<div className="flex h-screen bg-pane-surface text-foreground">
			<ResizablePanelGroup
				orientation="horizontal"
				resizeTargetMinimumSize={{ coarse: 12, fine: 12 }}
			>
				<ResizablePanel id="content" minSize="320px">
					<div className="flex flex-col items-start gap-2 p-6 text-sm">
						<p>Guide content</p>
						<button
							onClick={() =>
								setTarget({ ref: { path: TODOS_PATH }, scope: null })
							}
							type="button"
						>
							Open one file
						</button>
						<button
							onClick={() =>
								setTarget({
									ref: { path: TODO_ITEM_PATH, lines: "45" },
									scope: FIXTURE_FILES.map((file) => file.path),
								})
							}
							type="button"
						>
							Open the area, scrolled to todo-item L45
						</button>
					</div>
				</ResizablePanel>
				{target !== null && (
					<>
						<GuideResizeHandle onCollapse={() => setTarget(null)} />
						<ResizablePanel defaultSize="50%" id="diff" minSize="380px">
							<GuideDiffPane
								files={FIXTURE_FILES}
								onClose={() => setTarget(null)}
								onOpenFile={() => {}}
								orpc={orpc}
								reviewState={reviewState}
								session={FIXTURE_SESSION}
								setViewed={(path, viewed) =>
									setReviewState((current) => {
										const next = new Map(current);
										if (viewed) next.set(path, { status: "viewed" });
										else next.delete(path);
										return next;
									})
								}
								target={target}
							/>
						</ResizablePanel>
					</>
				)}
			</ResizablePanelGroup>
		</div>
	);
}

/** One file, as a `Ref` outside any Area opens it. */
export const OneFile: Story = {
	render: () => (
		<Split initial={{ ref: { path: TODOS_PATH, lines: "45" }, scope: null }} />
	),
};

/** An Area's files in one list, scrolled to the clicked file. */
export const AreaFiles: Story = {
	render: () => (
		<Split
			initial={{
				ref: { path: TODO_ITEM_PATH },
				scope: FIXTURE_FILES.map((file) => file.path),
			}}
		/>
	),
};
