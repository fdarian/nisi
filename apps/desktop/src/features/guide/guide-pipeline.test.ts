import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { buildGuide } from "../../../sidecar/guide/build";
import { evaluateGuide } from "./evaluate";
import { GuideProvider } from "./guide-context";
import * as kit from "./kit";

const SAMPLE = join(import.meta.dir, "sample");
let repoRoot: string;

beforeAll(async () => {
	// `renderToString` has no DOM; `NeedsYou` ticks read localStorage.
	Object.assign(globalThis, {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	});
	repoRoot = await mkdtemp(join(tmpdir(), "nisi-guide-"));
	await mkdir(join(repoRoot, ".nisi"));
	await cp(SAMPLE, join(repoRoot, ".nisi/guide"), { recursive: true });
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

	const Guide = evaluateGuide(result.version, result.code);
	// React separates adjacent text nodes with comment markers.
	const html = renderToString(
		createElement(
			GuideProvider,
			{
				value: {
					sessionId: "s1",
					changedPaths: new Set(["apps/desktop/sidecar/guide/build.ts"]),
					openFile: () => {},
				},
			},
			createElement(Guide, { components: kit as never }),
		),
	).replaceAll("<!-- -->", "");

	expect(html).toContain("Outcome");
	expect(html).toContain("Settings, after");
	expect(html).toContain("The new row highlights the active repository");
	expect(html).toContain("before");
	expect(html).toContain("1 / 3");
	expect(html).toContain("A custom local component");
	expect(html).toContain("value 1 of 5");
	expect(html).toContain("0 / 2");
	// In the diff: plain. Outside it: flagged.
	expect(html).toContain("apps/desktop/sidecar/guide/build.ts:70-95");
	expect(html).toContain("not in diff");
});

test("rebuilding an unchanged guide is a cache hit; an edit bumps the version", async () => {
	const first = await buildGuide(repoRoot);
	const again = await buildGuide(repoRoot);
	if (first.kind !== "ok" || again.kind !== "ok")
		throw new Error("build failed");
	expect(again).toBe(first);

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
