import { join, relative } from "node:path";
import type {
	LspLocation,
	LspProcessError,
	LspProtocolError,
	LspRequestError,
	LspServer,
	TsLspBinaryResolutionError,
} from "@repo/code-lsp";
import { resolveProjectRoot, spawnLspServer } from "@repo/code-lsp";
import { readWorktreeBlobContent, type WorktreeReadFailed } from "@repo/git";
import type {
	CodeIndexFileReferences,
	CodeIndexOccurrence,
	CodeIndexReference,
	CodeIndexReferencesResult,
	CodeIndexSourceContext,
	CodeIndexStatus,
} from "@repo/sidecar-api";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	RcMap,
	Result,
	Semaphore,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import type { AppServices } from "../services.ts";

/**
 * How many TS7 LSP server processes stay live at once, across every
 * tsconfig project this sidecar has queried since boot (the pool is
 * process-lifetime, not per-session — see `CodeLspPool` below). Capacity-
 * bounded eviction of idle servers, via `RcMap`. Measured
 * footprint (spiked before this file was written, against this repo):
 * 235 MB resident for one loaded project, 685 MB once a second one loads —
 * three servers could therefore approach ~1.1 GB resident, the ceiling this
 * cap accepts in exchange for not respawning (and re-cold-loading a whole
 * project, up to ~1s per that same spike's numbers) every time a reviewer
 * bounces between more than a couple of packages' files. Deliberately
 * small: a large monorepo can have far more tsconfig projects than this,
 * and an unbounded registry would grow without limit as a reviewer opens
 * files spread across all of them.
 */
const MAX_LIVE_LSP_SERVERS = 3;

/**
 * The sidecar's one registry of live `tsc --lsp --stdio` processes, keyed by
 * tsconfig project root (`@repo/code-lsp`'s `resolveProjectRoot` — one
 * server per project, never a shared/broader one; see that package's
 * AGENTS.md, "One project root per server", for why a shared server would
 * silently give wrong reference counts). `RcMap` shares an in-flight spawn
 * for the same root and reference-counts each operation's scoped lease. The
 * small admission lock only protects capacity inspection and idle eviction;
 * it is not held while an LSP request runs. The map's own scope is this
 * layer's, which `index.ts`'s `MainLayer` ties to the sidecar's whole run —
 * every live server dies with the sidecar, the same posture
 * `Effect.acquireRelease` gives every other resource there (compare
 * `updater/restart-helper.ts`'s `handle.unref`, the one deliberate exception
 * that survives it).
 */
export class CodeLspPool extends Context.Service<CodeLspPool>()("CodeLspPool", {
	make: Effect.gen(function* () {
		const resources = yield* RcMap.make({
			lookup: (projectRoot: string) => spawnLspServer(projectRoot),
			capacity: MAX_LIVE_LSP_SERVERS,
			idleTimeToLive: "5 minutes",
		});
		return {
			resources,
			admissionLock: Semaphore.makeUnsafe(1),
		};
	}),
}) {
	static layer = Layer.effect(CodeLspPool, CodeLspPool.make);
}

type CodeLspFailure =
	| TsLspBinaryResolutionError
	| LspProcessError
	| LspRequestError
	| LspProtocolError;

export type CodeLspPoolValue = {
	readonly resources: RcMap.RcMap<
		string,
		LspServer,
		TsLspBinaryResolutionError | LspProcessError | Cause.ExceededCapacityError
	>;
	readonly admissionLock: Semaphore.Semaphore;
};

const findPoolEntry = (
	pool: CodeLspPoolValue,
	projectRoot: string,
):
	| RcMap.State.Entry<
			LspServer,
			TsLspBinaryResolutionError | LspProcessError | Cause.ExceededCapacityError
	  >
	| undefined => {
	const state = pool.resources.state;
	if (state._tag === "Closed") return undefined;
	for (const pair of state.map) {
		if (pair[0] === projectRoot) return pair[1];
	}
	return undefined;
};

const findIdlePoolRoot = (pool: CodeLspPoolValue): string | undefined => {
	const state = pool.resources.state;
	if (state._tag === "Closed") return undefined;
	for (const pair of state.map) {
		if (pair[1].refCount === 0) return pair[0];
	}
	return undefined;
};

const poolSize = (pool: CodeLspPoolValue): number => {
	const state = pool.resources.state;
	if (state._tag === "Closed") return 0;
	let size = 0;
	for (const _ of state.map) size += 1;
	return size;
};

