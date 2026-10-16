export const MEASUREMENT_CHROMIUM_SWITCHES = [
	"disable-backgrounding-occluded-windows",
	"disable-renderer-backgrounding",
	"disable-background-timer-throttling",
];

export function isMeasurementInstance(env: NodeJS.ProcessEnv): boolean {
	return env.NISI_MEASUREMENT_INSTANCE === "1";
}

/** Only measurement instances skip stealing focus. */
export function shouldFocusMainWindow(
	measurementInstance: string | undefined,
): boolean {
	return measurementInstance !== "1";
}
