import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { buildGuide } from "../../../sidecar/guide/build";
import { evaluateGuide } from "./evaluate";
import { GUIDE_COMPONENTS } from "./guide-components";
import { GuideProvider } from "./guide-context";
import { htmlToText } from "./guide-text";
import { renderGuideHtml } from "./static-render";
import { checkGuide, type DiffFile, validateGuide } from "./validate";

const SAMPLE = join(import.meta.dir, "sample");
let repoRoot: string;
let headSha: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await proc.stdout.text();
	if ((await proc.exited) !== 0) {
		throw new Error(`git ${args.join(" ")}: ${await proc.stderr.text()}`);
	}
	return out.trim();
}

function checkRecord(overrides: Record<string, unknown>) {
	return {
		title: "Check",
		command: "bun test",
		exitCode: 0,
		durationMs: 1200,
		sha: headSha,
		at: "2026-10-09T03:00:00.000Z",
		output: "all good",
		...overrides,
	};
}

function file(
	path: string,
	additions: number,
	deletions: number,
	...changed: [number, number][]
): DiffFile {
	return {
		path,
		additions,
		deletions,
		hunks: changed.map(([startLine, endLine], index) => ({
			startLine,
			endLine,
			additions: endLine - startLine + 1,
			deletions: index === 0 ? deletions : 0,
		})),
	};
}

/** The diff the sample guide describes: every source file falls in one of its three Areas, and its Refs land on changed lines. */
const SAMPLE_DIFF: DiffFile[] = [
	file(".claude/skills/nisi-guide/scripts/check.ts", 113, 0, [1, 113]),
	file(".claude/skills/nisi-guide/scripts/validate.ts", 100, 0, [1, 100]),
	file("apps/desktop/sidecar/guide/build.ts", 98, 30, [60, 100]),
	file("packages/sidecar-api/src/guide.ts", 27, 0, [1, 27]),
	file("apps/desktop/src/features/guide/evaluate.ts", 10, 2, [30, 65]),
	// Exempt from Areas: counted nowhere and needing no cover.
	file(
		"apps/desktop/src/features/guide/guide-pipeline.test.ts",
		50,
		0,
		[1, 50],
	),
	file("pnpm-lock.yaml", 300, 0, [1, 300]),
];

