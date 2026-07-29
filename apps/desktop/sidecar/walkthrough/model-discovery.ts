import { resolveBin } from "@repo/bin-resolver";
import type { HarnessId, HarnessModel, ModelsStatus } from "@repo/sidecar-api";
import { Effect, Result } from "effect";
import { HARNESS_CLI_BIN } from "./harness-bin.ts";

/**
 * How long a live discovery call is allowed to run before it's treated as a
 * failure — bounds the worst case so `walkthrough.harnesses` never hangs the
 * UI on a slow/hung CLI. Generous because claude-code's discovery spawns a
 * real `claude` subprocess (~3s warm on this machine; cold installs of the
 * SDK's own bundled binary can be slower).
 */
const DISCOVERY_TIMEOUT = "15 seconds";

/** How long a successful discovery is trusted before the next `harnesses()` call re-fetches — mirrors oagent's `ModelCatalog` (`services/engine/src/model-catalog.ts`), the reference implementation this follows. */
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
	readonly models: ReadonlyArray<HarnessModel>;
	readonly fetchedAt: number;
};

export type DiscoveryResult = {
	readonly models: ReadonlyArray<HarnessModel>;
	readonly status: ModelsStatus;
};

/**
 * A cache of the last successful discovery per harness, with the lookup
 * function that decides fresh-hit / re-fetch / degrade. Exposed as a factory
 * (rather than one module-level singleton) so tests can exercise the
 * caching/fallback behavior against an isolated instance — `listHarnesses`
 * below uses the one singleton instance for the sidecar's actual lifetime.
 * `ttlMs` defaults to `CACHE_TTL_MS`; overridable so tests can force a cache
 * entry to expire without waiting five real minutes.
 */
export const createModelDiscoveryCache = (ttlMs = CACHE_TTL_MS) => {
	const cache = new Map<HarnessId, CacheEntry>();

	/**
	 * Runs `discover` and returns its models, unless a cached result from
	 * within `CACHE_TTL_MS` already exists (returned as `"fresh"` without
	 * paying for I/O again) — unless `opts.force` is set, which skips that
	 * cache-hit shortcut and always re-runs `discover`, for an explicit
	 * user-initiated refresh (`harnesses.ts`'s `listHarnesses` `force` option,
	 * behind `walkthrough.refreshHarnesses`). On failure — timeout, a missing
	 * CLI, malformed output — falls back to the last cached result flagged
	 * `"stale"` rather than failing the whole harness, or `"unavailable"` with
	 * an empty model list when there's never been a successful discovery.
	 * `force` doesn't disturb this fallback: the previous cache entry is kept
	 * around for exactly this case even though the freshness check is
	 * skipped. Never fails: this is exactly the "a harness whose discovery
	 * fails should still be selectable rather than vanishing" requirement.
	 */
	const get = (
		id: HarnessId,
		discover: Effect.Effect<ReadonlyArray<HarnessModel>, unknown>,
		opts?: { readonly force?: boolean },
	): Effect.Effect<DiscoveryResult> =>
		Effect.gen(function* () {
			const now = Date.now();
			const cached = cache.get(id);
			if (
				opts?.force !== true &&
				cached !== undefined &&
				now - cached.fetchedAt < ttlMs
			) {
				return { models: cached.models, status: "fresh" as const };
			}

			const attempt = yield* Effect.result(discover);
			if (Result.isSuccess(attempt)) {
				cache.set(id, { models: attempt.success, fetchedAt: now });
				return { models: attempt.success, status: "fresh" as const };
			}
			if (cached !== undefined) {
				return { models: cached.models, status: "stale" as const };
			}
			return { models: [], status: "unavailable" as const };
		});

	return { get };
};

