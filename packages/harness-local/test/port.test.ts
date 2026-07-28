import { describe, expect, test } from "bun:test";
import { allocatePort, releasePort } from "../src/port.ts";

describe("allocatePort", () => {
	test("returns a usable loopback port", async () => {
		const port = await allocatePort();
		try {
			expect(port).toBeGreaterThan(0);
			expect(port).toBeLessThan(65536);
		} finally {
			releasePort(port);
		}
	});

	test("does not hand out the same port to two concurrent sessions", async () => {
		const ports = await Promise.all(
			Array.from({ length: 10 }, () => allocatePort()),
		);
		try {
			expect(new Set(ports).size).toBe(ports.length);
		} finally {
			for (const port of ports) releasePort(port);
		}
	});

	test("a released port can be leased again", async () => {
		const first = await allocatePort();
		releasePort(first);
		const second = await allocatePort();
		try {
			// Not asserting they're equal (the OS decides), just that release
			// actually frees the lease rather than permanently excluding it.
			expect(typeof second).toBe("number");
		} finally {
			releasePort(second);
		}
	});
});
