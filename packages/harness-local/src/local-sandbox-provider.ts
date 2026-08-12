import { createHash } from "node:crypto";
import { mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
	HarnessV1NetworkSandboxSession,
	HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import { LocalNetworkSandboxSession } from "./local-network-sandbox-session.ts";
import { allocatePort } from "./port.ts";

type CreateSessionOptions = Parameters<
	NonNullable<HarnessV1SandboxProvider["createSession"]>
>[0];

/**
 * Where a session's `defaultWorkingDirectory` — and therefore any bootstrap
 * writes a harness adapter makes outside `workDir` itself — lands, relative
 * to the repo under review.
 *
 * - **in-place**: `defaultWorkingDirectory` is the repo's own parent, so
 *   `workDir` is just the repo's folder name and the framework's
 *   `<defaultWorkingDirectory>/<workDir>` composition resolves straight to
 *   the repo. Correct only for a harness that writes nothing outside
 *   `workDir` — see this package's AGENTS.md for why pi is the one harness
 *   that stays on this mode.
 * - **relocated**: `defaultWorkingDirectory` is a nisi-owned scratch root
 *   (must be outside any pnpm workspace, shared across repos/sessions —
 *   caller's responsibility to resolve one), and the repo is reached
 *   through a symlink this provider creates at `<scratchRoot>/<workDir>`.
 *   Required for a harness that bootstraps a pnpm install into
 *   `defaultWorkingDirectory` (claude-code/codex/opencode) — an in-place
 *   bootstrap there would run `pnpm install` inside the user's own
 *   workspace. See this package's AGENTS.md.
 */
export type LocalSandboxSettings =
	| {
			readonly mode: "in-place";
			readonly repoRoot: string;
	  }
	| {
			readonly mode: "relocated";
			readonly repoRoot: string;
			readonly scratchRoot: string;
	  };

export type LocalSandbox = {
	readonly provider: HarnessV1SandboxProvider;
	/**
	 * Feed straight into `HarnessAgent`'s `sandboxConfig.workDir`. Always
	 * relative — `@ai-sdk/harness` throws on an absolute one — regardless of
	 * mode, so the caller never has to special-case it.
	 */
	readonly workDir: string;
};

export function createLocalSandbox(
	settings: LocalSandboxSettings,
): LocalSandbox {
	if (settings.mode === "in-place") {
		return {
			provider: new LocalSandboxProvider({
				defaultWorkingDirectory: dirname(settings.repoRoot),
			}),
			workDir: basename(settings.repoRoot),
		};
	}

	const repoKey = deriveRepoKey(settings.repoRoot);
	return {
		provider: new LocalSandboxProvider({
			defaultWorkingDirectory: settings.scratchRoot,
			repoLink: { repoKey, repoRoot: settings.repoRoot },
		}),
		workDir: repoKey,
	};
}

/**
 * Path-hash + `basename` — unique per repo path (so two different repos
 * never collide under one scratch root) and still legible in a directory
 * listing. Keyed on the repo's path rather than a session id: a symlink just
 * points at a repo, nothing about it is session-specific, and a fresh one
 * per session would accumulate forever under a scratch root meant to be
 * shared and long-lived.
 */
function deriveRepoKey(repoRoot: string): string {
	const digest = createHash("sha256")
		.update(resolve(repoRoot))
		.digest("hex")
		.slice(0, 12);
	return `${digest}-${basename(repoRoot)}`;
}

type ProviderSettings = {
	readonly defaultWorkingDirectory: string;
	readonly repoLink?: {
		readonly repoKey: string;
		readonly repoRoot: string;
	};
};

/**
 * `HarnessV1SandboxProvider` over `node:child_process` + `node:fs` — the
 * real host filesystem and real processes, standing in for the two shipped
 * providers (`@ai-sdk/sandbox-vercel`, remote-only, and
 * `@ai-sdk/sandbox-just-bash`, an in-memory virtual filesystem), neither of
 * which can operate on the user's actual git worktree.
 *
 * One provider instance mints sessions rooted at one `defaultWorkingDirectory`
 * — construct one per repo/session, mirroring how `JustBashSandboxProvider`
 * is constructed once per `createSession()` caller.
 */
export class LocalSandboxProvider implements HarnessV1SandboxProvider {
	readonly specificationVersion = "harness-sandbox-v1" as const;
	readonly providerId = "local-sandbox";

	constructor(private readonly settings: ProviderSettings) {}

	createSession = async (
		options?: CreateSessionOptions,
	): Promise<HarnessV1NetworkSandboxSession> => {
		options?.abortSignal?.throwIfAborted();

		const defaultWorkingDirectory = resolve(
			this.settings.defaultWorkingDirectory,
		);
		await mkdir(defaultWorkingDirectory, { recursive: true });

		if (this.settings.repoLink !== undefined) {
			await ensureRepoSymlink(defaultWorkingDirectory, this.settings.repoLink);
		}

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

/**
 * Idempotent: creates the symlink if missing, replaces it if it exists and
 * points somewhere else, leaves it untouched if it already points at
 * `repoLink.repoRoot`. Runs on every `createSession()` (cheap — a `readlink`
 * plus, on the common warm path, nothing further) rather than once at
 * `createLocalSandbox()` time, since the latter is synchronous and symlink
 * creation is not.
 */
async function ensureRepoSymlink(
	scratchRoot: string,
	repoLink: { readonly repoKey: string; readonly repoRoot: string },
): Promise<void> {
	const linkPath = join(scratchRoot, repoLink.repoKey);
	const target = resolve(repoLink.repoRoot);

	const currentTarget = await readlink(linkPath).catch((error) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (currentTarget === target) return;

	if (currentTarget !== undefined) await unlink(linkPath);
	await symlink(target, linkPath);
}

function isEnoent(error: unknown): boolean {
	return (
		error instanceof Object &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}
