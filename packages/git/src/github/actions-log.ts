export type ActionsLogLine = {
	type: "line";
	timestamp: number;
	text: string;
	kind: "plain" | "error" | "warning" | "notice" | "debug" | "command";
};

export type ActionsLogNode =
	| ActionsLogLine
	| {
			type: "group";
			title: string;
			children: readonly ActionsLogNode[];
	  };

type StepWindow = {
	number: number;
	started_at: string | null;
	completed_at: string | null;
};

/** Inter-step runner output belongs to the preceding step; preamble belongs to the first. */
export function parseActionsLog(raw: string, steps: readonly StepWindow[]) {
	const result = steps.map((step) => ({
		number: step.number,
		nodes: [] as ActionsLogNode[],
	}));
	const stacks = result.map((step) => [step.nodes]);
	for (const rawLine of raw.split(/\r?\n/)) {
		const match = /^(\S+) (.*)$/.exec(rawLine);
		if (match === null || match[1] === undefined || match[2] === undefined)
			continue;
		const timestamp = Date.parse(match[1]);
		if (!Number.isFinite(timestamp)) continue;
		const matching = steps.reduce(
			(found, step, index) =>
				step.started_at !== null &&
				timestamp >= Date.parse(step.started_at) &&
				(step.completed_at === null ||
					timestamp <= Date.parse(step.completed_at))
					? index
					: found,
			-1,
		);
		const preceding = steps.reduce(
			(found, step, index) =>
				step.started_at !== null && timestamp >= Date.parse(step.started_at)
					? index
					: found,
			-1,
		);
		const index = matching >= 0 ? matching : Math.max(0, preceding);
		const stack = stacks[index];
		const nodes = stack === undefined ? undefined : stack[stack.length - 1];
		if (stack === undefined || nodes === undefined) continue;
		const text = match[2];
		if (text.startsWith("##[group]")) {
			const group = {
				type: "group" as const,
				title: text.slice(9),
				children: [] as ActionsLogNode[],
			};
			nodes.push(group);
			stack.push(group.children);
		} else if (text.startsWith("##[endgroup]")) {
			if (stack.length > 1) stack.pop();
		} else {
			const marker = /^##\[(error|warning|notice|debug|command)\]/.exec(text);
			const kind = marker?.[1] as ActionsLogLine["kind"] | undefined;
			nodes.push({
				type: "line",
				timestamp,
				text: marker === null ? text : text.slice(marker[0].length),
				kind: kind === undefined ? "plain" : kind,
			});
		}
	}
	return result;
}

export function flattenActionsLog(
	nodes: readonly ActionsLogNode[],
): ActionsLogLine[] {
	return nodes.flatMap((node) =>
		node.type === "line" ? [node] : flattenActionsLog(node.children),
	);
}

export function stripLogAnsi(text: string): string {
	return text.replace(
		new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
		"",
	);
}

export function copyActionsErrors(
	steps: readonly {
		name: string;
		conclusion: string | null;
		nodes: readonly ActionsLogNode[];
	}[],
): string {
	return steps
		.filter(
			(step) =>
				step.conclusion === "failure" ||
				step.conclusion === "timed_out" ||
				step.conclusion === "action_required" ||
				step.conclusion === "startup_failure",
		)
		.map((step) => {
			const lines = flattenActionsLog(step.nodes);
			const selected = new Set<number>();
			for (const [index, line] of lines.entries()) {
				if (
					line.kind === "error" ||
					/\berror\b|✖|×|failed/i.test(stripLogAnsi(line.text))
				) {
					for (
						let cursor = Math.max(0, index - 8);
						cursor <= Math.min(lines.length - 1, index + 8);
						cursor++
					)
						selected.add(cursor);
				}
			}
			for (
				let index = Math.max(0, lines.length - 20);
				index < lines.length;
				index++
			)
				selected.add(index);
			const output = [step.name];
			const gap = { count: 0 };
			for (const [index, line] of lines.entries()) {
				if (!selected.has(index)) {
					gap.count++;
					continue;
				}
				if (gap.count > 0) {
					output.push(`  … ${gap.count} log entries omitted …`);
					gap.count = 0;
				}
				output.push(
					`${new Date(line.timestamp).toISOString()} ${stripLogAnsi(line.text)}`,
				);
			}
			return output.join("\n");
		})
		.join("\n\n");
}