/** Acquires one scoped lease, evicting only an idle server when the bounded pool is full. A full pool of leased servers waits until one operation releases its lease. */
const acquireCodeLspServer = (
	pool: CodeLspPoolValue,
	projectRoot: string,
	refresh: boolean,
): Effect.Effect<LspServer, CodeLspFailure, Scope.Scope> =>
	Effect.gen(function* () {
		while (true) {
			const lease = yield* pool.admissionLock.withPermit(
				Effect.gen(function* () {
					const entry = findPoolEntry(pool, projectRoot);
					if (refresh && entry !== undefined) {
						if (entry.refCount > 0) return Option.none<LspServer>();
						yield* RcMap.invalidate(pool.resources, projectRoot);
					}

					if (
						findPoolEntry(pool, projectRoot) === undefined &&
						poolSize(pool) >= pool.resources.capacity
					) {
						const idleRoot = findIdlePoolRoot(pool);
						if (idleRoot === undefined) return Option.none<LspServer>();
						yield* RcMap.invalidate(pool.resources, idleRoot);
					}

					return yield* RcMap.get(pool.resources, projectRoot).pipe(
						Effect.map(Option.some),
						Effect.catchIf(Cause.isExceededCapacityError, () =>
							Effect.succeed(Option.none<LspServer>()),
						),
					);
				}),
			);
			if (Option.isSome(lease)) return lease.value;
			yield* Effect.sleep("50 millis");
		}
	});

const invalidateIdleCodeLspServer = (
	pool: CodeLspPoolValue,
	projectRoot: string,
): Effect.Effect<void> =>
	pool.admissionLock.withPermit(
		Effect.gen(function* () {
			const entry = findPoolEntry(pool, projectRoot);
			if (entry === undefined || entry.refCount > 0) return;
			yield* RcMap.invalidate(pool.resources, projectRoot);
		}),
	);

export const withCodeLspServer = <
	A,
	E extends LspRequestError | LspProtocolError,
>(
	pool: CodeLspPoolValue,
	projectRoot: string,
	use: (server: LspServer) => Effect.Effect<A, E>,
	refresh = false,
): Effect.Effect<A, E | CodeLspFailure> => {
	const operation = Effect.scoped<A, E | CodeLspFailure, Scope.Scope>(
		Effect.gen(function* () {
			const server = yield* acquireCodeLspServer(pool, projectRoot, refresh);
			return yield* use(server);
		}),
	);
	return operation.pipe(
		Effect.onExit((exit) =>
			Exit.isSuccess(exit)
				? Effect.void
				: invalidateIdleCodeLspServer(pool, projectRoot),
		),
	);
};

/** Directories never worth descending into while looking for a `tsconfig.json` — build output and dependency trees, which can be enormous and never contain a project's own config. Mirrors the equivalent skip list the deleted `@repo/code-index` package used for the same reason. */
const SKIPPED_DIRECTORY_NAMES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".turbo",
	".next",
	".cache",
	"coverage",
]);

/** Caps a single filesystem walk — a correctness backstop against a pathological repo layout, not a limit expected to bite in practice. */
const MAX_DIRECTORIES_VISITED = 4_000;

const TSCONFIG_FILENAME = "tsconfig.json";

/** Depth-first, alphabetical-first-match walk down from `path` for the first directory holding an exact `tsconfig.json` — sorted so the same repo always resolves the same "primary" project across runs. */
const findTsConfigProjectRoot = (
	fs: FileSystem,
	path: string,
	budget: { remaining: number },
): Effect.Effect<string | null> =>
	Effect.gen(function* () {
		if (budget.remaining <= 0) return null;
		budget.remaining -= 1;

		const entries = yield* fs
			.readDirectory(path)
			.pipe(Effect.catch(() => Effect.succeed(null)));
		if (entries === null) return null;

		if (entries.includes(TSCONFIG_FILENAME)) return path;

		for (const entry of [...entries].sort()) {
			if (SKIPPED_DIRECTORY_NAMES.has(entry)) continue;
			const found = yield* findTsConfigProjectRoot(
				fs,
				join(path, entry),
				budget,
			);
			if (found !== null) return found;
		}
		return null;
	});

/** Repos already resolved to a "primary" project root (or confirmed to have none) — a directory walk on every `status` poll (roughly once a second while a build runs) would be wasteful for a fact that doesn't change within a running session. */
const primaryProjectRootByRepo = new Map<string, string | null>();

/**
 * The one tsconfig project root `status`/`build` warm and report on for a
 * repo — chosen deterministically (alphabetically-first match from a
 * top-down walk, skipping build/dependency directories) since neither
 * procedure carries a specific file to scope a query to the way
 * `fileOccurrences`/`references` do (`@repo/code-lsp`'s `resolveProjectRoot`,
 * walking *up* from a queried file, is what those use instead — see that
 * package's AGENTS.md). This project won't necessarily be the one a later
 * `fileOccurrences` call for some other file resolves to — `build`'s job
 * under LSP is "prove the environment can spawn/initialize a real project
 * and keep one warm", not "index the whole repo" (there is no such thing
 * anymore; see this file's own top-of-module note). `null` when the repo
 * has no `tsconfig.json` anywhere, which is also what `isCodeIndexUnsupported`
 * answers.
 */
