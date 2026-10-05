import { expect, test } from "bun:test";
import { appLaunchArguments } from "./app-launch.ts";

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
		"--env",
		"NISI_DATA_DIR=/data",
		"--env",
		"NISI_MEASUREMENT_INSTANCE=1",
		"-a",
		"/checkout/nisi.app",
	]);
	expect(appLaunchArguments("/checkout/nisi.app", undefined, true)).toEqual([
		"-n",
		"--env",
		"NISI_MEASUREMENT_INSTANCE=1",
		"-a",
		"/checkout/nisi.app",
	]);
});
