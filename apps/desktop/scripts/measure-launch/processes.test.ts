import { expect, test } from "bun:test";
import { bundleProcessIds, bundleRows } from "./processes.ts";

test("cold shutdown selects the exact worktree executable and its bundled sidecar child", () => {
	const bundle = "/work tree/nisi.app";
	expect(
		bundleProcessIds(
			[
				`101 1 ${bundle}/Contents/MacOS/nisi`,
				`102 101 ${bundle}/Contents/MacOS/sidecar`,
				`104 1 ${bundle}/Contents/MacOS/sidecar`,
				`103 101 ${bundle}/Contents/Frameworks/nisi Helper.app/Contents/MacOS/nisi Helper`,
				`105 101 ${bundle}/Contents/Frameworks/nisi Helper (Renderer).app/Contents/MacOS/nisi Helper (Renderer)`,
				`106 101 ${bundle}/Contents/Frameworks/nisi Helper (GPU).app/Contents/MacOS/nisi Helper (GPU)`,
				"200 1 /Applications/nisi.app/Contents/MacOS/nisi",
				"201 200 /Applications/nisi.app/Contents/MacOS/sidecar",
				"300 1 /other worktree/nisi.app/Contents/MacOS/nisi",
			].join("\n"),
			bundle,
		),
	).toEqual([101, 102, 104]);
});

const table = [
	"10 1 /work tree/nisi.app/Contents/MacOS/nisi",
	"11 10 /work tree/nisi.app/Contents/MacOS/sidecar",
	"12 10 /work tree/nisi.app/Contents/Frameworks/nisi Helper (Renderer).app/Contents/MacOS/nisi Helper (Renderer)",
	"13 1 /work tree/nisi.app-other/Contents/MacOS/nisi",
	"14 1 /Applications/nisi.app/Contents/MacOS/nisi",
].join("\n");

test("memory sampling covers every executable inside the bundle and nothing outside it", () => {
	expect(
		bundleRows(table, "/work tree/nisi.app").map((row) => row.pid),
	).toEqual([10, 11, 12]);
});

test("malformed ps rows fail instead of being skipped", () => {
	expect(() => bundleProcessIds("not a row", "/work tree/nisi.app")).toThrow(
		"Invalid ps row",
	);
});
