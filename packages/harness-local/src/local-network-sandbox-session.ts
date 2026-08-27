import { randomUUID } from "node:crypto";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type {
	Experimental_SandboxProcess,
	Experimental_SandboxSession,
} from "@ai-sdk/provider-utils";
import { LocalSandboxSession } from "./local-sandbox-session.ts";
import { releasePort } from "./port.ts";

type SpawnOptions = Parameters<Experimental_SandboxSession["spawn"]>[0];
type GetPortUrlOptions = Parameters<
	HarnessV1NetworkSandboxSession["getPortUrl"]
>[0];
type GetPortEndpointOptions = Parameters<
	HarnessV1NetworkSandboxSession["getPortEndpoint"]
>[0];

/**
 * `HarnessV1NetworkSandboxSession` over a real directory on disk. There is no
 * separate "sandbox resource" distinct from that directory plus one leased
 * loopback port — `stop`/`destroy` release the port and kill processes this
 * session spawned; they never touch the directory itself, since it's the
 * user's actual git worktree, not disposable sandbox state.
 *
 * `getPortUrl`/`getPortEndpoint` resolve to a bare loopback URL. There is no
 * network namespace to publish a port into — bridge-backed adapters connect
 * straight to the port a bridge process (spawned via `spawn()`) binds on this
 * same host.
 */
export class LocalNetworkSandboxSession
	extends LocalSandboxSession
	implements HarnessV1NetworkSandboxSession
{
	readonly id: string;
	readonly defaultWorkingDirectory: string;
	readonly ports: ReadonlyArray<number>;

	private readonly leasedPort: number;
	private readonly ownedProcesses = new Set<Experimental_SandboxProcess>();
	private stopped = false;

	constructor(options: { defaultWorkingDirectory: string; port: number }) {
		super(options.defaultWorkingDirectory);
		this.id = randomUUID();
		this.defaultWorkingDirectory = options.defaultWorkingDirectory;
		this.leasedPort = options.port;
		this.ports = [options.port];
	}

	override async spawn(
		options: SpawnOptions,
	): Promise<Experimental_SandboxProcess> {
		const proc = await super.spawn(options);
		this.ownedProcesses.add(proc);
		return proc;
	}

	/**
	 * Reduced view sharing this session's `cwd` but none of the infra surface
	 * — a fresh `LocalSandboxSession`, not `this`, so holders can't reach
	 * `stop`/`destroy`/`getPortUrl` through it. Matches
	 * `JustBashSandboxSession.restricted()`'s shape.
	 */
	restricted(): Experimental_SandboxSession {
		return new LocalSandboxSession(this.defaultWorkingDirectory);
	}

	getPortUrl = async (options: GetPortUrlOptions): Promise<string> => {
		const protocol = options.protocol ?? "http";
		return `${protocol}://127.0.0.1:${options.port}`;
	};

	getPortEndpoint = async (
		options: GetPortEndpointOptions,
	): Promise<{ readonly url: string }> => {
		return { url: await this.getPortUrl(options) };
	};

	stop = async (): Promise<void> => {
		if (this.stopped) return;
		this.stopped = true;
		await Promise.all([...this.ownedProcesses].map((proc) => proc.kill()));
		releasePort(this.leasedPort);
	};

	/**
	 * No separate destroy concept: the "sandbox" is the user's real worktree
	 * directory, which must survive the session regardless of how it ends.
	 * Declared anyway (rather than omitted) so callers that always call
	 * `destroy()` over `stop()` still release the port and owned processes.
	 */
	destroy = async (): Promise<void> => {
		await this.stop();
	};
}
