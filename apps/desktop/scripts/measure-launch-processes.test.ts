import { expect, test } from "bun:test";
import { bundleProcessIds } from "./measure-launch-processes.ts";

test("cold shutdown selects the exact worktree executable and its bundled sidecar child", () => {
	const bundle = "/work tree/nisi.app";
	expect(
		bundleProcessIds(
			[
				`101 1 ${bundle}/Contents/MacOS/nisi`,
				`102 101 ${bundle}/Contents/MacOS/sidecar`,
				`104 1 ${bundle}/Contents/MacOS/sidecar`,
				`103 101 ${bundle}/Contents/Frameworks/nisi Helper.app/Contents/MacOS/nisi Helper`,
				"200 1 /Applications/nisi.app/Contents/MacOS/nisi",
				"201 200 /Applications/nisi.app/Contents/MacOS/sidecar",
				"300 1 /other worktree/nisi.app/Contents/MacOS/nisi",
			].join("\n"),
			bundle,
		),
	).toEqual([101, 102, 104]);
});
