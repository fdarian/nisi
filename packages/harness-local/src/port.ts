import net from "node:net";

/**
 * Ports leased by sessions created in this process. `createSession` is
 * called once per harness session, potentially several times concurrently
 * (one call per running `HarnessAgent` session) — without this registry two
 * sessions racing `findFreePort` right after each other's listener closes
 * could both get handed back the same OS-reported "free" port.
 */
const leasedPorts = new Set<number>();

/**
 * Reserve a free TCP port on the loopback interface. Bridge adapters bind
 * their own server to the returned port later (via `BRIDGE_WS_PORT` env,
 * see `local-network-sandbox-session.ts`'s `getPortUrl`) — this function only
 * finds a number nothing else in this process is currently using.
 */
export async function allocatePort(): Promise<number> {
	const maxAttempts = 20;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const port = await findFreePort();
		if (!leasedPorts.has(port)) {
			leasedPorts.add(port);
			return port;
		}
	}
	throw new Error(
		`Unable to allocate a free TCP port after ${maxAttempts} attempts.`,
	);
}

export function releasePort(port: number): void {
	leasedPorts.delete(port);
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(
					new Error(
						"Unable to determine the port assigned by the OS to a freshly bound loopback listener.",
					),
				);
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}
