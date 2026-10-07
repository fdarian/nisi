import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	type FileChange,
	type FileContent,
	useFileChanges,
	useReviewState,
	useSetFileViewed,
} from "#/features/pull-request/data/pr-data";
import { FIXTURE_SESSION } from "#/features/pull-request/walkthrough/walkthrough.fixture";
import {
	StoryQueryBoundary,
	withAppShellProviders,
} from "../../../../.storybook/decorators";
import { createMockOrpc } from "../../../../.storybook/mock-orpc";
import { FilesChangedContent } from "./files-changed-content";

const paths = [
	"src/api/projects",
	"src/components/projects",
	"src/features/review",
	"src/lib/cache",
	"src/lib/network",
];
const files: readonly FileChange[] = paths.flatMap((folder, group) =>
	["index", "queries", "types", "validation"].map((name, index) => ({
		path: `${folder}/${name}.ts`,
		status: index === 3 ? ("added" as const) : ("modified" as const),
		category: "implementation" as const,
		additions: index === 3 ? 8 : 2,
		deletions: index === 3 ? 0 : 1,
		fingerprint: `fixture-${group}-${index}`,
		binary: false,
		review: null,
	})),
);
const fileContents: Readonly<Record<string, FileContent>> = Object.fromEntries(
	files.map((file) => {
		const lines = [
			"export type Project = {",
			"  id: string;",
			"  name: string;",
			"};",
			"",
			"export function projectKey(project: Project): string {",
			'  return ["project", project.id].join(":");',
			"}",
		];
		const patch =
			file.status === "added"
				? ["@@ -0,0 +1,8 @@", ...lines.map((line) => `+${line}`)]
				: [
						"@@ -1,7 +1,8 @@",
						" export type Project = {",
						"   id: string;",
						"+  name: string;",
						" };",
						" ",
						" export function projectKey(project: Project): string {",
						"-  return project.id;",
						'+  return ["project", project.id].join(":");',
						" }",
					];
		return [
			file.path,
			{
				oldContent:
					file.status === "added"
						? ""
						: `${lines
								.filter((line) => line !== "  name: string;")
								.map((line) =>
									line === '  return ["project", project.id].join(":");'
										? "  return project.id;"
										: line,
								)
								.join("\n")}\n`,
				newContent: `${lines.join("\n")}\n`,
				patch: [
					`diff --git a/${file.path} b/${file.path}`,
					`--- ${file.status === "added" ? "/dev/null" : `a/${file.path}`}`,
					`+++ b/${file.path}`,
					...patch,
					"",
				].join("\n"),
				truncated: false,
				review: null,
			},
		];
	}),
);

type StoryArgs = { state: "loading" | "loaded" };
function Pane(props: {
	state?: StoryArgs["state"];
	delay: number;
}): React.ReactElement {
	const orpc = useMemo(
		() => createMockOrpc({ files, fileContents, filesDelayMs: props.delay }),
		[props.delay],
	);
	const changes = useFileChanges(orpc, FIXTURE_SESSION.id);
	const reviewState = useReviewState(orpc, changes.files);
	const setViewed = useSetFileViewed(orpc, FIXTURE_SESSION.id);
	return (
		<FilesChangedContent
			orpc={orpc}
			session={FIXTURE_SESSION}
			files={changes.files}
			reviewState={reviewState}
			setViewed={setViewed}
			isLoading={props.state === "loading" || changes.isLoading}
			error={changes.error}
			hasPendingChanges={false}
			onOpenFile={() => {}}
			onRefresh={() => {}}
			shortcutsEnabled={false}
			isVisible={false}
		/>
	);
}
function Demo(props: StoryArgs & { autoplay?: boolean }): React.ReactElement {
	const replay = useState(0);
	return (
		<div className="flex h-screen flex-col bg-pane-surface">
			<div className="flex h-10 shrink-0 items-center justify-end border-b px-3">
				<Button size="xs" onClick={() => replay[1](replay[0] + 1)}>
					Replay
				</Button>
			</div>
			<StoryQueryBoundary key={replay[0]}>
				<Pane
					state={props.autoplay ? undefined : props.state}
					delay={props.autoplay ? 1500 : 0}
				/>
			</StoryQueryBoundary>
		</div>
	);
}
const meta = {
	title: "Pr/FilesChangedContent",
	decorators: [withAppShellProviders],
	parameters: { layout: "fullscreen" },
	args: { state: "loading" },
	argTypes: { state: { control: "radio", options: ["loading", "loaded"] } },
	render: (args) => <Demo {...args} />,
} satisfies Meta<StoryArgs>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TwoStates: Story = {};
export const SkeletonToLoaded: Story = {
	render: (args) => <Demo {...args} autoplay />,
};
