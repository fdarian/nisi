import { expect, test } from "bun:test";
import { appProcessIds } from "./measure-launch-processes.ts";

test("cold shutdown targets exact app executables, not dev sandboxes or helpers", () => {
	expect(
		appProcessIds(
			" 12 /Applications/nisi.app/Contents/MacOS/nisi\n 13 /scratch/target/debug/bundle/macos/nisi.app/Contents/MacOS/nisi\n 14 /Applications/nisi.app/Contents/Frameworks/nisi Helper.app/Contents/MacOS/nisi Helper",
			["/Applications/nisi.app"],
		),
	).toEqual([12]);
	expect(
		appProcessIds(" 15 /scratch/Custom App.app/Contents/MacOS/nisi", [
			"/scratch/Custom App.app",
		]),
	).toEqual([15]);
});
