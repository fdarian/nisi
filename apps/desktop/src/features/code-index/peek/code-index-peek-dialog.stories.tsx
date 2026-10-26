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

const SOURCE_PATH = "apps/desktop/sidecar/harness/sandbox.ts";
const TEST_PATH = "apps/desktop/sidecar/harness/test/sandbox.test.ts";
const SYMBOL = "HARNESS_HOME";

const SOURCE_LINES: readonly string[] = [
	'import { homedir } from "node:os";',
	'import { join } from "node:path";',
	'import { resolvedPath } from "@repo/bin-resolver";',
	'import { createLocalSandboxSession } from "ai-sandbox-local";',
	"",
	"/**",
	" * The sandbox's `HOME`: the adapters keep their pinned CLI installs under",
	" * `$HOME/.ai-sdk-harness`, so a stable path keeps the slow first-run install",
	" * warm across dev, prod, and every repo. Deliberately not `NISI_DATA_DIR`-",
	" * derived — dev points that inside the nisi checkout, i.e. inside a pnpm",
	" * workspace, which the install must stay out of.",
	" */",
	`export const ${SYMBOL} = join(homedir(), ".nisi", "harness-home");`,
	"",
	'/** `workDir: "."` makes the agent work directly in the repo. */',
	'export const HARNESS_SANDBOX_CONFIG = { workDir: "." } as const;',
	"",
	"export const createHarnessSandboxSession = (repoRoot: string) =>",
	"	createLocalSandboxSession({",
	"		workingDirectory: repoRoot,",
	`		homeDirectory: ${SYMBOL},`,
	"		env: { PATH: resolvedPath() },",
	"	});",
	"",
	"export const harnessStateDir = (): string =>",
	`	join(${SYMBOL}, ".ai-sdk-harness");`,
];

const TEST_LINES: readonly string[] = [
	'import { describe, expect, test } from "bun:test";',
	'import { homedir } from "node:os";',
	'import { join } from "node:path";',
	'import { HARNESS_HOME, harnessStateDir } from "../sandbox.ts";',
	"",
	'describe("harnessStateDir", () => {',
	'	test("nests the pinned CLI installs under the shared harness home", () => {',
	"		expect(harnessStateDir()).toBe(",
	`			join(${SYMBOL}, ".ai-sdk-harness"),`,
	"		);",
	"	});",
	"",
	'	test("keeps the harness home outside any checkout", () => {',
	`		expect(${SYMBOL}.startsWith(homedir())).toBe(true);`,
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
				isDefinition: lineText.startsWith(`export const ${SYMBOL}`),
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