const resolvePrimaryProjectRoot = (
	repoRoot: string,
): Effect.Effect<string | null, never, FileSystem> =>
	Effect.gen(function* () {
		const cached = primaryProjectRootByRepo.get(repoRoot);
		if (cached !== undefined) return cached;
		const fs = yield* FileSystem;
		const found = yield* findTsConfigProjectRoot(fs, repoRoot, {
			remaining: MAX_DIRECTORIES_VISITED,
		});
		primaryProjectRootByRepo.set(repoRoot, found);
		return found;
	});

/** Exported so `http.ts`'s `build` handler gates on the exact same (memoized) answer `resolveCodeIndexStatus` derives `"unsupported"` from — one source of truth for "does this repo have a tsconfig anywhere." */
export const isCodeIndexUnsupported = (
	repoRoot: string,
): Effect.Effect<boolean, never, FileSystem> =>
	resolvePrimaryProjectRoot(repoRoot).pipe(Effect.map((root) => root === null));

/**
 * The latest transient (never persisted — there is nothing to persist,
 * unlike the old on-disk SCIP cache) build outcome per repo root.
 * `"ready"`/`"failed"` here describe `runCodeIndexBuild`'s *own* warm-up
 * spawn (see `resolvePrimaryProjectRoot`), not "is code navigation usable at
 * all" — `fileOccurrences`/`references` lazily spawn their own per-file
 * servers regardless of what's recorded here, so a `"failed"` build doesn't
 * block them the way a failed SCIP build used to. Gone on sidecar restart,
 * same as `generation-log.ts`'s map — there's no in-flight build left to
 * reattach to after a restart anyway.
 */
const buildStates = new Map<
	string,
	| { readonly kind: "building" }
	| { readonly kind: "ready"; readonly at: number }
	| { readonly kind: "failed"; readonly message: string }
>();

export const describeCodeIndexFailure = (failure: CodeLspFailure): string => {
	switch (failure._tag) {
		case "TsLspBinaryResolutionError":
			return `couldn't resolve the TypeScript language server binary (${failure.strategy}): ${String(failure.cause)}`;
		case "LspProcessError":
			return failure.step === "spawn"
				? `TypeScript language server failed to start: ${String(failure.cause)}`
				: `TypeScript language server failed to initialize: ${String(failure.cause)}`;
		case "LspRequestError":
			return `TypeScript language server request ${failure.method} failed (${failure.reason}): ${String(failure.cause)}`;
		case "LspProtocolError":
			return `TypeScript language server returned an invalid response: ${String(failure.cause)}`;
	}
};

export const describeBuildFailure = (
	failure: TsLspBinaryResolutionError | LspProcessError,
): string => describeCodeIndexFailure(failure);

/** The actual work behind {@link startCodeIndexBuild}: resolves the repo's primary project (see `resolvePrimaryProjectRoot`) and forces a fresh spawn/initialize for it, waiting for an in-flight operation to release its lease first — a real, reusable server on success, sharing the same pool `fileOccurrences`/`references` draw from, not a throwaway health check. */
const runCodeIndexBuild = (
	repoRoot: string,
): Effect.Effect<void, CodeLspFailure, CodeLspPool | FileSystem> =>
	Effect.gen(function* () {
		const projectRoot = yield* resolvePrimaryProjectRoot(repoRoot);
		if (projectRoot === null) {
			// http.ts's `build` handler already checks `isCodeIndexUnsupported`
			// (backed by this exact same memoized lookup) before ever calling
			// `startCodeIndexBuild` — reaching this branch means that gate and
			// this resolution disagreed, a bug in this file rather than
			// something a caller could act on.
			return yield* Effect.die(
				new Error(
					`runCodeIndexBuild called for ${repoRoot}, which resolved no tsconfig project — the UNSUPPORTED gate in http.ts should have refused this first`,
				),
			);
		}
		const pool = yield* CodeLspPool;
		yield* withCodeLspServer(pool, projectRoot, () => Effect.void, true);
	});

/**
 * Starts a build for `repoRoot` and returns once it's registered, well
 * before the build itself finishes — `resolveCodeIndexStatus` is how a
 * caller watches progress from here. A repo already `"building"` is a
 * no-op: the existing run keeps going, nothing new is started. The
 * synchronous `buildStates.set` below, before any `await`, is what makes
 * that race-free — two `build` calls landing back to back both see whichever
 * state the first one set before either yields to the event loop.
 *
 * Uses `Effect.result` rather than letting a failure reject the promise —
 * unwrapping a rejected `Effect.runPromise`'s cause to find a specific
 * tagged error is exactly the Effect-internals-poking this sidesteps, same
 * reasoning as `walkthrough/generate.ts`'s `resolveContext`.
 */
