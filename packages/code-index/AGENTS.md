# @repo/code-index

SCIP-powered "go to definition" / "find references" backend — indexes a repo's TypeScript with
`@sourcegraph/scip-typescript`, decodes the resulting `.scip` protobuf into a compact in-memory
structure, and answers position→symbol and symbol→occurrence queries against it. Pure decode/query
+ indexing/caching primitives; no oRPC, no process-lifetime state — that lives in
`apps/desktop/sidecar/code-index/` (mirrors how `packages/walkthrough` stays I/O-free while
`apps/desktop/sidecar/walkthrough/generation-log.ts` owns the in-memory generation state).

- `src/symbol.ts` — parses the SCIP symbol string grammar (`scip.proto`'s `<symbol>` production):
  `isLocalSymbol`, `parseSymbol` (global vs `local <id>`, descriptor chain), `deriveDisplayName`
  (the last descriptor's name — `SymbolInformation.displayName` is always empty from
  scip-typescript), and `symbolKeyOf(documentPath, symbol)`, the composite lookup key. A `local `
  symbol is only unique **within its own document** (SCIP spec), so its key folds in
  `documentPath`; a global symbol's key is the symbol string alone.
- `src/decode.ts` — `decodeIndex(bytes)`: `fromBinary(IndexSchema, bytes)` once, then walks every
  document's occurrences into compact `{ range, symbolKey, isDefinition }` records and per-symbol
  maps (definitions, references, display names, documentation), and lets the decoded protobuf
  `Index` fall out of scope — nothing here retains it past this one pass, since 62k+ occurrences as
  live protobuf objects is real memory. Query functions: `occurrencesInDocument`, `symbolAtPosition`
  (half-open range containment, boundary-tested), `definitionsOf`, `referencesOf`,
  `documentationOf`, `displayNameOf`.
- `src/indexer.ts` — spawns scip-typescript against a repo root (`effect/unstable/process`, same
  `ChildProcess.make` + `Effect.scoped` + concurrent stdout/stderr/exitCode shape as
  `packages/git/src/exec.ts`). Only a nonzero exit code is a failure — scip-typescript's one
  harmless stderr line about an empty root `tsconfig.json` `files` array is not.
  `detectTsConfigPresence` backs the contract's `unsupported` status — lenient, matches any
  `tsconfig*.json` anywhere. `resolveWorkspaceArgs` decides what to actually pass to `index`:
  `--pnpm-workspaces` when `pnpm-workspace.yaml` exists (one process, scip-typescript's own `pnpm
  ls -r` enumeration); otherwise every directory under the repo root with its own exact
  `tsconfig.json`, passed as explicit positional project arguments in one invocation
  (`collectTsConfigProjectRoots`) — covers a plain single-project repo (resolves to `["."]`) and
  npm/yarn/bun workspaces and any other layout whose tsconfigs simply live in subdirectories,
  uniformly, with no separate workspace-file detection needed for those. `--yarn-workspaces` is
  deliberately not used for a yarn/npm/bun-declared `workspaces` field — verified live, it shells
  out to a real `yarn workspaces list`/`info` rather than reading `package.json` directly, and
  fails outright on any machine without yarn installed. Passing multiple explicit projects in one
  invocation needs no manual multi-`.scip` merging either: scip-typescript computes every
  document's `relativePath` from its single shared `--cwd`, not from each project's own root.
- `src/bootstrap.ts` — resolves what to spawn: `NISI_SCIP_TYPESCRIPT_BIN` or a bare
  `scip-typescript` already on `PATH` (checked via `@repo/bin-resolver`), spawned directly; failing
  that, a pinned copy of `@sourcegraph/scip-typescript@0.4.0` installed into
  `~/.nisi/tools/scip-typescript` on first use (outside any pnpm workspace, same reasoning as
  `@repo/harness-local`'s `~/.nisi/harness-sandbox`) via a system `npm`/`node` resolved the same
  way, guarded by a version-stamped marker file so later calls skip straight to spawning. The
  pinned copy is always spawned as `node <entry.js> ...args`, never executed directly — its
  `#!/usr/bin/env node` shebang would otherwise need `node` on the *child's* `PATH`, which a
  GUI-launched `.app` doesn't have (see `@repo/bin-resolver`'s own doc on this exact failure mode).
- `src/cache.ts` — on-disk content-addressed cache: `<dataDir>/code-index/<sha256(repoRoot)>/<headSha>.scip`.
  No metadata store — `generatedAt` is the file's own mtime, and "is this repo's index stale"
  is answered by "does `<currentHeadSha>.scip` exist", not a written status field. Keeps only the
  2 most recent index files per repo (`pruneStaleIndexes`), so the data dir doesn't grow by one
  full index per commit reviewed.
- `src/errors.ts` — typed failures: `ScipDecodeError`, `ScipTypescriptInstallError`,
  `ScipTypescriptIndexError` (nonzero-exit only), `CodeIndexCacheError`.

## Gotchas

- `SymbolInformation.displayName` and `.signatureDocumentation` are empty from scip-typescript —
  a display name always comes from `deriveDisplayName`, and a signature (when present at all)
  arrives folded into `SymbolInformation.documentation` as a fenced code block plus prose, not
  through `signatureDocumentation`.
- scip-typescript populates only the deprecated `Occurrence.range: number[]` field (3 or 4
  elements, 0-based, half-open `[start, end)`), never `typedRange` — `decodeRange` handles both
  lengths; anything else is a decode error, not a silently-tolerated shape.
- `Document.positionEncoding` is always `Unspecified` from this indexer — treated as UTF-16 code
  units throughout (matches JS string indexing), never read from the field itself.
