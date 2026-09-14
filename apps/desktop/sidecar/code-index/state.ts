import { join, relative } from "node:path";
import type {
	LspLocation,
	LspProcessError,
	LspProtocolError,
	LspRequestError,
	LspServer,
	TsLspBinaryResolutionError,
} from "@repo/code-lsp";
import { spawnLspServer } from "@repo/code-lsp";
import { readWorktreeBlobContent, type WorktreeReadFailed } from "@repo/git";
import type {
	CodeIndexFileReferences,
	CodeIndexOccurrence,
	CodeIndexReference,
	CodeIndexReferencesResult,
	CodeIndexSourceContext,
} from "@repo/sidecar-api";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	RcMap,
	Semaphore,
} from "effect";
import type * as Scope from "effect/Scope";

/**
 * How many TS7 LSP server processes stay live at once, across all open
 * worktree roots (the pool is process-lifetime, not per-session — see
 * `CodeLspPool` below). A root server can reach roughly 773 MiB resident in
 * this repository after its relevant documents are opened; two such servers
 * keep the worst measured footprint around 1.5 GiB while still allowing two
 * repositories to be reviewed concurrently. Capacity-bounded eviction keeps
 * a large number of open PRs from growing an unbounded process registry, and
 * a full pool of leased servers waits rather than evicting an active server.
 */
const MAX_LIVE_LSP_SERVERS = 2;

/**
 * The sidecar's one registry of live `tsc --lsp --stdio` processes, keyed by
 * the exact worktree root resolved by `Store.resolveSessionRepoRoot`. One
 * root server owns the repository's project service, so references can see
 * projects loaded from multiple packages. `RcMap` shares an in-flight spawn
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
			lookup: (repoRoot: string) => spawnLspServer(repoRoot),
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
	| LspProtocolError
	| WorktreeReadFailed;

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
	repoRoot: string,
):
	| RcMap.State.Entry<
			LspServer,
			TsLspBinaryResolutionError | LspProcessError | Cause.ExceededCapacityError
	  >
	| undefined => {
	const state = pool.resources.state;
	if (state._tag === "Closed") return undefined;
	for (const pair of state.map) {
		if (pair[0] === repoRoot) return pair[1];
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
	repoRoot: string,
	refresh: boolean,
): Effect.Effect<LspServer, CodeLspFailure, Scope.Scope> =>
	Effect.gen(function* () {
		while (true) {
			const lease = yield* pool.admissionLock.withPermit(
				Effect.gen(function* () {
					const entry = findPoolEntry(pool, repoRoot);
					if (refresh && entry !== undefined) {
						if (entry.refCount > 0) return Option.none<LspServer>();
						yield* RcMap.invalidate(pool.resources, repoRoot);
					}

					if (
						findPoolEntry(pool, repoRoot) === undefined &&
						poolSize(pool) >= pool.resources.capacity
					) {
						const idleRoot = findIdlePoolRoot(pool);
						if (idleRoot === undefined) return Option.none<LspServer>();
						yield* RcMap.invalidate(pool.resources, idleRoot);
					}

					return yield* RcMap.get(pool.resources, repoRoot).pipe(
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
	repoRoot: string,
): Effect.Effect<void> =>
	pool.admissionLock.withPermit(
		Effect.gen(function* () {
			const entry = findPoolEntry(pool, repoRoot);
			if (entry === undefined || entry.refCount > 0) return;
			yield* RcMap.invalidate(pool.resources, repoRoot);
		}),
	);

export const withCodeLspServer = <
	A,
	E extends LspRequestError | LspProtocolError | WorktreeReadFailed,
>(
	pool: CodeLspPoolValue,
	repoRoot: string,
	use: (server: LspServer) => Effect.Effect<A, E>,
	refresh = false,
): Effect.Effect<A, E | CodeLspFailure> => {
	const operation = Effect.scoped<A, E | CodeLspFailure, Scope.Scope>(
		Effect.gen(function* () {
			const server = yield* acquireCodeLspServer(pool, repoRoot, refresh);
			return yield* use(server);
		}),
	);
	return operation.pipe(
		Effect.onExit((exit) =>
			Exit.isSuccess(exit)
				? Effect.void
				: invalidateIdleCodeLspServer(pool, repoRoot),
		),
	);
};

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
		case "WorktreeReadFailed":
			return `failed to read ${failure.path} for TypeScript language server: ${String(failure.cause)}`;
	}
};

/** How many reference locations a single `references` call returns — a widely-referenced symbol (an exported type, a common utility) can have thousands; `totalReferenceCount` on the response still reports the real total so the UI can render "showing N of M." */
export const MAX_RETURNED_REFERENCES = 200;

