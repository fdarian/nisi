import { join, resolve } from "node:path";
import { MEASUREMENT_CHROMIUM_SWITCHES } from "../../electron/measurement-instance.ts";

export const desktopDir = resolve(import.meta.dir, "../..");

export type ShellName = "electron" | "electrobun" | "electrobun-webkit";
export const shellNames: readonly ShellName[] = [
	"electron",
	"electrobun",
	"electrobun-webkit",
];

export type Shell = {
	name: ShellName;
	bundlePath: string;
	/** `package.json` script that produces the bundle. */
	buildScript: string;
	/** Added to the build's environment. */
	buildEnv: Readonly<Record<string, string>>;
	/** Bundle-relative executables that must exist for the bundle to be usable. */
	requiredExecutables: readonly string[];
	/** Bundle-relative executables of the shell's own process (the window and its host). */
	mainExecutables: readonly string[];
	sidecarExecutable: string;
	/** Bundle-relative executables stopped (SIGTERM) before a cold start. */
	stopExecutables: readonly string[];
	/**
	 * A stable build is a self-extracting wrapper whose first launch replaces the
	 * bundle in place; that has to happen outside any measured run.
	 */
	selfExtracting: boolean;
	/** Rebuilding over a running bundle hangs its quit path. */
	stopBeforeBuild: boolean;
	/** Helpers (CEF) outlive the main processes briefly; stop waits for them too. */
	waitForHelpers: boolean;
	/** Chromium switches the built bundle must record in `Contents/Resources/build.json`. */
	builtChromiumFlags: readonly string[];
	/**
	 * The renderer, GPU and network processes are WebKit XPC services outside the bundle,
	 * found by responsible PID; a sample without a renderer means that attribution failed.
	 */
	webKitHelpers: boolean;
	coldDataDir: string;
	newPrDataDir: string;
};

const measureDir = join(desktopDir, ".data/measure-launch");

export const shells: Readonly<Record<ShellName, Shell>> = {
	electron: {
		name: "electron",
		bundlePath: join(desktopDir, "release/mac-arm64/nisi.app"),
		buildScript: "build",
		buildEnv: {},
		requiredExecutables: ["Contents/MacOS/nisi", "Contents/MacOS/nisi-cli"],
		mainExecutables: ["Contents/MacOS/nisi"],
		sidecarExecutable: "Contents/MacOS/sidecar",
		stopExecutables: ["Contents/MacOS/nisi", "Contents/MacOS/sidecar"],
		selfExtracting: false,
		stopBeforeBuild: false,
		waitForHelpers: false,
		builtChromiumFlags: [],
		webKitHelpers: false,
		coldDataDir: join(measureDir, "data"),
		newPrDataDir: join(measureDir, "new-pr/data"),
	},
	electrobun: {
		name: "electrobun",
		bundlePath: join(
			desktopDir,
			"build-electrobun/stable-macos-arm64/nisi-electrobun.app",
		),
		buildScript: "build:electrobun",
		// Chromium switches can only be set at build time; see `electrobun.config.ts`.
		buildEnv: { NISI_MEASUREMENT_BUILD: "1" },
		requiredExecutables: [
			"Contents/MacOS/launcher",
			"Contents/MacOS/bun",
			"Contents/MacOS/sidecar",
			"Contents/MacOS/nisi-cli",
		],
		mainExecutables: ["Contents/MacOS/launcher", "Contents/MacOS/bun"],
		sidecarExecutable: "Contents/MacOS/sidecar",
		stopExecutables: [
			"Contents/MacOS/launcher",
			"Contents/MacOS/bun",
			"Contents/MacOS/sidecar",
		],
		selfExtracting: true,
		stopBeforeBuild: true,
		waitForHelpers: true,
		builtChromiumFlags: [...MEASUREMENT_CHROMIUM_SWITCHES, "use-mock-keychain"],
		webKitHelpers: false,
		coldDataDir: join(measureDir, "electrobun/data"),
		newPrDataDir: join(measureDir, "electrobun/new-pr/data"),
	},
	"electrobun-webkit": {
		name: "electrobun-webkit",
		bundlePath: join(
			desktopDir,
			"build-electrobun-webkit/stable-macos-arm64/nisi-webkit.app",
		),
		buildScript: "build:electrobun-webkit",
		// WKWebView takes no Chromium switches; the sidecar's mock keychain comes from NISI_MEASUREMENT_INSTANCE at launch.
		buildEnv: {},
		requiredExecutables: [
			"Contents/MacOS/launcher",
			"Contents/MacOS/bun",
			"Contents/MacOS/sidecar",
			"Contents/MacOS/nisi-cli",
		],
		mainExecutables: ["Contents/MacOS/launcher", "Contents/MacOS/bun"],
		sidecarExecutable: "Contents/MacOS/sidecar",
		stopExecutables: [
			"Contents/MacOS/launcher",
			"Contents/MacOS/bun",
			"Contents/MacOS/sidecar",
		],
		selfExtracting: true,
		stopBeforeBuild: true,
		waitForHelpers: false,
		builtChromiumFlags: [],
		webKitHelpers: true,
		coldDataDir: join(measureDir, "electrobun-webkit/data"),
		newPrDataDir: join(measureDir, "electrobun-webkit/new-pr/data"),
	},
};

export function parseShellName(value: string): ShellName {
	const name = shellNames.find((candidate) => candidate === value);
	if (name === undefined)
		throw new Error(`--shell must be one of ${shellNames.join(", ")}`);
	return name;
}

export const bundleExecutable = (shell: Shell, relative: string) =>
	join(shell.bundlePath, relative);

/** The wrapper's `metadata.json` and archive sit in `Resources`; the extracted app has neither. */
export const wrapperMarker = (shell: Shell) =>
	join(shell.bundlePath, "Contents/Resources/metadata.json");

export const stampFileName = (bundlePath: string) =>
	`${bundlePath.split("/").at(-1)}.build-stamp.json`;

/** Electrobun records the flags it was built with, which catches a bundle rebuilt by hand without them. */
export function missingChromiumFlags(
	buildJson: string,
	required: readonly string[],
): string[] {
	const recorded: unknown = JSON.parse(buildJson);
	const flags = new Map<string, unknown>();
	if (
		typeof recorded === "object" &&
		recorded !== null &&
		"chromiumFlags" in recorded &&
		typeof recorded.chromiumFlags === "object" &&
		recorded.chromiumFlags !== null
	)
		for (const [flag, value] of Object.entries(recorded.chromiumFlags))
			flags.set(flag, value);
	return required.filter((flag) => flags.get(flag) !== true);
}