async function writeCheck(slug: string, record: unknown) {
	const dir = join(repoRoot, ".nisi/guide/checks");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${slug}.json`), JSON.stringify(record));
}

beforeAll(async () => {
	// `renderToString` has no DOM; `NeedsYou` ticks read localStorage.
	Object.assign(globalThis, {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	});
	repoRoot = await mkdtemp(join(tmpdir(), "nisi-guide-"));
	await mkdir(join(repoRoot, ".nisi"));
	await cp(SAMPLE, join(repoRoot, ".nisi/guide"), { recursive: true });
	await git(repoRoot, "init", "-q");
	await git(
		repoRoot,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	headSha = await git(repoRoot, "rev-parse", "HEAD");
	await writeCheck(
		"type-check",
		checkRecord({
			title: "Type check and lint",
			command: "pnpm turbo run check:type",
		}),
	);
	await writeCheck(
		"unit-tests",
		checkRecord({
			title: "Unit tests",
			exitCode: 1,
			dirty: true,
			sha: "0123456789abcdef0123456789abcdef01234567",
			at: "2026-10-09T03:05:00.000Z",
			output: "1 test failed",
		}),
	);
});

afterAll(() => rm(repoRoot, { recursive: true, force: true }));

test("a repo without a guide reports it missing, with the path to write", async () => {
	const empty = await mkdtemp(join(tmpdir(), "nisi-guide-empty-"));
	try {
		const result = await buildGuide(empty);
		expect(result).toEqual({
			kind: "missing",
			path: join(empty, ".nisi/guide/guide.mdx"),
		});
	} finally {
		await rm(empty, { recursive: true, force: true });
	}
});

test("the sample guide builds, evaluates against the kit, and renders every component", async () => {
	const result = await buildGuide(repoRoot);
	if (result.kind !== "ok") throw new Error(JSON.stringify(result));
	expect(result.code).toContain('require("@nisi/guide")');
	expect(result.code).toContain("data:image/png;base64,");
	expect(result.headSha).toBe(headSha);
	expect(result.checks.map((check) => check.title)).toEqual([
		"Type check and lint",
		"Unit tests",
	]);

	const Guide = evaluateGuide(result.version, result.code);
	// React separates adjacent text nodes with comment markers.
	const html = renderToString(
		createElement(
			GuideProvider,
			{
				value: {
					sessionId: "s1",
					files: SAMPLE_DIFF,
					changedPaths: new Set(SAMPLE_DIFF.map((entry) => entry.path)),
					checks: result.checks,
					headSha: result.headSha,
					selectedRef: null,
					selectRef: () => {},
					symbols: new Map(),
					areaOrder: ["authoring", "bundle", "app"],
					setAreaOrder: () => {},
					hoveredArea: null,
					setHoveredArea: () => {},
				},
			},
			createElement(Guide, { components: GUIDE_COMPONENTS as never }),
		),
	).replace(/<!-- -->/g, "");

	// The guide starts at its Overview: no title, the app shows the PR's.
	expect(html).not.toContain("<h1");
	expect(html).toMatch(/<h2[^>]*>Overview<\/h2>/);

	// Areas: the agent writes the bullets, nisi computes each card's stat from
	// the diff, leaving tests and lockfiles out.
	expect(html).toContain("Authoring");
	const text = html.replace(/<[^>]*>/g, "");
	expect(text).toContain("2 files +213");
	expect(text).toContain("2 files +125 −30");
	expect(text).toContain("1 file +10 −2");

	// Sequence: After is shown by default, with its caption and a Before toggle.
	expect(html).toContain("Getting a check result into the guide");
	expect(html).toMatch(/aria-pressed="true"[^>]*>after</);
	expect(html).toMatch(/aria-pressed="false"[^>]*>before</);
	expect(html).toContain("check.ts runs it");
	expect(html).not.toContain("runs tests, types the result");
	expect(html).toContain("so the tab can say when it&#x27;s stale");
	expect(html).toContain("Settings, after");
	expect(html).toContain("The new row highlights the active repository");
	expect(html).toContain("1 / 3");
	expect(html).toContain("A custom local component");
	expect(html).toContain("value 1 of 5");
	// Pins and captions are buttons that cross-highlight.
	expect(html).toContain('aria-label="Pin 1"');
	expect(html).toContain('aria-label="Highlight pin 1"');

	// A Ref shows its basename (and lines); the full path lives in the tooltip.
	expect(html).toContain(">build.ts:70-95<");
	expect(html).not.toContain(">apps/desktop/sidecar/guide/build.ts:70-95<");
	expect(html).not.toContain("not in diff");

	// Refs: one in an Area, two in a Note, and two backticked changed paths
	// that autolink. A backticked path outside the diff stays code.
	const refButtons = html.match(
		/<button[^>]*class="[^"]*font-mono text-\[10\.5px\][^"]*"/g,
	);
	expect(refButtons?.length).toBe(5);
	expect(html).toMatch(/<code[^>]*>README\.md<\/code>/);

	// Checks come from the recorded runs: the one at head is current, the one
	// at another commit is stale and failed; Skipped is its own row.
	expect(html).toContain("Type check and lint");
	expect(html).toContain(`at ${headSha.slice(0, 7)}`);
	expect(html).toContain("at 0123456");
	expect(html.match(/>stale</g)?.length).toBe(1);
	expect(html).toContain('aria-label="Failed, exit 1"');
	expect(html).toContain("Run against the production compiled binary");
	expect(html).toContain("Needs a signed build.");

	expect(html).toContain("0 / 2");
	expect(html).toContain("Confirm eval is acceptable under the production CSP");
	expect(html).toContain("The Guide tab runs the bundle with");
});

test("rebuilding an unchanged guide is a cache hit; an edit bumps the version", async () => {
	const first = await buildGuide(repoRoot);
	const again = await buildGuide(repoRoot);
	if (first.kind !== "ok" || again.kind !== "ok")
		throw new Error("build failed");
	expect(again.version).toBe(first.version);
	expect(again.code).toBe(first.code);

	// A recorded run is not bundle input: it must not trigger a rebuild.
	await writeCheck("another", checkRecord({ title: "Another" }));
	const withCheck = await buildGuide(repoRoot);
	if (withCheck.kind !== "ok") throw new Error("build failed");
	expect(withCheck.version).toBe(first.version);
	expect(withCheck.checks).toHaveLength(3);

	// Neither is a preview from `render.ts`.
	await mkdir(join(repoRoot, ".nisi/guide/.preview"), { recursive: true });
	await writeFile(join(repoRoot, ".nisi/guide/.preview/full.png"), "x");
	const withPreview = await buildGuide(repoRoot);
	if (withPreview.kind !== "ok") throw new Error("build failed");
	expect(withPreview.version).toBe(first.version);

	await writeFile(join(repoRoot, ".nisi/guide/extra.txt"), "changed");
	const edited = await buildGuide(repoRoot);
	if (edited.kind !== "ok") throw new Error("build failed");
	expect(edited.version).not.toBe(first.version);
});

test("a syntax error in the guide is an error result, not a throw", async () => {
	const broken = await mkdtemp(join(tmpdir(), "nisi-guide-broken-"));
	try {
		await mkdir(join(broken, ".nisi/guide"), { recursive: true });
		await writeFile(
			join(broken, ".nisi/guide/guide.mdx"),
			"# hi\n\n<Outcome>never closed\n",
		);
		const result = await buildGuide(broken);
		expect(result.kind).toBe("error");
	} finally {
		await rm(broken, { recursive: true, force: true });
	}
});

test("a guide importing an unprovided module fails at evaluation with a readable message", () => {
	expect(() => evaluateGuide("test-bad-import", 'require("left-pad")')).toThrow(
		'"left-pad"',
	);
});

async function buildInline(mdx: string) {
	const dir = await mkdtemp(join(tmpdir(), "nisi-guide-inline-"));
	try {
		await mkdir(join(dir, ".nisi/guide"), { recursive: true });
		await writeFile(join(dir, ".nisi/guide/guide.mdx"), mdx);
		await git(dir, "init", "-q");
		await git(
			dir,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"init",
		);
		return await buildGuide(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("validate: the sample guide is clean against its own diff, except for the stale check", async () => {
	const result = await buildGuide(repoRoot);
	// "Unit tests" was recorded at another commit on purpose (see beforeAll).
	expect(validateGuide(result, SAMPLE_DIFF)).toEqual([
		expect.stringContaining('Check "Unit tests" was recorded at 0123456'),
	]);
});

test("validate: reports a changed source file no Area covers, never a test or lockfile", async () => {
	const result = await buildGuide(repoRoot);
	const problems = validateGuide(result, [
		...SAMPLE_DIFF,
		file("packages/git/src/new-thing.ts", 5, 0, [1, 5]),
		file("packages/git/src/new-thing.test.ts", 5, 0, [1, 5]),
	]);
	const uncovered = problems.filter((problem) =>
		problem.includes("no Area covers"),
	);
	expect(uncovered).toHaveLength(1);
	expect(uncovered[0]).toContain("packages/git/src/new-thing.ts");
	expect(uncovered[0]).not.toContain("new-thing.test.ts");
	expect(uncovered[0]).not.toContain("pnpm-lock.yaml");
});

test("validate: a Ref whose lines miss every hunk, or whose path isn't in the diff, is reported", async () => {
	const result = await buildGuide(repoRoot);
	const problems = validateGuide(
		result,
		SAMPLE_DIFF.filter(
			(entry) => entry.path !== "apps/desktop/src/features/guide/evaluate.ts",
		)
			.map((entry) =>
				entry.path === "apps/desktop/sidecar/guide/build.ts"
					? file(entry.path, 98, 30, [1, 10])
					: entry,
			)
			.concat(
				file("apps/desktop/src/features/guide/evaluate.ts", 1, 0, [1, 5]),
			),
	);
	expect(problems.join("\n")).toContain(
		"Ref apps/desktop/sidecar/guide/build.ts:70-95: those lines aren't in any diff hunk",
	);
	expect(problems.join("\n")).toContain(
		"Ref apps/desktop/src/features/guide/evaluate.ts:36-60: those lines aren't in any diff hunk",
	);

	const outside = validateGuide(result, []);
	expect(outside.join("\n")).toContain(
		"Ref apps/desktop/sidecar/guide/build.ts:70-95 is not in the diff",
	);
});

test("validate: an h1, a missing Overview, and a missing Areas are each reported", async () => {
	const result = await buildInline("# A title\n\nSome words.\n");
	const problems = validateGuide(result, []);
	expect(problems.join("\n")).toContain("has an h1");
	expect(problems.join("\n")).toContain("no `## Overview`");
	expect(problems.join("\n")).toContain("no `<Areas>`");
});

