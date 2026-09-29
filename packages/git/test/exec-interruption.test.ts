import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { runText } from "../src/exec.ts";

test("interrupting a scoped command terminates its child", async () => {
	const directory = mkdtempSync(join(tmpdir(), "nisi-exec-interruption-"));
	const marker = join(directory, "pid");
	const controller = new AbortController();
	const command = Effect.runPromise(
		runText(directory, "sh", [
			"-c",
			`echo $$ > '${marker}'; exec sleep 30`,
		]).pipe(Effect.provide(BunServices.layer)),
		{ signal: controller.signal },
	);

	try {
		for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) {
			await Bun.sleep(20);
		}
		expect(existsSync(marker)).toBe(true);
		const pid = Number(readFileSync(marker, "utf8").trim());
		controller.abort();
		await expect(command).rejects.toThrow();
		const remaining = await Bun.$`ps -p ${pid} -o comm=`.quiet().nothrow();
		expect(remaining.exitCode).not.toBe(0);
	} finally {
		controller.abort();
		await Promise.allSettled([command]);
		rmSync(directory, { recursive: true, force: true });
	}
}, 10000);
