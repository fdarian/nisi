import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	missingChromiumFlags,
	parseShellName,
	shells,
	stampFileName,
	wrapperMarker,
} from "./shell.ts";

test("each shell owns its bundle, data dirs and executable lists", () => {
	expect(
		shells.electron.bundlePath.endsWith("release/mac-arm64/nisi.app"),
	).toBe(true);
	expect(
		shells.electrobun.bundlePath.endsWith(
			"build-electrobun/stable-macos-arm64/nisi-electrobun.app",
		),
	).toBe(true);
	expect(shells.electron.buildScript).toBe("build");
	expect(shells.electrobun.buildScript).toBe("build:electrobun");
	expect(shells.electrobun.requiredExecutables).toEqual([
		"Contents/MacOS/launcher",
		"Contents/MacOS/bun",
		"Contents/MacOS/sidecar",
		"Contents/MacOS/nisi-cli",
	]);
	expect(shells.electrobun.stopExecutables).not.toContain(
		"Contents/MacOS/nisi-cli",
	);
	expect(
		new Set([
			shells.electron.coldDataDir,
			shells.electron.newPrDataDir,
			shells.electrobun.coldDataDir,
			shells.electrobun.newPrDataDir,
			shells["electrobun-webkit"].coldDataDir,
			shells["electrobun-webkit"].newPrDataDir,
		]).size,
	).toBe(6);
});

test("the WebKit variant has its own bundle, build script and no Chromium flags", () => {
	const webkit = shells["electrobun-webkit"];
	expect(
		webkit.bundlePath.endsWith(
			"build-electrobun-webkit/stable-macos-arm64/nisi-webkit.app",
		),
	).toBe(true);
	expect(webkit.buildScript).toBe("build:electrobun-webkit");
	expect(webkit.buildEnv).toEqual({});
	expect(webkit.builtChromiumFlags).toEqual([]);
	expect(webkit.selfExtracting).toBe(true);
	expect(webkit.stopBeforeBuild).toBe(true);
	expect(webkit.requiredExecutables).toEqual(
		shells.electrobun.requiredExecutables,
	);
	expect(webkit.stopExecutables).toEqual(shells.electrobun.stopExecutables);
	expect(stampFileName(webkit.bundlePath)).toBe(
		"nisi-webkit.app.build-stamp.json",
	);
	expect(
		[shells.electron, shells.electrobun].map(
			(shell) => shell.attributeByResponsiblePid,
		),
	).toEqual([false, false]);
	expect(webkit.attributeByResponsiblePid).toBe(true);
});

test("Electron's measured behavior is the pre-shell default", () => {
	expect(shells.electron.buildEnv).toEqual({});
	expect(shells.electron.selfExtracting).toBe(false);
	expect(shells.electron.stopExecutables).toEqual([
		"Contents/MacOS/nisi",
		"Contents/MacOS/sidecar",
	]);
	expect(
		shells.electron.coldDataDir.endsWith(".data/measure-launch/data"),
	).toBe(true);
});

test("only Electrobun builds measurement-flavored, since its Chromium flags are build-time", () => {
	expect(shells.electrobun.buildEnv).toEqual({ NISI_MEASUREMENT_BUILD: "1" });
});

test("build stamps are named after the bundle so shells never share one", () => {
	expect(stampFileName(shells.electron.bundlePath)).toBe(
		"nisi.app.build-stamp.json",
	);
	expect(stampFileName(shells.electrobun.bundlePath)).toBe(
		"nisi-electrobun.app.build-stamp.json",
	);
});

test("the wrapper marker lives in the bundle's Resources", () => {
	expect(wrapperMarker(shells.electrobun)).toBe(
		join(shells.electrobun.bundlePath, "Contents/Resources/metadata.json"),
	);
});

test("shell names are validated", () => {
	expect(parseShellName("electrobun")).toBe("electrobun");
	expect(parseShellName("electrobun-webkit")).toBe("electrobun-webkit");
	expect(() => parseShellName("Electron")).toThrow("--shell must be one of");
});

test("a bundle missing recorded measurement flags is reported", () => {
	const required = shells.electrobun.builtChromiumFlags;
	expect(required).toContain("disable-renderer-backgrounding");
	expect(required).toContain("use-mock-keychain");
	const recorded = (flags: Record<string, boolean>) =>
		JSON.stringify({ runtime: {}, chromiumFlags: flags });
	expect(
		missingChromiumFlags(
			recorded(Object.fromEntries(required.map((flag) => [flag, true]))),
			required,
		),
	).toEqual([]);
	expect(
		missingChromiumFlags(JSON.stringify({ runtime: {} }), required),
	).toEqual([...required]);
	expect(
		missingChromiumFlags(recorded({ "use-mock-keychain": false }), [
			"use-mock-keychain",
		]),
	).toEqual(["use-mock-keychain"]);
	expect(shells.electron.builtChromiumFlags).toEqual([]);
});