test("validate: a Sequence step naming an unknown area, or an Item without a title, is reported", async () => {
	const unknownArea = await buildInline(`## Overview

<Sequence title="Flow" lanes={["A"]}>
	<After>
		<Step lane="A" area="nope" span={1}>go</Step>
	</After>
</Sequence>

<Areas>
	<Area id="real" title="Real" paths={["src/**"]}>
		- thing
	</Area>
</Areas>
`);
	expect(validateGuide(unknownArea, []).join("\n")).toContain(
		'names area "nope"',
	);

	const untitled = await buildInline(`## Overview

<Areas>
	<Area id="real" title="Real" paths={["src/**"]}>
		- thing
	</Area>
</Areas>

<NeedsYou>
	<Item id="x">Do it</Item>
</NeedsYou>
`);
	expect(validateGuide(untitled, []).join("\n")).toContain(
		'<Item id="x"> needs a title',
	);
});

test("a Sequence step in a lane it didn't declare fails the render with the lane named", async () => {
	const result = await buildInline(`<Sequence title="Flow" lanes={["A"]}>
	<After>
		<Step lane="B" span={1}>go</Step>
	</After>
</Sequence>
`);
	expect(validateGuide(result, []).join("\n")).toContain('no lane "B"');
});

test("the static render colors Areas, and expanded shows every Tour frame and both Sequence states", async () => {
	const result = await buildGuide(repoRoot);
	if (result.kind !== "ok") throw new Error("build failed");

	const collapsed = renderGuideHtml(result, SAMPLE_DIFF, { expanded: false });
	expect(collapsed).not.toContain("runs tests, types the result");
	expect(collapsed).not.toContain("Its sessions load below");
	// The first Area's dot is a palette color, not the neutral one.
	expect(collapsed).toContain("bg-violet-500");

	const expanded = renderGuideHtml(result, SAMPLE_DIFF, { expanded: true });
	expect(expanded).toContain("runs tests, types the result");
	expect(expanded).toContain("check.ts runs it");
	expect(expanded).toContain("Start from the repositories list");
	expect(expanded).toContain("Its sessions load below");
	expect(expanded).toContain("Frames without a");
	// Area file lists are open.
	expect(expanded).toContain('aria-expanded="true"');
});

