import { expect, test } from "bun:test";
import { appLaunchArguments, dataDirLaunchRefusal } from "./app-launch.ts";

test("production activation is unchanged without a data-dir override", () => {
	expect(appLaunchArguments("/Applications/nisi.app")).toEqual([
		"-a",
		"/Applications/nisi.app",
	]);
});

test("sandbox launch starts a new instance and forwards the data dir", () => {
	expect(appLaunchArguments("/work tree/nisi.app", "/work tree/data")).toEqual([
		"-n",
		"--env",
		"NISI_DATA_DIR=/work tree/data",
		"-a",
		"/work tree/nisi.app",
	]);
});

test("measurement launch forwards only the dedicated mock-keychain opt-in", () => {
	expect(appLaunchArguments("/checkout/nisi.app", "/data", true)).toEqual([
		"-n",
		"-g",
		"--env",
		"NISI_DATA_DIR=/data",
		"--env",
		"NISI_MEASUREMENT_INSTANCE=1",
		"-a",
		"/checkout/nisi.app",
	]);
	expect(appLaunchArguments("/checkout/nisi.app", undefined, true)).toEqual([
		"-n",
		"-g",
		"--env",
		"NISI_MEASUREMENT_INSTANCE=1",
		"-a",
		"/checkout/nisi.app",
	]);
});

test("an unanswered explicit data dir refuses to launch the installed app", () => {
	const reason = dataDirLaunchRefusal("/work tree/data", false);
	expect(reason).toContain("/work tree/data");
	expect(reason).toContain("bun dev");
});

test("no data-dir override, or an explicit launch request, never refuses", () => {
	expect(dataDirLaunchRefusal(undefined, false)).toBeUndefined();
	expect(dataDirLaunchRefusal("/data", true)).toBeUndefined();
});