export const startCodeIndexBuild = async (
	repoRoot: string,
	mainContext: Context.Context<AppServices>,
): Promise<void> => {
	if (buildStates.get(repoRoot)?.kind === "building") return;
	buildStates.set(repoRoot, { kind: "building" });

	void (async () => {
		const result = await Effect.runPromise(
			Effect.provide(Effect.result(runCodeIndexBuild(repoRoot)), mainContext),
		);
		buildStates.set(
			repoRoot,
			Result.isSuccess(result)
				? { kind: "ready", at: Date.now() }
				: { kind: "failed", message: describeCodeIndexFailure(result.failure) },
		);
	})();
};

/**
 * `status`'s full derivation: unsupported gates everything else (no
 * `tsconfig.json` anywhere means nothing here could ever work), then
 * `buildStates` decides `absent`/`building`/`ready`/`failed` directly — no
 * `"stale"` state exists to derive (see `packages/sidecar-api/src/code-index.ts`'s
 * own doc comment on why that doesn't apply to a server that always reads
 * live files off disk). `indexedHeadSha` mirrors `headSha` exactly
 * when `ready`, since there is no separate "index" revision to disagree
 * with it anymore; `documentCount` is always `null` (LSP has no equivalent
 * "how many files did this cover" number — a per-file question, not an
 * index-wide one); `generatedAt` is when the primary project's server was
 * last successfully initialized.
 */
export const resolveCodeIndexStatus = (
	repoRoot: string,
	headSha: string,
): Effect.Effect<CodeIndexStatus, never, FileSystem> =>
	Effect.gen(function* () {
		if (yield* isCodeIndexUnsupported(repoRoot)) {
			return {
				status: "unsupported",
				headSha,
				indexedHeadSha: null,
				generatedAt: null,
				documentCount: null,
				failureMessage: null,
			} satisfies CodeIndexStatus;
		}

		const state = buildStates.get(repoRoot);
		if (state === undefined) {
			return {
				status: "absent",
				headSha,
				indexedHeadSha: null,
				generatedAt: null,
				documentCount: null,
				failureMessage: null,
			} satisfies CodeIndexStatus;
		}
		if (state.kind === "building") {
			return {
				status: "building",
				headSha,
				indexedHeadSha: null,
				generatedAt: null,
				documentCount: null,
				failureMessage: null,
			} satisfies CodeIndexStatus;
		}
		if (state.kind === "ready") {
			return {
				status: "ready",
				headSha,
				indexedHeadSha: headSha,
				generatedAt: state.at,
				documentCount: null,
				failureMessage: null,
			} satisfies CodeIndexStatus;
		}
		return {
			status: "failed",
			headSha,
			indexedHeadSha: null,
			generatedAt: null,
			documentCount: null,
			failureMessage: state.message,
		} satisfies CodeIndexStatus;
	});

/** How many reference locations a single `references` call returns — a widely-referenced symbol (an exported type, a common utility) can have thousands; `totalReferenceCount` on the response still reports the real total so the UI can render "showing N of M." */
export const MAX_RETURNED_REFERENCES = 200;

/**
 * Reads `paths`' raw worktree bytes from `repoRoot`, unconditionally — no
 * `includeUncommitted`/`worktreeEligible` gate. `Store.readCurrentContent`
 * (the sidecar's one gate for "what does this path look like right now" —
 * `apps/desktop/sidecar/store.ts`) exists for diff/review semantics, where
 * "current" is a user preference (`includeUncommitted`). The LSP server has
 * no such preference: it reads whatever's physically on disk at `repoRoot`,
 * full stop (see `@repo/code-lsp`'s AGENTS.md — no `textDocument/didOpen`,
 * ever). Reading a code-index preview through the settings-gated path would
 * describe a *different* revision than the one the server's positions were
 * computed against whenever `includeUncommitted` is off and the worktree is
 * dirty. This function is what `groupReferencesByFile`/`buildDefinitionContext`
 * are read through instead, so both halves of a peek agree on their source.
 *
 * Absent paths (deleted, never existed) are simply missing from the
 * result — same "absence is a value" contract `readWorktreeBlobContent`
 * itself uses.
 */
