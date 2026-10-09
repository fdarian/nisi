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
					changedPaths: new Set([
						"apps/desktop/sidecar/guide/build.ts",
						"apps/desktop/src/features/guide/evaluate.ts",
					]),
					checks: result.checks,
					headSha: result.headSha,
					selectedRef: null,
					selectRef: () => {},
				},
			},
			createElement(Guide, { components: GUIDE_COMPONENTS as never }),
		),
	).replaceAll("<!-- -->", "");

	// The page title is the markdown h1, drawn by the app; there is no Outcome.
	expect(html).toMatch(/<h1[^>]*>Guides: write one in \.nisi\/guide/);
	expect(html).not.toContain("Outcome");
	expect(html).toContain("Settings, after");
	expect(html).toContain("The new row highlights the active repository");
	expect(html).toContain("before");
	expect(html).toContain("1 / 3");
	expect(html).toContain("A custom local component");
	expect(html).toContain("value 1 of 5");
	// Pins and captions are buttons that cross-highlight.
	expect(html).toContain('aria-label="Pin 1"');
	expect(html).toContain('aria-label="Highlight pin 1"');

	// A Ref shows its basename (and lines), flags a path outside the diff, and
	// the full path lives in the tooltip rather than the label.
	expect(html).toContain(">build.ts:70-95<");
	expect(html).not.toContain(">apps/desktop/sidecar/guide/build.ts:70-95<");
	expect(html).toContain("not in diff");

	// Three explicit Refs plus two backticked changed paths that autolink; a
	// backticked path outside the diff stays code.
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