test("the text linearisation carries the computed values", async () => {
	const result = await buildGuide(repoRoot);
	if (result.kind !== "ok") throw new Error("build failed");
	const out = htmlToText(
		renderGuideHtml(result, SAMPLE_DIFF, { expanded: true }),
	);

	expect(out).toContain("## Overview");
	expect(out).toContain("2 files +213");
	expect(out).toContain("- ⟨check.ts⟩ +113");
	expect(out).toContain(
		"[Passed] Type check and lint `pnpm turbo run check:type` at",
	);
	expect(out).toMatch(
		/\[Failed, exit 1\] Unit tests .* at 0123456 with uncommitted changes stale/,
	);
	expect(out).toContain("Not run");
	expect(out).toContain("Agent: [runs tests, types the result]");
	expect(out).toContain("Sidecar: [wait]");
	// Pin captions restart at 1 in each Tour frame.
	expect(out).toContain("1. Start from the repositories list");
	expect(out).toContain("1. Selected row\n2. Its sessions load below");
	expect(out).toContain(
		"[ ] Confirm eval is acceptable under the production CSP",
	);
	// Nothing of the page's chrome leaks in.
	expect(out).not.toContain("Highlight pin");
	expect(out).not.toContain("time →");
	expect(out).not.toContain("<");
});

test("validate: a Note paragraph over two sentences is reported with a fix; bullets and two sentences are fine", async () => {
	const longNote = await buildInline(`## Overview

<Areas>
	<Area id="real" title="Real" paths={["src/**"]}>
		- thing
	</Area>
</Areas>

<Note label="Too dense">
	It fetches the list. Then it merges with <Ref path="src/a.ts" /> and retries. Finally it saves e.g. the cache. Done.
</Note>

<Note label="Trailing links">
	It fetches the list. It merges the results. <Ref path="src/a.ts" /> \`src/a.ts\`
</Note>

<Note label="Fine">
	Two short sentences. Nothing more.

	- a bullet. Another sentence. And a third in a bullet is not a paragraph.
</Note>
`);
	const problems = validateGuide(longNote, [
		file("src/a.ts", 1, 0, [1, 1]),
	]).filter((problem) => problem.startsWith("Note "));
	expect(problems).toHaveLength(1);
	expect(problems[0]).toContain('"Too dense"');
	expect(problems[0]).toContain("4 sentences");
	expect(problems[0]).toContain("Split it into bullets");
});

