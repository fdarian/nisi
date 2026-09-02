import { resolveBin } from "@repo/bin-resolver";
import type { HarnessId, HarnessModel } from "@repo/sidecar-api";
import { Effect } from "effect";
import { HARNESS_CLI_BIN } from "./harness-bin.ts";

/**
 * How long a live discovery call is allowed to run before it's treated as a
 * failure — bounds the worst case so `walkthrough.harnesses` never hangs the
 * UI on a slow/hung CLI. Generous because claude-code's discovery spawns a
 * real `claude` subprocess (~3s warm on this machine; cold installs of the
 * SDK's own bundled binary can be slower).
 */
const DISCOVERY_TIMEOUT = "15 seconds";

/**
 * Why a particular discovery attempt is running — threaded through from
 * `model-store.ts`'s `HarnessModelCache` (the persistent, single-flight
 * cache that now owns fresh/stale/backoff decisions; this module no longer
 * decides any of that itself). Exists so a discovery attempt's own
 * spawn/teardown log lines can say *why* it ran, not just *that* it ran —
 * "the cache had never seen this harness" and "a broken harness got probed
 * again" look identical from inside `runCli`/`discoverClaudeCodeModels`
 * without it.
 */
export type DiscoveryReason =
	| "cold-miss"
	| "forced-refresh"
	| "background-revalidation";

