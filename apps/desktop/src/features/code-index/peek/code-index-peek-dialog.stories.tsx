/**
 * Storybook coverage for `CodeIndexPeekDialog` — the VS Code-style "peek
 * references" dialog. Only the `codeIndex.references` / `referenceContext`
 * queries are mocked (`createMockOrpc`'s `codeIndexReferences` and
 * `codeIndexFileLines`); opening a row logs instead of navigating.
 */

import type {
	CodeIndexReference,
	CodeIndexReferencesResult,
} from "@repo/sidecar-api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { createMockOrpc } from "../../../../.storybook/mock-orpc";
import { CodeIndexPeekDialog } from "./code-index-peek-panel";

const SOURCE_PATH = "apps/desktop/sidecar/harness/sandbox-local.ts";
const TEST_PATH = "apps/desktop/sidecar/harness/sandbox-local.test.ts";
const SYMBOL = "HARNESS_SANDBOX_ROOT";

const SOURCE_LINES: readonly string[] = [
	'import { homedir } from "node:os";',
	'import { join } from "node:path";',
	'import type { LocalSandboxSettings } from "@repo/harness-local";',
	'import type { HarnessId } from "#/harness/harness-id";',
	"",
	"/**",
	" * Harnesses whose CLI refuses to run against a path it doesn't own, so the",
	" * worktree has to be mounted somewhere they can write.",
	" */",
	"const HARNESSES_NEEDING_RELOCATION: ReadonlySet<HarnessId> = new Set([",
	'	"codex",',
	'	"opencode",',
	"]);",
	"",
	"/**",
	" * Where a relocated harness keeps its scratch files — a real directory under",
	" * the user's home, not `os.tmpdir()`, so a harness's own trust prompt only",
	" * ever fires once for it.",
	" *",
	" * Shared between dev and every worktree/session on purpose, not a",
	" * per-session path: a warm bootstrap is the whole point of keeping it",
	" * stable.",
	" */",
	`const ${SYMBOL} = join(homedir(), ".nisi", "harness-sandbox");`,
	"",
	"/** Picks the sandbox mode for `harness` against `repoRoot`. */",
	"export const resolveSandboxSettings = (",
	"	harness: HarnessId,",
	"	repoRoot: string,",
	"): LocalSandboxSettings =>",
	"	HARNESSES_NEEDING_RELOCATION.has(harness)",
	`		? { mode: "relocated", repoRoot, scratchRoot: ${SYMBOL} }`,
	'		: { mode: "in-place", repoRoot };',
	"",
	"export const sandboxScratchDir = (harness: HarnessId): string =>",
	`	join(${SYMBOL}, harness);`,
	"",
	"export const isInsideSandbox = (path: string): boolean =>",
	`	path.startsWith(${SYMBOL});`,
];

const TEST_LINES: readonly string[] = [
	'import { describe, expect, test } from "bun:test";',
	'import { join } from "node:path";',
	'import { HARNESS_SANDBOX_ROOT, sandboxScratchDir } from "./sandbox-local";',
	"",
	'describe("sandboxScratchDir", () => {',
	'	test("nests each harness under the shared root", () => {',
	'		expect(sandboxScratchDir("codex")).toBe(',
	'			join(HARNESS_SANDBOX_ROOT, "codex"),',
	"		);",
	"	});",
	"});",
];

function referencesIn(lines: readonly string[]): CodeIndexReference[] {
	return lines.flatMap((lineText, line) => {
		const charStart = lineText.indexOf(SYMBOL);
		if (charStart === -1) return [];
		return [
			{
				line,
				charStart,
				charEnd: charStart + SYMBOL.length,
				lineText,
				isDefinition: lineText.startsWith(`const ${SYMBOL}`),
			},
		];
	});
}

const SOURCE_REFERENCES = referencesIn(SOURCE_LINES);
const TEST_REFERENCES = referencesIn(TEST_LINES);
const DEFINITION = SOURCE_REFERENCES.find(
	(reference) => reference.isDefinition,
);
if (DEFINITION === undefined) throw new Error("Fixture has no definition");

const REFERENCES: CodeIndexReferencesResult = {
	displayName: SYMBOL,
	documentation: [],
	files: [
		{ path: SOURCE_PATH, references: SOURCE_REFERENCES },
		{ path: TEST_PATH, references: TEST_REFERENCES },
	],
	totalReferenceCount: SOURCE_REFERENCES.length + TEST_REFERENCES.length,
	returnedReferenceCount: SOURCE_REFERENCES.length + TEST_REFERENCES.length,
};

const meta: Meta<typeof CodeIndexPeekDialog> = {
	title: "CodeIndex/CodeIndexPeekDialog",
	component: CodeIndexPeekDialog,
	parameters: { controls: { disable: true } },
	args: {
		sessionId: "storybook-session",
		target: {
			path: SOURCE_PATH,
			occurrence: {
				line: DEFINITION.line,
				charStart: DEFINITION.charStart,
				charEnd: DEFINITION.charEnd,
				symbolKey: `${SOURCE_PATH}:${DEFINITION.line}:${DEFINITION.charStart}`,
			},
		},
		onClose: () => console.log("CodeIndexPeekDialog: onClose"),
	},
};
export default meta;

type Story = StoryObj<typeof meta>;

/** `codeIndex.references` hasn't answered yet — the whole body is one loading state. */
export const LoadingReferences: Story = {
	args: { orpc: createMockOrpc() },
};

/** References are in and the clicked one is selected, but its source context is still being read — the left pane shows the preview skeleton. */
export const LoadingSourcePreview: Story = {
	args: {
		orpc: createMockOrpc({
			codeIndexReferences: REFERENCES,
			codeIndexFileLines: "pending",
		}),
	},
};

export const Loaded: Story = {
	args: {
		orpc: createMockOrpc({
			codeIndexReferences: REFERENCES,
			codeIndexFileLines: {
				[SOURCE_PATH]: SOURCE_LINES,
				[TEST_PATH]: TEST_LINES,
			},
		}),
	},
};
