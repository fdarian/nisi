# @repo/walkthrough

Everything about *what* the walkthrough agent is asked and whether its answer is acceptable — the
brief it's given, the output schema, the tools it writes through, and the reference validation
that turns a broken answer into feedback instead of an exception (coverage rides alongside as
informational data, never a reason to reject one). Pure and testable without spawning an agent: no
SQLite, no process spawning, no network. Depends on `@repo/git` for the diff model
(`Hunk`/`parseHunks`, `FileChange`) but does no I/O of its own — every function here takes
already-fetched data (a patch string, a line count) rather than reading files or shelling out.
Feeds `packages/sidecar-api`'s `walkthrough` contract; consumed by the sidecar together with
`@repo/harness-local` (the actual agent transport — this package doesn't know it exists).

- `schema.ts` — `Walkthrough`/`Section`/`ReferenceBlock`/`Location` (Effect Schema), plus
  `walkthroughJsonSchema`, generated via `Schema.toJsonSchemaDocument` — never hand-written, so
  the system prompt's schema and the decoder can't drift apart.
- `buffer.ts` — `WalkthroughBuffer` (the single implicit output target) and `applyEdit`, the pure
  string-replacement algorithm behind the `edit` tool: exact match, unique unless `replaceAll`,
  same semantics as Claude Code's own Edit tool.
- `tools.ts` — `createWalkthroughTools(buffer)`: the AI SDK `tool()` definitions (`write`/`edit`)
  that mutate one bound buffer. No file path on either — there's exactly one walkthrough per
  turn.
- `coverage.ts` — `changedLineRanges` (added-line ranges out of a patch's hunks, in head-file
  numbering) and `validateCoverage` (which of those ranges no reference block's locations claim).
  Informational, not a gate — see `validate.ts`.
- `references.ts` — reference integrity independent of coverage: unique ids, every
  `[text](ref:<id>)` link resolves to a real block, every location points at a real changed file
  within its actual line count.
- `validate.ts` — `decodeBuffer` (JSON parse + schema decode, both as data, never thrown) and
  `evaluateWalkthrough`, the per-turn feedback loop. Decode and reference-integrity failures block
  and produce retry feedback; a walkthrough that clears both is `valid` regardless of coverage,
  which rides along on the result as informational gaps for the caller to persist, not a reason to
  reject the answer.
- `overview.ts` — `buildOverview`: the compact brief handed to the agent in place of a patch dump —
  the base/head refs, a one-line-per-file summary (path, status, category, added/deleted counts,
  no patch text), and the PR title when the session has one. The agent has `bash` and runs inside
  the real worktree, so it's expected to read whatever it decides matters rather than work from
  this text alone.
- `prompt.ts` — `buildSystemPrompt`, generated instructions plus the embedded JSON Schema.
- `db/schema.ts` — the `walkthroughs` table (Drizzle), exported via the package's `./db`
  subpath so the sidecar can import it without pulling in this package's agent/validation
  surface. Schema-only, no I/O — the actual store (open connection, read/write rows) lives in
  `apps/desktop/sidecar`, not here, per this package's no-I/O rule; `db:generate` (mirroring
  `@repo/review`'s) still lives in this package because the *migrations* are this domain's,
  even though the runtime connection (`@repo/db`'s `SqliteDb`) is shared. The generated bundle
  is exported too, as inert data, via `./db-migrations` (`.gen/migrations.gen.ts`) — the sidecar
  passes it to `@repo/db`'s `applyEmbeddedMigrations` itself, since even calling that is I/O this
  package doesn't do.

## Non-obvious decisions

- **A purely-deleted file needs no coverage, with no special-casing.** `Location` is 1-based in
  **head** content, so a deleted file has nothing valid to point at. `changedLineRanges` only
  counts `+` lines; a deletion-only patch has none, so it never appears in the coverage map —
  the exemption falls out of the line-range extraction itself rather than being a branch
  somewhere that checks `status === "deleted"`.
- **Reference integrity is checked before coverage is computed, not concurrently.** A location that
  hallucinates a path or an out-of-range line is meaningless as "coverage" — checking references
  first means the coverage gaps a `valid` result carries are only ever computed once every location
  is known to point somewhere real, rather than being noise mixed in with a broken document's
  retry feedback.
- **Excess JSON properties are dropped, not rejected.** The generated JSON Schema still declares
  `additionalProperties: false` (so the model is told not to add one), but Effect's decoder is
  lenient by default — a stray field from the model costs nothing rather than burning a retry
  turn on something harmless. Don't add `{ onExcessProperty: "error" }` without deciding that
  tradeoff is worth it.
- **`ChangedFileFacts.lineCount` is supplied by the caller, not computed here.** Getting a file's
  true head line count means reading its content — I/O this package deliberately doesn't do. The
  caller (sidecar wiring) already has it from `@repo/git`'s `getFileContents()`' `newContent`; a file
  with no head content (a deletion) is simply omitted, so a `Location` pointing at it reports
  `unknown-file` rather than a misleading `out-of-range` against a fabricated zero.

## Gotchas

- `Schema.Int`/`Schema.String` constraints are `.check(Schema.isGreaterThanOrEqualTo(1))` /
  `.check(Schema.isMinLength(1))` in this Effect version, not `Schema.greaterThanOrEqualTo(...)`
  piped combinators — the latter don't exist here.
- `Schema.decodeUnknownResult` returns an `effect/Result`, not an `Either` or a thrown value —
  match it with `Result.isSuccess`/`Result.match`, and read the message off
  `SchemaError.message` (already formatted, multi-line, human-readable).
- **`tool()`'s `inputSchema` is `jsonSchema(...)` from `ai`, not a bare `Schema.toStandardSchemaV1(EffectSchema)`.**
  `Schema.toStandardSchemaV1`'s output has no `~standard.jsonSchema` extension, and AI SDK's
  `asSchema()` only derives a JSON Schema from a bare Standard Schema for the `zod` vendor — every
  other vendor needs that extension or gets treated as schema-less. Adapters that must advertise a
  tool's shape to an *external* process (Claude Code, OpenCode — both drive the model through MCP)
  silently got an empty schema this way; confirmed live, the model called `write` with no arguments
  at all, having never seen `content` was a parameter. Codex's adapter doesn't register tools over
  MCP, so it worked either way — don't let that fool you into thinking the bare bridge is sufficient.
  `tools.ts`'s `toToolInputSchema` builds the real JSON Schema via the same
  `Schema.toJsonSchemaDocument` technique `schema.ts` uses for the system prompt, and wires the
  Standard Schema's own decoder in as `jsonSchema()`'s `validate`. `@repo/sidecar-api`'s `events.ts`
  still uses the bare `Schema.toStandardSchemaV1` bridge correctly — `eventIterator` only needs
  runtime validation, never a JSON Schema to hand to an external process.