test("a ringed Pin draws a ring and a leader line beside its badge; a plain Pin does not", async () => {
	const result =
		await buildInline(`<Shot src="data:image/png;base64,AAAA" alt="x">
	<Pin x={50} y={50} ring>Small icon</Pin>
	<Pin x={10} y={10}>Big target</Pin>
</Shot>
`);
	if (result.kind !== "ok") throw new Error("build failed");
	const html = renderGuideHtml(result, [], { expanded: false });
	expect(html.match(/<title>leader line<\/title>/g)).toHaveLength(1);
	expect(html).toContain('aria-label="Pin 1"');
	expect(html).toContain('aria-label="Pin 2"');
});

test("text: a possessive hugs the backticked path before it", async () => {
	const result = await buildInline(`## Overview

<Areas>
	<Area id="real" title="Real" paths={["src/**"]}>
		- \`src/a.ts\`'s parser and <Ref path="src/a.ts" />'s tests, but 'quoted' stays apart.
	</Area>
</Areas>
`);
	if (result.kind !== "ok") throw new Error("build failed");
	const out = htmlToText(
		renderGuideHtml(result, [file("src/a.ts", 1, 0, [1, 1])], {
			expanded: true,
		}),
	);
	expect(out).toContain("⟨a.ts⟩'s parser and ⟨a.ts⟩'s tests, but 'quoted'");
});

test("validate: a path cited as both a Ref and a backticked path in one paragraph is a warning, not an error", async () => {
	const result = await buildInline(`## Overview

<Areas>
	<Area id="real" title="Real" paths={["src/**"]}>
		- Parsing lives in \`src/a.ts\`. <Ref path="src/a.ts" />
		- Two cites of one file with different lines are fine. <Ref path="src/a.ts" lines="1" /> <Ref path="src/a.ts" lines="2" />
		- Another bullet cites \`src/a.ts\` alone.
	</Area>
</Areas>
`);
	const report = checkGuide(result, [file("src/a.ts", 2, 0, [1, 2])]);
	expect(report.errors).toEqual([]);
	expect(report.warnings).toEqual([
		expect.stringContaining("src/a.ts is cited twice in one paragraph"),
	]);
});

test("text: a name declared once in a changed file reads `name` [path:line]; other code stays plain", async () => {
	const result = await buildInline(`## Overview

<Areas>
	<Area id="real" title="Real" paths={["src/**"]}>
		- \`parseConfig()\` and \`Store.get\` are linked, \`a + b\` and \`unknown\` are not.
	</Area>
</Areas>
`);
	if (result.kind !== "ok") throw new Error("build failed");
	const out = htmlToText(
		renderGuideHtml(result, [file("src/a.ts", 1, 0, [1, 1])], {
			expanded: true,
			symbols: [
				{ name: "parseConfig", path: "src/a.ts", line: 12 },
				{ name: "Store", path: "src/store.ts", line: 3 },
			],
		}),
	);
	expect(out).toContain(
		"`parseConfig()` [src/a.ts:12] and `Store.get` [src/store.ts:3] are linked, `a + b` and `unknown` are not.",
	);
});

test("Item and Skipped titles render backticked segments as inline code, linking a changed path or declared name", async () => {
	const result = await buildInline(`## Overview

<Areas>
	<Area id="real" title="Real" paths={["src/**"]}>
		- Body.
	</Area>
</Areas>

<Checks>
	<Skipped title="Run \`parseConfig()\` for real">Needs creds.</Skipped>
</Checks>

<NeedsYou>
	<Item id="a" title="Read \`src/a.ts\` and \`parseConfig\`, not \`cli.ts\` or a stray \` tick">Why.</Item>
</NeedsYou>
`);
	if (result.kind !== "ok") throw new Error("build failed");
	const html = renderGuideHtml(result, [file("src/a.ts", 1, 0, [1, 1])], {
		expanded: true,
		symbols: [
			{ name: "parseConfig", path: "src/a.ts", line: 12 },
			{ name: "cli", path: "src/cli.ts", line: 1 },
		],
	});
	expect(html).not.toContain("`src/a.ts`");
	const out = htmlToText(html);
	expect(out).toContain("Run `parseConfig()` [src/a.ts:12] for real");
	expect(out).toContain(
		"[ ] Read ⟨a.ts⟩ and `parseConfig` [src/a.ts:12], not `cli.ts` or a stray ` tick",
	);
});