const runCli = (
	binary: string,
	args: ReadonlyArray<string>,
	harnessId: HarnessId,
	reason: DiscoveryReason,
): Effect.Effect<string, Error> =>
	Effect.gen(function* () {
		// A plain synchronous `Bun.spawn` call, but run through `tryPromise`
		// (an `async` wrapper) rather than a bare `Effect.sync` — there's no
		// non-throwing synchronous constructor in this Effect version, and an
		// `async` function catches a synchronous throw (a bad executable path)
		// into a rejection exactly the same as a real async failure.
		const proc = yield* Effect.tryPromise({
			try: async () =>
				Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" }),
			catch: (cause) =>
				cause instanceof Error ? cause : new Error(String(cause)),
		});
		yield* Effect.logDebug("spawning harness discovery subprocess", {
			harnessId,
			reason,
			pid: proc.pid,
			binary,
		});

		const [stdout, stderr, exitCode] = yield* Effect.tryPromise({
			// `signal` is Effect's own interruption signal (fired on
			// `Effect.timeout`'s deadline or an outright interrupt) — Effect
			// only aborts it, the underlying async work has to observe it
			// itself (see `tryPromise`'s own doc). Killing `proc` on that abort
			// is what closes the leak this used to have: without it, a
			// timed-out/interrupted call abandoned the `Promise.all` below but
			// left the spawned CLI process running as an orphan — the same
			// class of leak `discoverClaudeCodeModels` below has, just via
			// `Bun.spawn` instead of the SDK's own `query()`.
			try: async (signal) => {
				signal.addEventListener("abort", () => proc.kill(), { once: true });
				return await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
			},
			catch: (cause) =>
				cause instanceof Error ? cause : new Error(String(cause)),
		}).pipe(
			Effect.ensuring(
				Effect.logDebug("harness discovery subprocess exited", {
					harnessId,
					reason,
					pid: proc.pid,
				}),
			),
		);

		if (exitCode !== 0) {
			return yield* Effect.fail(
				new Error(
					`${binary} ${args.join(" ")} exited ${exitCode}: ${stderr.slice(0, 300)}`,
				),
			);
		}
		return stdout;
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
export const discoverOpenCodeModels = (
	reason: DiscoveryReason,
): Effect.Effect<ReadonlyArray<HarnessModel>, Error> =>
	runCli(
		resolveBin(
			HARNESS_CLI_BIN.opencode.name,
			HARNESS_CLI_BIN.opencode.envOverrideVar,
		),
		["models"],
		"opencode",
		reason,
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
export const discoverCodexModels = (
	reason: DiscoveryReason,
): Effect.Effect<ReadonlyArray<HarnessModel>, Error> =>
	runCli(
		resolveBin(
			HARNESS_CLI_BIN.codex.name,
			HARNESS_CLI_BIN.codex.envOverrideVar,
		),
		["debug", "models"],
		"codex",
		reason,
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
export const discoverClaudeCodeModels = (
	reason: DiscoveryReason,
): Effect.Effect<ReadonlyArray<HarnessModel>, Error> =>
	Effect.gen(function* () {
		const binaryPath = resolveBin(
			HARNESS_CLI_BIN["claude-code"].name,
			HARNESS_CLI_BIN["claude-code"].envOverrideVar,
		);
		// No pid to log here, unlike `runCli`'s `Bun.spawn` — the SDK's `Query`
		// doesn't expose the underlying subprocess's OS pid anywhere in its
		// public surface, only a "kernel-verified pid" for an unrelated
		// cross-session messaging feature.
		yield* Effect.logDebug("spawning harness discovery subprocess", {
			harnessId: "claude-code",
			reason,
			binaryPath,
		});

		return yield* Effect.tryPromise({
			try: async (signal) => {
				const { query } = await import("@anthropic-ai/claude-agent-sdk");

				async function* idlePrompt(): AsyncGenerator<never> {
					await new Promise<never>(() => {});
				}

				// The SDK's own `.d.ts` draws a sharp line between these two:
				// `abortController` is what tears the underlying `claude`
				// subprocess down ("the query will stop and clean up resources"),
				// while `interrupt()` (the call this replaces) only cancels the
				// *current turn* — and this discovery call never starts one (the
				// prompt generator above never yields), so `interrupt()` alone had
				// nothing to cancel and the spawned process was left sitting on
				// its stdin forever. That's the leak this fixes.
				const abortController = new AbortController();
				// Effect's own interruption signal (a hung/timed-out
				// `supportedModels()` call below never reaches the `finally`) — see
				// `runCli`'s matching comment. Forwarded into `abortController`
				// rather than used directly, since the SDK's `options` takes an
				// `AbortController`, not a bare `AbortSignal`.
				signal.addEventListener("abort", () => abortController.abort(), {
					once: true,
				});

				const session = query({
					prompt: idlePrompt(),
					options: { pathToClaudeCodeExecutable: binaryPath, abortController },
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
					abortController.abort();
				}
			},
			catch: (cause) =>
				cause instanceof Error ? cause : new Error(String(cause)),
		}).pipe(
			Effect.ensuring(
				Effect.logDebug("harness discovery subprocess exited", {
					harnessId: "claude-code",
					reason,
				}),
			),
		);
	}).pipe(Effect.timeout(DISCOVERY_TIMEOUT));

/**
 * Pi is the one harness with a real model-discovery API
 * (`@earendil-works/pi-coding-agent`'s `ModelRuntime`/`ModelRegistry`) — read
 * live instead of hand-curating. Prefers models Pi considers *available*
 * (configured auth); falls back to every model Pi knows about if none are
 * configured yet. An empty registry, like a genuine I/O failure (unreadable
 * config, broken install), is left to fail so the cache above can apply its
 * own stale/unavailable fallback, same as the other three harnesses — a
 * hardcoded "just in case" list can't be honest here, since whether a model
 * works depends entirely on which providers *this* user has logged into.
 *
 * `ModelRuntime.create()` takes Pi's own default paths, which resolve under
 * `getAgentDir()` — the same directory `harnesses.ts` hands the harness
 * adapter, so a model listed here is one the adapter can actually
 * authenticate. Don't let the two drift apart.
 *
 * `label` carries the provider too, not just `model.name`: Pi's names collide
 * across providers (several "GPT-5.4"s, several "DeepSeek V4 Flash"es), so
 * the bare name left the picker showing indistinguishable duplicates. The
 * `provider/…` shape matches what OpenCode's ids already look like in the
 * same list, with Pi's human-readable name kept as the second half since it
 * has one and OpenCode doesn't.
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
			if (models.length === 0) {
				throw new Error(
					"Pi's model registry is empty — run `pi` and log into a provider first.",
				);
			}
			return models.map(
				(model): HarnessModel => ({
					id: `${model.provider}/${model.id}`,
					label: `${model.provider}/${model.name}`,
				}),
			);
		},
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	}).pipe(Effect.timeout(DISCOVERY_TIMEOUT));
