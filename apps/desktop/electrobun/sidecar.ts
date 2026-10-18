import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

let sidecar: Subprocess<"ignore", "ignore", "ignore"> | undefined;

export function getSidecar() {
	return sidecar;
}

/**
 * The sidecar ships next to the launcher in `Contents/MacOS`, put there by
 * `post-wrap.ts`. A direct child, which `sidecar/updater/restart-helper.ts`
 * relies on.
 */
export function spawnSidecar(env: { dataDir: string; ownerId: string }) {
	const child = Bun.spawn([join(dirname(process.execPath), "sidecar")], {
		env: {
			...process.env,
			NISI_DATA_DIR: env.dataDir,
			NISI_ACTIVATION_OWNER_ID: env.ownerId,
		},
		stdio: ["ignore", "ignore", "ignore"],
	});
	child.exited.then((code) => {
		console.error(`sidecar exited with code ${code}`);
	});
	sidecar = child;
}

export function killSidecar() {
	sidecar?.kill();
	sidecar = undefined;
}