export const readWorktreeFileContents = (
	repoRoot: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, Uint8Array>, WorktreeReadFailed> =>
	Effect.gen(function* () {
		const entries = yield* Effect.forEach(
			paths,
			(path) =>
				readWorktreeBlobContent(join(repoRoot, path)).pipe(
					Effect.map((content) => [path, content] as const),
				),
			{ concurrency: "unbounded" },
		);
		const contents = new Map<string, Uint8Array>();
		for (const [path, content] of entries) {
			if (Option.isSome(content)) contents.set(path, content.value);
		}
		return contents;
	});

/**
 * Every occurrence in `path`, in the shape `codeIndex.fileOccurrences`
 * reports — empty when `path` has no tsconfig project above it. A server
 * startup or request failure remains an error so the caller can retry rather
 * than caching a transient failure as this file's permanent answer.
 *
 * No filtering by semantic-token type: verified empirically (a probe
 * against `@repo/code-lsp`'s own fixture, and consistent with that
 * package's AGENTS.md — "TS's classifier only labels named bindings") that
 * `semanticTokensFull` never emits a token for a keyword, string, comment,
 * number, or operator at all — every token it returns is already a real
 * identifier occurrence, so there's nothing to filter out the way a
 * hand-picked "symbol-ish token types" allowlist would otherwise need to.
 *
 * `semanticTokensFull` was separately verified (twice, independently) to
 * emit **zero tokens on any import line** — both `import type { X }` and a
 * plain value import — even though the same symbol gets a normal token at
 * its usage site later in the file. {@link resolveImportOccurrences}
 * supplements exactly that gap, so ⌘-hover still lights up identifiers
 * inside imports (dense in a review diff) the way the old SCIP-backed
 * implementation did.
 */
export const buildFileOccurrencesResponse = (
	repoRoot: string,
	path: string,
): Effect.Effect<
	ReadonlyArray<CodeIndexOccurrence>,
	CodeLspFailure,
	CodeLspPool
> =>
	Effect.gen(function* () {
		const absolutePath = join(repoRoot, path);
		const projectRoot = resolveProjectRoot(absolutePath);
		if (projectRoot === null) return [];

		const pool = yield* CodeLspPool;
		return yield* withCodeLspServer(pool, projectRoot, (server) =>
			Effect.gen(function* () {
				const tokens = yield* server.semanticTokensFull(absolutePath);

				const tokenOccurrences = tokens.map(
					(token): CodeIndexOccurrence => ({
						line: token.range.start.line,
						charStart: token.range.start.character,
						charEnd: token.range.end.character,
						symbolKey: encodeSymbolKey(
							path,
							token.range.start.line,
							token.range.start.character,
						),
					}),
				);

				const importOccurrences = yield* resolveImportOccurrences(
					server,
					absolutePath,
					path,
					tokenOccurrences,
				);

				return [...tokenOccurrences, ...importOccurrences];
			}),
		);
	});

/**
 * Hard ceiling on how many import-line identifier candidates a single
 * {@link buildFileOccurrencesResponse} call will probe — the explicit cost
 * bound a pathological file (a barrel file re-exporting hundreds of names)
 * needs, since {@link findImportIdentifierSpans} otherwise has no reason to
 * stop early. At the concurrency below and this package's own measured
 * warm-`definition` latency (~13ms, `packages/code-lsp/AGENTS.md`), even the
 * full cap resolves in a few hundred milliseconds, not a stacked-up queue.
 */
const MAX_IMPORT_SPAN_PROBES = 200;

/**
 * How many `definition` probes for import-line candidates are in flight at
 * once. Not `"unbounded"` like `buildReferencesPlan`'s fixed 3-way
 * `Effect.all` below — this fires one request per *candidate identifier*,
 * up to {@link MAX_IMPORT_SPAN_PROBES}, so an unbounded burst against one
 * server process is an avoidable spike rather than a fixed, small fan-out.
 */
const IMPORT_SPAN_PROBE_CONCURRENCY = 16;

/**
 * The import-line supplement to {@link buildFileOccurrencesResponse}'s
 * semantic-token pass (see that function's own doc comment for why one is
 * needed at all). Reads `absolutePath`'s current worktree bytes — the same
 * source `readWorktreeFileContents` reads elsewhere in this module, so a
 * worktree read failure degrades to "nothing to add" rather than failing
 * the whole occurrence set, matching every other degrade-to-empty posture
 * here — finds candidate identifier spans with
 * {@link findImportIdentifierSpans}, and confirms each with a concurrent
 * `definition` probe: only a span a probe actually resolved becomes an
 * occurrence. Never fabricated — a candidate that doesn't resolve (a
 * keyword the line scan missed, a word that only existed inside the module
 * specifier string) is silently dropped, not reported with a guessed or
 * empty definition. `existingOccurrences` is consulted only to skip a
 * position semantic tokens already covered, so a future looser server
 * response can't double-count a position.
 */
const resolveImportOccurrences = (
	server: LspServer,
	absolutePath: string,
	path: string,
	existingOccurrences: ReadonlyArray<CodeIndexOccurrence>,
): Effect.Effect<
	ReadonlyArray<CodeIndexOccurrence>,
	LspRequestError | LspProtocolError
> =>
	Effect.gen(function* () {
		const content = yield* readWorktreeBlobContent(absolutePath).pipe(
			Effect.catch(() => Effect.succeed(Option.none<Uint8Array>())),
		);
		if (Option.isNone(content)) return [];

		const text = new TextDecoder().decode(content.value);
		const coveredPositions = new Set(
			existingOccurrences.map(
				(occurrence) => `${occurrence.line}:${occurrence.charStart}`,
			),
		);
		const candidates = findImportIdentifierSpans(text).filter(
			(span) => !coveredPositions.has(`${span.line}:${span.charStart}`),
		);

		const resolvedSpans = yield* Effect.forEach(
			candidates,
			(span) =>
				server
					.definition(absolutePath, {
						line: span.line,
						character: span.charStart,
					})
					.pipe(
						Effect.map((locations) => (locations.length > 0 ? span : null)),
					),
			{ concurrency: IMPORT_SPAN_PROBE_CONCURRENCY },
		);

		return resolvedSpans
			.filter((span) => span !== null)
			.map(
				(span): CodeIndexOccurrence => ({
					line: span.line,
					charStart: span.charStart,
					charEnd: span.charEnd,
					symbolKey: encodeSymbolKey(path, span.line, span.charStart),
				}),
			);
	});

/** A JS/TS identifier, matched as a whole token — same character class {@link IDENTIFIER_CHAR} (further down this module) checks one character at a time, just as a `g`-flagged whole-token pattern here since {@link findImportIdentifierSpans} needs every match's own position via `matchAll`. */
const IMPORT_IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Reserved words that can appear on an import line but are never themselves an identifier binding (`import type { X as Y } from "..."`) — skipped so a candidate probe isn't wasted on the language's own syntax. */
const IMPORT_LINE_KEYWORDS = new Set([
	"import",
	"type",
	"from",
	"as",
	"default",
]);

/**
 * Blanks out quoted content (module specifiers, and any string that happens
 * to contain identifier-shaped substrings) before token-scanning a line —
 * avoids wasting a `definition` probe on words that only exist inside
 * `"..."`. Preserves every character's original column by replacing with
 * same-length spaces, so positions found afterward via
 * {@link IMPORT_IDENTIFIER_PATTERN} still line up with the real line.
 * Doesn't need to be a real tokenizer (no escaped-quote edge cases beyond a
 * simple backslash check) — a missed edge case only costs one wasted probe,
 * per {@link findImportIdentifierSpans}'s own doc comment.
 */
const blankQuotedContent = (line: string): string =>
	line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (match) =>
		" ".repeat(match.length),
	);

