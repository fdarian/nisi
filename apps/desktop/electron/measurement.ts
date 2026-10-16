import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
	isMeasurementInstance,
	MEASUREMENT_CHROMIUM_SWITCHES,
} from "./measurement-instance";

/** Must run before `app` is ready. */
export function applyMeasurementSwitches() {
	if (!isMeasurementInstance(process.env)) {
		return;
	}
	for (const switchName of MEASUREMENT_CHROMIUM_SWITCHES) {
		app.commandLine.appendSwitch(switchName);
	}
	// Chromium's equivalent of CEF's SecretStorage::Mock: no keychain prompt during measurement.
	app.commandLine.appendSwitch("use-mock-keychain");
}

export function verifyMeasurementSwitches(dataDir: string) {
	if (!isMeasurementInstance(process.env)) {
		return;
	}
	for (const switchName of MEASUREMENT_CHROMIUM_SWITCHES) {
		if (!app.commandLine.hasSwitch(switchName)) {
			throw new Error(`measurement switch missing: ${switchName}`);
		}
	}
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "measurement-chromium-switches.json"),
		JSON.stringify(
			{
				verifiedBy: "app.commandLine.hasSwitch",
				switches: MEASUREMENT_CHROMIUM_SWITCHES,
			},
			null,
			2,
		),
	);
}
