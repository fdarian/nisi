import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	HarnessV1NetworkSandboxSession,
	HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import { LocalNetworkSandboxSession } from "./local-network-sandbox-session.ts";
import { allocatePort } from "./port.ts";

type CreateSessionOptions = Parameters<
	NonNullable<HarnessV1SandboxProvider["createSession"]>
>[0];

export type LocalSandboxSettings = {
	/**
	 * Directory every session's `defaultWorkingDirectory` resolves to. For
	 * nisi this is the target repo's *parent* — `HarnessAgent`'s
	 * `sandboxConfig.workDir` (the repo's folder name) is composed onto it by
	 * the framework itself (`<defaultWorkingDirectory>/<workDir>`), and its
	 * own `mkdir -p` then no-ops on the already-existing repo directory.
	 */
	readonly defaultWorkingDirectory: string;
};

export function createLocalSandbox(
	settings: LocalSandboxSettings,
): HarnessV1SandboxProvider {
	return new LocalSandboxProvider(settings);
}

/**
 * `HarnessV1SandboxProvider` over `node:child_process` + `node:fs` — the
 * real host filesystem and real processes, standing in for the two shipped
 * providers (`@ai-sdk/sandbox-vercel`, remote-only, and
 * `@ai-sdk/sandbox-just-bash`, an in-memory virtual filesystem), neither of
 * which can operate on the user's actual git worktree. See `PLAN.md`
 * (Phase 3, "Running the harness locally") for why this package exists.
 *
 * One provider instance mints sessions rooted at one `defaultWorkingDirectory`
 * — construct one per repo/session, mirroring how `JustBashSandboxProvider`
 * is constructed once per `createSession()` caller.
 */
export class LocalSandboxProvider implements HarnessV1SandboxProvider {
	readonly specificationVersion = "harness-sandbox-v1" as const;
	readonly providerId = "local-sandbox";

	constructor(private readonly settings: LocalSandboxSettings) {}

	createSession = async (
		options?: CreateSessionOptions,
	): Promise<HarnessV1NetworkSandboxSession> => {
		options?.abortSignal?.throwIfAborted();

		const defaultWorkingDirectory = resolve(
			this.settings.defaultWorkingDirectory,
		);
		await mkdir(defaultWorkingDirectory, { recursive: true });

		const port = await allocatePort();
		const session = new LocalNetworkSandboxSession({
			defaultWorkingDirectory,
			port,
		});

		if (options?.onFirstCreate != null) {
			try {
				await options.onFirstCreate(session.restricted(), {
					abortSignal: options.abortSignal,
				});
			} catch (error) {
				await session.stop();
				throw error;
			}
		}

		return session;
	};
}