const runCli = (
	binary: string,
	args: ReadonlyArray<string>,
): Effect.Effect<string, Error> =>
	Effect.tryPromise({
		try: async () => {
			const proc = Bun.spawn([binary, ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) {
				throw new Error(
					`${binary} ${args.join(" ")} exited ${exitCode}: ${stderr.slice(0, 300)}`,
				);
			}
			return stdout;
		},
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});

/**
 * OpenCode's own CLI lists its resolvable models one per line, no flags or
 * JSON — same command oagent's `services/engine/src/opencode.ts` shells out
 * to. Resolved via `@repo/bin-resolver` (checks `PATH`, then well-known
 * install dirs) rather than trusting the bare name to resolve on its own —
 * a macOS `.app` launched from Finder/`open` doesn't inherit an interactive
 * shell's `PATH`, so `opencode` installed via Homebrew or similar would
 * otherwise silently fail to spawn in the built app. Overridable via
 * `NISI_OPENCODE_BIN` for tests/CI, mirroring oagent's `OAGENT_OPENCODE_BIN`.
 */
export const discoverOpenCodeModels = (): Effect.Effect<
	ReadonlyArray<HarnessModel>,
	Error
> =>
	runCli(
		resolveBin(
			HARNESS_CLI_BIN.opencode.name,
			HARNESS_CLI_BIN.opencode.envOverrideVar,
		),
		["models"],
	).pipe(
		Effect.map((stdout) =>
			stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map((id) => ({ id, label: id })),
		),
		Effect.timeout(DISCOVERY_TIMEOUT),
	);

type CodexModelCatalogEntry = {
	readonly slug: string;
	readonly display_name: string;
	readonly visibility: string;
};

/**
 * `codex debug models` renders the CLI's full model catalog as JSON.
 * `visibility: "hide"` entries are internal/deprecated variants the CLI's
 * own picker also excludes — filtered out here for the same reason.
 * Resolved via `@repo/bin-resolver` for the same GUI-`PATH` reason as
 * `discoverOpenCodeModels` above. Overridable via `NISI_CODEX_BIN`.
 */
export const discoverCodexModels = (): Effect.Effect<
	ReadonlyArray<HarnessModel>,
	Error
> =>
	runCli(
		resolveBin(
			HARNESS_CLI_BIN.codex.name,
			HARNESS_CLI_BIN.codex.envOverrideVar,
		),
		["debug", "models"],
	).pipe(
		Effect.map((stdout) => {
			const parsed = JSON.parse(stdout) as {
				models: ReadonlyArray<CodexModelCatalogEntry>;
			};
			return parsed.models
				.filter((model) => model.visibility === "list")
				.map((model) => ({ id: model.slug, label: model.display_name }));
		}),
		Effect.timeout(DISCOVERY_TIMEOUT),
	);

/**
 * Claude Code has no CLI subcommand for listing models (unlike codex/opencode),
 * so discovery goes through `@anthropic-ai/claude-agent-sdk`'s `query()`
 * directly — the same library `@ai-sdk/harness-claude-code`'s sandbox bridge
 * uses internally, imported here on our own account for discovery, the same
 * way Pi's discovery below bypasses `@ai-sdk/harness-pi` to call
 * `@earendil-works/pi-coding-agent` directly. `query()` in streaming-input
 * mode spawns a real `claude` subprocess and exposes a `supportedModels()`
 * control call once it's initialized; the prompt is an async generator that
 * never yields, so the session opens without ever sending a turn — mirrors
 * oagent's `AcpAgent.listModels()`, which spins up a throwaway connection
 * scoped only to the list call rather than reusing a persistent session.
 *
 * `pathToClaudeCodeExecutable` is always set explicitly, to a
 * `@repo/bin-resolver`-resolved path — left unset, the SDK falls back to its
 * own bundled per-platform native binary, resolved via a `require.resolve`
 * relative to its own `import.meta.url`. That resolution reads real files
 * from a real `node_modules` on disk, which doesn't exist once this file is
 * bundled into the sidecar's `bun build --compile` single-file executable
 * (same class of problem as the `readBridgeAsset` fix in
 * `patches/@ai-sdk%2Fharness-claude-code@1.0.47.patch`, just for a native
 * binary rather than a text asset that can be statically imported) — it
 * throws "Native CLI binary for darwin-arm64 not found" every time in the
 * built app, confirmed via a standalone `bun build --compile` repro.
 * Resolving to the user's own installed `claude` CLI sidesteps the bundled
 * binary entirely, so it works the same way in dev and in the compiled
 * binary. Overridable via `NISI_CLAUDE_BIN`.
 */
export const discoverClaudeCodeModels = (): Effect.Effect<
	ReadonlyArray<HarnessModel>,
	Error
> =>
	Effect.tryPromise({
		try: async () => {
			const { query } = await import("@anthropic-ai/claude-agent-sdk");

			async function* idlePrompt(): AsyncGenerator<never> {
				await new Promise<never>(() => {});
			}

			const session = query({
				prompt: idlePrompt(),
				options: {
					pathToClaudeCodeExecutable: resolveBin(
						HARNESS_CLI_BIN["claude-code"].name,
						HARNESS_CLI_BIN["claude-code"].envOverrideVar,
					),
				},
			});
			// Drains the session's own message stream so its internal buffers
			// don't back up while we wait on `supportedModels()` below — this
			// discovery call never sends a prompt, so nothing meaningful is
			// expected on it, but the control channel still needs a reader.
			void (async () => {
				try {
					for await (const _message of session) {
						// discarded — this call only wants supportedModels()
					}
				} catch {
					// draining errors don't matter once supportedModels() has
					// already resolved (or failed) below
				}
			})();

			try {
				const models = await session.supportedModels();
				return models.map((model) => ({
					id: model.value,
					label: model.displayName,
				}));
			} finally {
				await session.interrupt().catch(() => {});
			}
		},
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	}).pipe(Effect.timeout(DISCOVERY_TIMEOUT));

/** Fallback when Pi's own model registry can't be read (no auth configured yet, config dir unreadable, …) — mirrors the other three harnesses' static lists rather than leaving Pi's dropdown empty. */
const PI_FALLBACK_MODELS: ReadonlyArray<HarnessModel> = [
	{ id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
	{ id: "openai/gpt-5.1", label: "GPT-5.1" },
];

/**
 * Pi is the one harness with a real model-discovery API
 * (`@earendil-works/pi-coding-agent`'s `ModelRuntime`/`ModelRegistry`) — read
 * live instead of hand-curating. Prefers models Pi considers *available*
 * (configured auth); falls back to every model Pi knows about if none are
 * configured yet, and to `PI_FALLBACK_MODELS` if the registry itself comes
 * back empty (fresh install, no `models.json` yet) — a genuine I/O failure
 * (unreadable config, broken install) is left to fail so the cache above can
 * apply its own stale/unavailable fallback, same as the other three
 * harnesses.
 */
export const discoverPiModels = (): Effect.Effect<
	ReadonlyArray<HarnessModel>,
	Error
> =>
	Effect.tryPromise({
		try: async () => {
			const { ModelRegistry, ModelRuntime } = await import(
				"@earendil-works/pi-coding-agent"
			);
			const runtime = await ModelRuntime.create();
			const registry = new ModelRegistry(runtime);
			await registry.refresh();
			const available = registry.getAvailable();
			const models = available.length > 0 ? available : registry.getAll();
			if (models.length === 0) return PI_FALLBACK_MODELS;
			return models.map(
				(model): HarnessModel => ({
					id: `${model.provider}/${model.id}`,
					label: model.name,
				}),
			);
		},
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	}).pipe(Effect.timeout(DISCOVERY_TIMEOUT));
