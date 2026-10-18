import { expect, test } from "bun:test";
import {
	attributedRows,
	bundleHelperIds,
	bundleProcessIds,
} from "./processes.ts";
import { type Shell, shells } from "./shell.ts";

const bundle = "/work tree/nisi.app";
const electron: Shell = { ...shells.electron, bundlePath: bundle };

test("cold shutdown selects the exact worktree executable and its bundled sidecar child", () => {
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
			electron,
		),
	).toEqual([101, 102, 104]);
});

const electrobunBundle = "/work tree/nisi-electrobun.app";
const electrobun: Shell = {
	...shells.electrobun,
	bundlePath: electrobunBundle,
};
const electrobunTable = [
	`10 1 ${electrobunBundle}/Contents/MacOS/launcher`,
	`11 10 ${electrobunBundle}/Contents/MacOS/bun`,
	`12 11 ${electrobunBundle}/Contents/MacOS/sidecar`,
	`13 10 ${electrobunBundle}/Contents/Frameworks/bun Helper (Renderer).app/Contents/MacOS/bun Helper (Renderer)`,
	`14 10 ${electrobunBundle}/Contents/Frameworks/bun Helper (GPU).app/Contents/MacOS/bun Helper (GPU)`,
	`15 1 ${electrobunBundle}/Contents/MacOS/nisi-cli`,
	`20 1 /Applications/nisi.app/Contents/MacOS/sidecar`,
	`21 1 ${electrobunBundle}-other/Contents/MacOS/bun`,
	`22 1 /other tree/nisi.app/Contents/MacOS/nisi`,
].join("\n");

test("Electrobun stops its launcher, bun and sidecar, and leaves CEF helpers to exit on their own", () => {
	expect(bundleProcessIds(electrobunTable, electrobun)).toEqual([10, 11, 12]);
	expect(bundleHelperIds(electrobunTable, electrobun)).toEqual([13, 14, 15]);
});

test("the Electron descriptor does not match Electrobun executables and vice versa", () => {
	expect(bundleProcessIds(electrobunTable, electron)).toEqual([]);
	expect(
		bundleProcessIds(`101 1 ${bundle}/Contents/MacOS/nisi`, electrobun),
	).toEqual([]);
});

test("malformed ps rows fail instead of being skipped", () => {
	expect(() => bundleProcessIds("not a row", electron)).toThrow(
		"Invalid ps row",
	);
});

const webkitBundle = "/work tree/nisi-webkit.app";
const webkit: Shell = {
	...shells["electrobun-webkit"],
	bundlePath: webkitBundle,
};
const xpc = (name: string) =>
	`/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/${name}.xpc/Contents/MacOS/${name}`;
const webkitTable = [
	`10 1 ${webkitBundle}/Contents/MacOS/launcher`,
	`11 10 ${webkitBundle}/Contents/MacOS/bun`,
	`12 11 ${webkitBundle}/Contents/MacOS/sidecar`,
	`30 1 ${xpc("com.apple.WebKit.WebContent")}`,
	`31 1 ${xpc("com.apple.WebKit.GPU")}`,
	`32 1 ${xpc("com.apple.WebKit.Networking")}`,
	`40 1 ${xpc("com.apple.WebKit.WebContent")}`,
	`50 1 /usr/sbin/unattributable`,
].join("\n");

test("processes the OS charges to the app are sampled with the bundle's own", () => {
	const responsible = new Map([
		[30, 11],
		[31, 11],
		[32, 10],
		[40, 999],
	]);
	expect(
		attributedRows(webkitTable, webkit, (pid) => responsible.get(pid)).map(
			(row) => row.pid,
		),
	).toEqual([10, 11, 12, 30, 31, 32]);
});

test("a table with no charged processes yields only the bundle", () => {
	expect(
		attributedRows(electrobunTable, electrobun, () => undefined).map(
			(row) => row.pid,
		),
	).toEqual([10, 11, 12, 13, 14, 15]);
});
