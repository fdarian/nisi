import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import type { SandboxMode } from "@repo/settings";
import type { HarnessId } from "@repo/sidecar-api";
import { localSandboxBackend } from "./sandbox-local.ts";

/**
 * The thing a sandbox is being created for. A backend that keeps persistent
 * machines can key them by it; ids are stable for the owner's lifetime
 * (a chat thread, or a review session's walkthrough).
 */
export type SandboxOwner =
	| { readonly kind: "chat"; readonly threadId: string }
	| { readonly kind: "walkthrough"; readonly reviewSessionId: string };

export type HarnessSandbox = {
	readonly provider: HarnessV1SandboxProvider;
	/** Feeds `HarnessAgent`'s `sandboxConfig.workDir`; must be relative. */
	readonly workDir: string;
};

export type SandboxBackend = {
	readonly create: (
		harness: HarnessId,
		repoRoot: string,
		owner: SandboxOwner,
	) => Promise<HarnessSandbox>;
};

/** `Record` over `SandboxMode`, so a new setting value without a backend fails to compile. */
export const SANDBOX_BACKENDS: Record<SandboxMode, SandboxBackend> = {
	local: localSandboxBackend,
};
