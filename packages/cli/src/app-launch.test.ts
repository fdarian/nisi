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