/**
 * Reads `paths`' raw worktree bytes from `repoRoot`, unconditionally — no
 * `includeUncommitted`/`worktreeEligible` gate. `Store.readCurrentContent`
 * (the sidecar's one gate for "what does this path look like right now" —
 * `apps/desktop/sidecar/store.ts`) exists for diff/review semantics, where
 * "current" is a user preference (`includeUncommitted`). The LSP server has
 * no such preference: it reads whatever's physically on disk at `repoRoot`,
 * full stop (see `@repo/code-lsp`'s AGENTS.md — the LSP client receives the
 * same bytes through `openDocument` before project-sensitive queries). Reading
 * a code-index preview through the settings-gated path would
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

const openWorktreeDocument = (
	server: LspServer,
	absolutePath: string,
): Effect.Effect<Option.Option<Uint8Array>, WorktreeReadFailed> =>
	Effect.gen(function* () {
		const content = yield* readWorktreeBlobContent(absolutePath);
		if (Option.isNone(content)) return content;
		yield* server.openDocument(
			absolutePath,
			new TextDecoder().decode(content.value),
		);
		return content;
	});

/**
 * Every occurrence in `path`, in the shape `codeIndex.fileOccurrences`
 * reports. The root-scoped server decides whether the file belongs to a
 * configured or inferred TypeScript project; a server startup, worktree-read,
 * or request failure remains an error so the caller can retry rather than
 * caching a transient failure as this file's permanent answer.
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
		const pool = yield* CodeLspPool;
		return yield* withCodeLspServer(pool, repoRoot, (server) =>
			Effect.gen(function* () {
				const content = yield* openWorktreeDocument(server, absolutePath);
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
					content,
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
 * needed at all). Uses the current worktree bytes already read while opening
 * `absolutePath` — the same source `readWorktreeFileContents` reads elsewhere
 * in this module — and finds candidate identifier spans with
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
	content: Option.Option<Uint8Array>,
): Effect.Effect<
	ReadonlyArray<CodeIndexOccurrence>,
	LspRequestError | LspProtocolError
> =>
	Effect.gen(function* () {
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
 * module. A `symbolKey` this module can't decode returns
 * {@link EMPTY_REFERENCES_PLAN}. The queried document is opened on the
 * root-scoped server before the project-sensitive requests, making project
 * discovery independent of which package happened to be queried first. A
 * server startup, worktree-read, or request failure is propagated so the
 * caller can retry instead of caching an incomplete plan as a successful
 * empty result.
 */
export const buildReferencesPlan = (
	repoRoot: string,
	symbolKey: string,
): Effect.Effect<ReferencesPlan, CodeLspFailure, CodeLspPool> =>
	Effect.gen(function* () {
		const decoded = decodeSymbolKey(symbolKey);
		if (decoded === null) return EMPTY_REFERENCES_PLAN;

		const absolutePath = join(repoRoot, decoded.path);
		const pool = yield* CodeLspPool;
		return yield* withCodeLspServer(pool, repoRoot, (server) =>
			Effect.gen(function* () {
				yield* openWorktreeDocument(server, absolutePath);
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
 * Groups `locations` by file, attaching each one's source line from
 * `fileContents` — `lineText` is `null` only when the read genuinely can't
 * back it (the path wasn't fetched, or the line doesn't exist in the current
 * content). Padded reference context is fetched separately by
 * `codeIndex.referenceContext`, so a large references response does not carry
 * 21 lines for every row. Unlike the SCIP-backed version this
 * replaces, there is no drift check here: the LSP server answered these
 * positions against the same live worktree bytes `fileContents` holds (both
 * go through `readWorktreeFileContents`), so a mismatch between the two isn't
 * possible the way it was for a static, potentially-hours-old on-disk index.
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

/** Lines of context padded around a code location — enough for the dialog's source preview to show roughly 21 lines total. */
const SOURCE_CONTEXT_LINES_BEFORE = 10;
const SOURCE_CONTEXT_LINES_AFTER = 10;

/**
 * A location's surrounding source lines from `fileContents` (always
 * `readWorktreeFileContents`'s output) — `null` when its file wasn't fetched
 * or its line no longer exists. No drift check, for the same reason
 * `groupReferencesByFile` no longer has one — see that function's doc
 * comment.
 */
export function buildSourceContext(
	location: Pick<CodeLocation, "path" | "line">,
	fileContents: ReadonlyMap<string, Uint8Array>,
): CodeIndexSourceContext | null {
	const bytes = fileContents.get(location.path);
	if (bytes === undefined) return null;

	const contentLines = new TextDecoder().decode(bytes).split("\n");
	const targetLine = contentLines[location.line];
	if (targetLine === undefined) return null;

	const startLine = Math.max(0, location.line - SOURCE_CONTEXT_LINES_BEFORE);
	const endLine = Math.min(
		contentLines.length - 1,
		location.line + SOURCE_CONTEXT_LINES_AFTER,
	);
	return { startLine, lines: contentLines.slice(startLine, endLine + 1) };
}

const buildDefinitionContext = (
	definition: CodeLocation | null,
	fileContents: ReadonlyMap<string, Uint8Array>,
): CodeIndexSourceContext | null =>
	definition === null ? null : buildSourceContext(definition, fileContents);

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
