import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { SidecarClient } from "@repo/sidecar-api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { UpdatePill } from "#/shell/update/update-pill";
import {
	type BackgroundTask,
	backgroundTaskKey,
	type ScheduledMergeTask,
} from "./background-tasks-data";
import { BackgroundTasksPill } from "./background-tasks-pill";

const SCHEDULED: ScheduledMergeTask = {
	kind: "scheduled-merge",
	owner: "acme",
	repo: "widgets",
	number: 412,
	title: "Add repository filters to the command palette",
	method: "squash",
	route: "merge",
	repoRoot: "/Users/me/code/acme/widgets",
};

const MIXED: readonly BackgroundTask[] = [
	SCHEDULED,
	{
		kind: "scheduled-merge",
		owner: "acme",
		repo: "api",
		number: 97,
		title: "Split the billing module into its own package",
		method: "rebase",
		route: "stack",
		repoRoot: "/Users/me/code/acme/api",
	},
	{
		kind: "merging",
		owner: "acme",
		repo: "widgets",
		number: 430,
		title: "Improve tracked change navigation",
		method: "merge",
		route: "merge",
	},
	{
		kind: "merging",
		owner: "fdarian",
		repo: "nisi",
		number: 152,
		method: "squash",
		route: "stack",
	},
	{
		kind: "scheduled-merge",
		owner: "fdarian",
		repo: "deskkit",
		number: 31,
		method: "merge",
		route: "merge",
		repoRoot: "/Users/me/code/fdarian/deskkit",
	},
];

const meta: Meta<typeof BackgroundTasksPill> = {
	title: "Shell/BackgroundTasksPill",
	component: BackgroundTasksPill,
	parameters: { layout: "fullscreen", controls: { disable: true } },
	args: { onStop: () => {}, stoppingKeys: new Set<string>() },
	// Mimics the tab strip's right edge: the pill sits at the end of a row and the popover opens beneath it.
	decorators: [
		(Story) => (
			<div className="flex h-96 w-[720px] items-start justify-end bg-pane-surface p-2">
				<Story />
			</div>
		),
	],
};
export default meta;

type Story = StoryObj<typeof meta>;

export const OneScheduledMerge: Story = {
	args: { tasks: [SCHEDULED] },
};

export const MixedTasks: Story = {
	args: { tasks: MIXED },
};

export const MixedTasksOpen: Story = {
	args: { tasks: MIXED, defaultOpen: true },
};

export const StoppingInProgress: Story = {
	args: {
		tasks: MIXED,
		defaultOpen: true,
		stoppingKeys: new Set([backgroundTaskKey(MIXED[1])]),
	},
};

export const Empty: Story = {
	name: "Empty (renders nothing)",
	args: { tasks: [] },
};

/** Stop shows its pending state for a moment, then the task leaves the list like it does once the sidecar settles it. */
export const InteractiveStop: Story = {
	args: { defaultOpen: true },
	render: function Render(args) {
		const [tasks, setTasks] = useState<readonly BackgroundTask[]>(MIXED);
		const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
		const [settling, setSettling] = useState<ScheduledMergeTask | null>(null);
		useEffect(() => {
			if (settling === null) return;
			const timer = setTimeout(() => {
				setTasks((current) =>
					current.filter(
						(task) => backgroundTaskKey(task) !== backgroundTaskKey(settling),
					),
				);
				setStopping(new Set());
				setSettling(null);
			}, 1200);
			return () => clearTimeout(timer);
		}, [settling]);
		return (
			<BackgroundTasksPill
				{...args}
				onStop={(task) => {
					setStopping(new Set([backgroundTaskKey(task)]));
					setSettling(task);
				}}
				stoppingKeys={stopping}
				tasks={tasks}
			/>
		);
	},
};

function updatePillOrpc(): SidecarQueryUtils {
	const client = {
		update: {
			status: async () => ({ type: "available", version: "0.3.0" }),
			download: async () => undefined,
			restart: async () => undefined,
		},
	} as unknown as SidecarClient;
	return createTanstackQueryUtils(client);
}

const updateOrpc = updatePillOrpc();

/** How the pill sits in the tab strip: immediately left of the update pill. */
export const BesideUpdatePill: Story = {
	args: { tasks: MIXED, defaultOpen: true },
	render: (args) => (
		<div className="flex items-center gap-2 self-start">
			<BackgroundTasksPill {...args} />
			<UpdatePill orpc={updateOrpc} />
		</div>
	),
};
