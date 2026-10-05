import { expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import {
	createInjectedDeepLinks,
	measurementInstance,
} from "./measurement-deep-links.ts";

test("measurement gate is off by default and accepts only the exact dedicated opt-in", async () => {
	for (const value of [undefined, "0", "true", "1"]) {
		const config =
			value === undefined ? {} : { NISI_MEASUREMENT_INSTANCE: value };
		expect(
			await Effect.runPromise(
				measurementInstance.pipe(
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromUnknown(config),
					),
				),
			),
		).toBe(value === "1");
	}
});
test("injection is retained for cold/reconnecting subscribers until acknowledged and replay is idempotent", () => {
	const links = createInjectedDeepLinks();
	links.inject("nisi://open?url=test", "trace");
	expect(links.list()).toHaveLength(1);
	expect(links.list()[0]?.traceId).toBe("trace");
	links.inject("nisi://open?url=test", "trace");
	expect(links.list()).toHaveLength(1);
	links.ack("trace");
	expect(links.list()).toHaveLength(0);
});