/**
 * Every identifier-shaped token on `text`'s import statements (type-only and
 * value imports alike — named, default, and namespace bindings), found via
 * a plain line scan rather than a real parser: nothing here needs to be
 * exact, since {@link resolveImportOccurrences} only keeps a candidate once
 * a live `definition` probe actually resolves it — a wrong guess (a
 * keyword, or a word that only existed inside the module specifier string)
 * costs exactly one probe that resolves to nothing, never a bad result.
 * Bounded by {@link MAX_IMPORT_SPAN_PROBES} so a pathological import block
 * can't turn one `fileOccurrences` call into an unbounded number of probes.
 */
export const findImportIdentifierSpans = (
	text: string,
): ReadonlyArray<{
	readonly line: number;
	readonly charStart: number;
	readonly charEnd: number;
}> => {
	const spans: Array<{
		readonly line: number;
		readonly charStart: number;
		readonly charEnd: number;
	}> = [];
	const lines = text.split("\n");
	let inImportStatement = false;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] as string;

		if (!inImportStatement) {
			const trimmed = line.trimStart();
			if (!/^import\b/.test(trimmed)) continue;
			// A side-effect-only import (`import "./styles.css";`) binds no
			// identifier at all — nothing here to scan.
			if (/^import\s*['"]/.test(trimmed)) continue;
			inImportStatement = true;
		}

		for (const match of blankQuotedContent(line).matchAll(
			IMPORT_IDENTIFIER_PATTERN,
		)) {
			const word = match[0];
			if (IMPORT_LINE_KEYWORDS.has(word)) continue;
			spans.push({
				line: lineIndex,
				charStart: match.index,
				charEnd: match.index + word.length,
			});
			if (spans.length >= MAX_IMPORT_SPAN_PROBES) return spans;
		}

		// The module specifier closes the statement (with or without a
		// trailing semicolon) — everything through this line has been
		// scanned, so later lines start a fresh (or no) import statement.
		if (/from\s*['"][^'"]*['"]/.test(line)) inImportStatement = false;
	}

	return spans;
};

const SYMBOL_KEY_PATTERN = /^(.*):(\d+):(\d+)$/;

/**
 * `path:line:char` — `path` repo-relative (matching every other `path` field
 * on the wire contract), `line`/`char` the occurrence's own 0-based start
 * position exactly as `semanticTokensFull` reported it (never a click
 * position, or the position of some other point on the token — see
 * `@repo/code-lsp`'s AGENTS.md gotcha on why only a semantic token's own
 * position is safe to query). Opaque to the frontend
 * (`packages/sidecar-api/src/code-index.ts`'s own doc comment on
 * `symbolKey`) — this module is the only encoder/decoder.
 */
const encodeSymbolKey = (
	path: string,
	line: number,
	character: number,
): string => `${path}:${line}:${character}`;

