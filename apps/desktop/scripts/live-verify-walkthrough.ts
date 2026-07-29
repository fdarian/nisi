/**
 * Throwaway manual verification script — NOT part of the test suite (needs a
 * real, running sidecar, a real target git repo with real GitHub-remote
 * metadata `gh` can resolve, and a real authenticated harness CLI). Drives
 * the full Phase 3 wire contract against a live sidecar: opens a session,
 * lists harnesses, generates a walkthrough (printing every streamed
 * `GenerateEvent`), then reads it back.
 *
 * Setup:
 *   1. Point a scratch data dir at the sidecar and start it:
 *        NISI_DATA_DIR=/tmp/nisi-walkthrough-verify-data bun run sidecar
 *   2. Have a real git repo ready — `gh repo view` must resolve it (real
 *      GitHub remote), and it needs an actual diff against its default
 *      branch (uncommitted changes are enough). A disposable local clone of
 *      this repo with its origin repointed at the real remote works well:
 *        git clone --local . /tmp/nisi-walkthrough-verify-repo
 *        cd /tmp/nisi-walkthrough-verify-repo && git remote set-url origin <real-remote-url>
 *      then make a small real edit before running this script.
 *
 * Run (from apps/desktop):
 *   NISI_DATA_DIR=/tmp/nisi-walkthrough-verify-data \
 *   WALKTHROUGH_VERIFY_REPO=/tmp/nisi-walkthrough-verify-repo \
 *   WALKTHROUGH_VERIFY_HARNESS=claude-code \
 *     bun run scripts/live-verify-walkthrough.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessId, makeSidecarClient } from "@repo/sidecar-api";

const dataDir = process.env.NISI_DATA_DIR;
if (dataDir === undefined) {
	console.error(
		"Set NISI_DATA_DIR to the same scratch dir the sidecar is running against.",
	);
	process.exit(1);
}
const targetRepo = process.env.WALKTHROUGH_VERIFY_REPO;
if (targetRepo === undefined) {
	console.error(
		"Set WALKTHROUGH_VERIFY_REPO to a real git repo (see this file's header).",
	);
	process.exit(1);
}
const harness = (process.env.WALKTHROUGH_VERIFY_HARNESS ??
	"claude-code") as HarnessId;

const handshake = JSON.parse(
	readFileSync(join(dataDir, "sidecar.json"), "utf-8"),
) as { port: number; token: string };

const client = makeSidecarClient(handshake);

console.log("=== sessions.open ===");
const session = await client.sessions.open({ cwd: targetRepo });
console.log(JSON.stringify(session, null, 2));

console.log("\n=== walkthrough.harnesses ===");
console.log(JSON.stringify(await client.walkthrough.harnesses(), null, 2));

console.log(`\n=== walkthrough.generate (${harness}) ===`);
const events = await client.walkthrough.generate({
	sessionId: session.id,
	harness,
});
for await (const event of events) {
	console.log(`[${new Date().toISOString()}]`, JSON.stringify(event));
}

console.log("\n=== walkthrough.get ===");
console.log(
	JSON.stringify(
		await client.walkthrough.get({ sessionId: session.id }),
		null,
		2,
	),
);
