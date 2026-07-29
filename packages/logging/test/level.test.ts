import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import { minimumLogLevelConfig } from "../src/level.ts";

const resolve = (env: Record<string, string>) =>
	Effect.runPromise(
		minimumLogLevelConfig.pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown(env),
			),
		),
	);

describe("minimumLogLevelConfig", () => {
	test("defaults to Info when LOG_LEVEL is unset", async () => {
		expect(await resolve({})).toBe("Info");
	});

	test("accepts lowercase", async () => {
		expect(await resolve({ LOG_LEVEL: "debug" })).toBe("Debug");
	});

	test("accepts uppercase", async () => {
		expect(await resolve({ LOG_LEVEL: "WARN" })).toBe("Warn");
	});

	test("accepts the canonical spelling", async () => {
		expect(await resolve({ LOG_LEVEL: "Error" })).toBe("Error");
	});

	test("falls back to Info for an unrecognized value rather than failing", async () => {
		expect(await resolve({ LOG_LEVEL: "verbose" })).toBe("Info");
	});
});