const decodeSymbolKey = (
	symbolKey: string,
): {
	readonly path: string;
	readonly line: number;
	readonly character: number;
} | null => {
	const match = SYMBOL_KEY_PATTERN.exec(symbolKey);
	if (match === null) return null;
	return {
		path: match[1] as string,
		line: Number(match[2]),
		character: Number(match[3]),
	};
};

/** A single go-to-definition/find-references location, repo-relative — the shape both `definition` and each `references` entry reduce to before this module hands them to the wire contract's `CodeIndexLocation`/`CodeIndexReference` shapes. */
type CodeLocation = {
	readonly path: string;
	readonly line: number;
	readonly charStart: number;
	readonly charEnd: number;
};

const toCodeLocation = (
	repoRoot: string,
	location: LspLocation,
): CodeLocation => ({
	path: relative(repoRoot, location.path),
	line: location.range.start.line,
	charStart: location.range.start.character,
	charEnd: location.range.end.character,
});

const sameLocation = (a: CodeLocation, b: CodeLocation | null): boolean =>
	b !== null &&
	a.path === b.path &&
	a.line === b.line &&
	a.charStart === b.charStart &&
	a.charEnd === b.charEnd;

/**
 * Everything `codeIndex.references` needs about `symbolKey`, resolved
 * against a live LSP server — source line text isn't decided here since
 * that needs a file read (`readWorktreeFileContents`), which lives at the
 * `http.ts` call site alongside `buildReferencesResponse`, not in this
 * module. A `symbolKey` this module can't decode, or whose file has no
 * tsconfig project above it, returns {@link EMPTY_REFERENCES_PLAN}. A server
 * startup or request failure is propagated so the caller can retry instead
 * of caching an incomplete plan as a successful empty result.
 */
export const buildReferencesPlan = (
	repoRoot: string,
	symbolKey: string,
): Effect.Effect<ReferencesPlan, CodeLspFailure, CodeLspPool> =>
	Effect.gen(function* () {
		const decoded = decodeSymbolKey(symbolKey);
		if (decoded === null) return EMPTY_REFERENCES_PLAN;

		const absolutePath = join(repoRoot, decoded.path);
		const projectRoot = resolveProjectRoot(absolutePath);
		if (projectRoot === null) return EMPTY_REFERENCES_PLAN;

		const pool = yield* CodeLspPool;
		return yield* withCodeLspServer(pool, projectRoot, (server) =>
			Effect.gen(function* () {
				const position = {
					line: decoded.line,
					character: decoded.character,
				};
				const [definitions, rawReferences, hover] = yield* Effect.all(
					[
						server.definition(absolutePath, position),
						server.references(absolutePath, position),
						server.hover(absolutePath, position),
					],
					{ concurrency: "unbounded" },
				);

				const firstDefinition = definitions[0];
				const definition =
					firstDefinition === undefined
						? null
						: toCodeLocation(repoRoot, firstDefinition);

				// `references` answers the definition's own location alongside every
				// usage (`@repo/code-lsp`'s fixed `includeDeclaration: true`) —
				// filtered back out here so "references" means "used elsewhere",
				// matching what the peek panel already renders the definition as
				// separately (`code-index-peek-panel.tsx`'s left pane).
				const usageLocations = rawReferences
					.map((location) => toCodeLocation(repoRoot, location))
					.filter((location) => !sameLocation(location, definition));

				return {
					symbolPath: decoded.path,
					symbolLine: decoded.line,
					symbolChar: decoded.character,
					documentation: hover === null ? [] : [hover.contents],
					definition,
					totalReferenceCount: usageLocations.length,
					returnedLocations: usageLocations.slice(0, MAX_RETURNED_REFERENCES),
				} satisfies ReferencesPlan;
			}),
		);
	});

type ReferencesPlan = {
	/** The queried occurrence's own repo-relative path/position — carried through so `buildReferencesResponse` can derive `displayName` from the live source text, the same live-read source `groupReferencesByFile`/`buildDefinitionContext` use for everything else. */
	readonly symbolPath: string;
	readonly symbolLine: number;
	readonly symbolChar: number;
	readonly documentation: ReadonlyArray<string>;
	readonly definition: CodeLocation | null;
	readonly totalReferenceCount: number;
	readonly returnedLocations: ReadonlyArray<CodeLocation>;
};

const EMPTY_REFERENCES_PLAN: ReferencesPlan = {
	symbolPath: "",
	symbolLine: 0,
	symbolChar: 0,
	documentation: [],
	definition: null,
	totalReferenceCount: 0,
	returnedLocations: [],
};

