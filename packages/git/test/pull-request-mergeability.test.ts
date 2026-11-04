import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-mergeability-stub.sh");
const RUNNER = join(testDir, "fixtures/mergeability-runner.ts");

describe("mergeability", () => {
	test("addresses the PR with --repo instead of the checkout's gh default", async () => {
		const proc = Bun.spawn(["bun", "run", RUNNER], {
			env: { ...process.env, NISI_GH_BIN: GH_STUB },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new Error(`runner exited ${exitCode}: ${stderr}`);
		expect(JSON.parse(stdout.trim())).toEqual({
			ok: true,
			value: {
				state: "OPEN",
				mergeable: "MERGEABLE",
				mergeStateStatus: "CLEAN",
				isDraft: false,
				headRefOid: "abc123",
				baseRefOid: "def456",
				baseRefName: "main",
			},
		});
	});
});
