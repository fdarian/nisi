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

/**
 * The jobs API reports step times in whole seconds while log lines carry
 * fractions, so a step's trailing output (e.g. the `Process completed with
 * exit code` line) is stamped after its reported end. A step therefore keeps
 * everything up to the end of its last reported second.
 */
const endOfSecond = (ms: number) => Math.floor(ms / 1000) * 1000 + 1000;

/**
 * Lines are assigned by a cursor that only moves forward, so the shared
 * second where one step ends and the next starts can be split: the cursor
 * stays put for trailing output, and moves early on a `##[group]` opener,
 * which is how the next step's own output begins. Inter-step runner output
 * belongs to the preceding step; preamble belongs to the first.
 */
export function parseActionsLog(raw: string, steps: readonly StepWindow[]) {
	const result = steps.map((step) => ({
		number: step.number,
		nodes: [] as ActionsLogNode[],
	}));
	const stacks = result.map((step) => [step.nodes]);
	const cursor = { index: 0 };
	// Job logs start with a UTF-8 BOM, which would break the timestamp match on the first line.
	for (const rawLine of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const match = /^(\S+) (.*)$/.exec(rawLine);
		if (match === null || match[1] === undefined || match[2] === undefined)
			continue;
		const timestamp = Date.parse(match[1]);
		if (!Number.isFinite(timestamp)) continue;
		const text = match[2];
		while (true) {
			const next = steps.findIndex(
				(step, index) => index > cursor.index && step.started_at !== null,
			);
			const current = steps[cursor.index];
			const following = steps[next];
			if (
				current === undefined ||
				following === undefined ||
				following.started_at === null ||
				timestamp < Date.parse(following.started_at)
			)
				break;
			if (
				current.completed_at !== null &&
				timestamp < endOfSecond(Date.parse(current.completed_at)) &&
				!text.startsWith("##[group]")
			)
				break;
			cursor.index = next;
		}
		const index = cursor.index;
		const stack = stacks[index];
		const nodes = stack === undefined ? undefined : stack[stack.length - 1];
		if (stack === undefined || nodes === undefined) continue;
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

function stripLogAnsi(text: string): string {
	const escapeCharacter = String.fromCharCode(27);
	const bell = String.fromCharCode(7);
	return text.replace(
		new RegExp(
			`${escapeCharacter}\\][^${bell}${escapeCharacter}]*(?:${bell}|${escapeCharacter}\\\\)|${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`,
			"g",
		),
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
			for (const entry of lines.entries()) {
				const index = entry[0];
				const line = entry[1];
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
			const output = [stripLogAnsi(step.name)];
			const gap = { count: 0 };
			for (const entry of lines.entries()) {
				const index = entry[0];
				const line = entry[1];
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
