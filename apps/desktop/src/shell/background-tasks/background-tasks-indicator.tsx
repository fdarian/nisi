"use client";

import type React from "react";
import type { Session } from "#/features/pull-request/data/pr-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackgroundTasks } from "./background-tasks-data";
import { BackgroundTasksPill } from "./background-tasks-pill";

/** Merges still running for PRs whose tab is closed; `sessions` is the open-tab list the strip already holds. */
export function BackgroundTasksIndicator(props: {
	orpc: SidecarQueryUtils;
	sessions: readonly Session[];
}): React.ReactElement | null {
	const background = useBackgroundTasks(props.orpc, props.sessions);
	return (
		<BackgroundTasksPill
			onStop={background.stop}
			stoppingKeys={background.stoppingKeys}
			tasks={background.tasks}
		/>
	);
}
