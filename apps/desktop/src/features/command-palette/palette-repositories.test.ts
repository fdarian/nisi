import { expect, test } from "bun:test";
import { paletteRepositories, repositoryKey } from "./palette-repositories";

const widgets = { owner: "acme", repo: "widgets" };
const tools = { owner: "acme", repo: "tools" };
const nisi = { owner: "fdarian", repo: "nisi" };

test("recent repositories precede saved repositories, preserving recency and deduping identities", () => {
	expect(
		paletteRepositories([tools, widgets, tools], [widgets, nisi], [], "", []),
	).toEqual([tools, widgets, nisi]);
});

test("repository identity deduplication and applied exclusions are case-insensitive", () => {
	expect(
		paletteRepositories(
			[widgets],
			[{ owner: "ACME", repo: "Widgets" }, tools],
			[{ owner: "ACME", repo: "TOOLS" }],
			"",
			[],
		),
	).toEqual([widgets]);
});

test("local filtering matches a case-insensitive substring across owner/name", () => {
	expect(
		paletteRepositories([widgets, tools], [nisi], [], "ME/WID", []),
	).toEqual([widgets]);
	expect(paletteRepositories([widgets], [nisi], [], "DARIAN", [])).toEqual([
		nisi,
	]);
	expect(paletteRepositories([widgets], [nisi], [], "missing", [])).toEqual([]);
});

test("saved repositories are available even without GitHub results", () => {
	expect(paletteRepositories([], [widgets, tools], [], "", [])).toEqual([
		widgets,
		tools,
	]);
	expect(repositoryKey(widgets)).toBe("acme/widgets");
});

test("remote results follow local matches and are not filtered by the needle", () => {
	const webApp = { owner: "acme", repo: "web-app" };
	expect(
		paletteRepositories([widgets], [nisi], [], "web app", [webApp]),
	).toEqual([webApp]);
	expect(paletteRepositories([widgets], [nisi], [], "acme", [webApp])).toEqual([
		widgets,
		webApp,
	]);
});

test("remote results are deduped against local entries, applied chips, and themselves, case-insensitively", () => {
	const upperWidgets = { owner: "ACME", repo: "Widgets" };
	const upperTools = { owner: "Acme", repo: "TOOLS" };
	const other = { owner: "acme", repo: "other" };
	expect(
		paletteRepositories([widgets], [], [tools], "", [
			upperWidgets,
			upperTools,
			other,
			{ owner: "ACME", repo: "OTHER" },
		]),
	).toEqual([widgets, other]);
});