/** A real JS/TS identifier character — used only to find where an identifier ends once {@link readIdentifierAt} already knows where it starts (a `symbolKey`/definition position is always a token's own start, per `encodeSymbolKey`'s doc comment), never to verify anything. */
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/** The identifier text starting at `(line, character)` in `path`'s current content — `references`' `displayName`, read live off whatever `fileContents` holds (always `readWorktreeFileContents`'s output; see that function's own doc comment). `""` when the file wasn't fetched or the position is past the end of its content — same "absence is a value" posture as everything else in this module, never a placeholder like `"?"`. */
const readIdentifierAt = (
	fileContents: ReadonlyMap<string, Uint8Array>,
	path: string,
	line: number,
	character: number,
): string => {
	const bytes = fileContents.get(path);
	if (bytes === undefined) return "";
	const lineText = new TextDecoder().decode(bytes).split("\n")[line];
	if (lineText === undefined) return "";
	let end = character;
	while (
		end < lineText.length &&
		IDENTIFIER_CHAR.test(lineText[end] as string)
	) {
		end += 1;
	}
	return lineText.slice(character, end);
};

/**
 * Groups `locations` by file, attaching each one's source line text from
 * `fileContents` — `lineText` is `null` only when the read genuinely can't
 * back it (the path wasn't fetched, or the line doesn't exist in the
 * current content). Unlike the SCIP-backed version this replaces, there is
 * no drift check here: the LSP server answered these positions against the
 * same live worktree bytes `fileContents` holds (both go through
 * `readWorktreeFileContents`), so a mismatch between the two isn't possible
 * the way it was for a static, potentially-hours-old on-disk index — see
 * this module's own top-of-file note and `packages/sidecar-api/src/code-index.ts`'s
 * updated doc comment on `CodeIndexReference.lineText`.
 */
export const groupReferencesByFile = (
	locations: ReadonlyArray<CodeLocation>,
	fileContents: ReadonlyMap<string, Uint8Array>,
): ReadonlyArray<CodeIndexFileReferences> => {
	const decoder = new TextDecoder();
	const byPath = new Map<string, Array<CodeIndexReference>>();

	for (const location of locations) {
		const bytes = fileContents.get(location.path);
		const lineText =
			bytes === undefined
				? undefined
				: decoder.decode(bytes).split("\n")[location.line];
		const entry: CodeIndexReference = {
			line: location.line,
			charStart: location.charStart,
			charEnd: location.charEnd,
			lineText: lineText ?? null,
		};
		const existing = byPath.get(location.path);
		if (existing === undefined) byPath.set(location.path, [entry]);
		else existing.push(entry);
	}

	return [...byPath.entries()].map(([path, references]) => ({
		path,
		references,
	}));
};

/** Lines of context padded around the definition's own line — enough for the dialog's source preview to show roughly 21 lines total without another worktree read. */
const DEFINITION_CONTEXT_LINES_BEFORE = 10;
const DEFINITION_CONTEXT_LINES_AFTER = 10;

/**
 * `definition`'s surrounding source lines from `fileContents` (always
 * `readWorktreeFileContents`'s output) — `null` when there's no definition
 * to begin with, or its file wasn't fetched. No drift check, for the same
 * reason `groupReferencesByFile` no longer has one — see that function's
 * doc comment.
 */
const buildDefinitionContext = (
	definition: CodeLocation | null,
	fileContents: ReadonlyMap<string, Uint8Array>,
): CodeIndexSourceContext | null => {
	if (definition === null) return null;

	const bytes = fileContents.get(definition.path);
	if (bytes === undefined) return null;

	const contentLines = new TextDecoder().decode(bytes).split("\n");
	const targetLine = contentLines[definition.line];
	if (targetLine === undefined) return null;

	const startLine = Math.max(
		0,
		definition.line - DEFINITION_CONTEXT_LINES_BEFORE,
	);
	const endLine = Math.min(
		contentLines.length - 1,
		definition.line + DEFINITION_CONTEXT_LINES_AFTER,
	);
	return { startLine, lines: contentLines.slice(startLine, endLine + 1) };
};

/**
 * Assembles the full `codeIndex.references` wire response from a plan and
 * its resolved file contents — `fileContents` must be read via
 * {@link readWorktreeFileContents}, and must include `plan.symbolPath` (for
 * `displayName`) alongside `plan.definition`'s own path and every
 * `returnedLocations` path, or the corresponding piece silently degrades to
 * its own "couldn't read this" value (`""` / `null`).
 */
export const buildReferencesResponse = (
	plan: ReferencesPlan,
	fileContents: ReadonlyMap<string, Uint8Array>,
): CodeIndexReferencesResult => ({
	displayName: readIdentifierAt(
		fileContents,
		plan.symbolPath,
		plan.symbolLine,
		plan.symbolChar,
	),
	documentation: plan.documentation,
	definition: plan.definition,
	definitionContext: buildDefinitionContext(plan.definition, fileContents),
	files: groupReferencesByFile(plan.returnedLocations, fileContents),
	totalReferenceCount: plan.totalReferenceCount,
	returnedReferenceCount: plan.returnedLocations.length,
});
