import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("nisi debug fails clearly when no sidecar is running", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-cli-debug-"));
	try {
		const result = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "index.ts"), "debug"],
			{
				cwd: import.meta.dir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NISI_DATA_DIR: dataDir },
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toContain("No running Nisi sidecar");
		expect(result.stderr.toString()).toContain(dataDir);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});
