# @repo/code-lsp

A JSON-RPC-over-stdio client for TypeScript 7's native LSP server (`<tsc> --lsp --stdio`) —
`references`, `definition`, `hover`, and `semanticTokens/full` against a live process, no index
built or cached anywhere. One server process per project root (per `tsconfig.json` directory), not
per repo: `spawnLspServer(rootPath)` spawns, completes `initialize`/`initialized`, and returns an
`LspServer` scoped to the caller's `Scope` — the process (and its stdio pump fibers) dies when that
scope closes. Pure otherwise: no oRPC, no SQLite, no filesystem walking to find a `tsconfig.json`
(that's the caller's job — see "One project root per server" below).

Nothing here ever sends `textDocument/didOpen`. The server reads files straight off disk given
`rootUri`/`workspaceFolders`, which is both simpler and faster than tracking open-document state for
a client that only ever asks one-shot questions.

## Public API

- `spawnLspServer(rootPath): Effect<LspServer, TsLspBinaryResolutionError | LspProcessError, Scope | ChildProcessSpawner>`
  — the only constructor. `LspServer` exposes `semanticTokensFull(path)`, `references(path, position)`,
  `definition(path, position)`, and `hover(path, position)`, all `Effect<_, LspRequestError | LspProtocolError>`.
  Every path in and out is a plain filesystem path — `file://` URIs never leak into or out of this API.
- `resolveTsLspBinary()` (`src/binary.ts`) — resolves the absolute path to the platform `tsc` binary.
  Exported mainly so a caller can check it independently of spawning.
- `resolveProjectRoot(filePath)` (`src/project-root.ts`) — walks up from `filePath` to the nearest
  ancestor directory holding a `tsconfig.json`, `null` if none. The piece "One project root per
  server" (below) says a caller must own; it lives here anyway (see that section) since it's pure
  and this package's own integration test already proved the scoping it exists for matters.

## File map

- `src/protocol.ts` — pure wire-level pieces: `Content-Length` frame codec (`encodeFrame`/
  `decodeFrames`), classifying a decoded message (`classifyMessage`), the server-request
  auto-responder (`autoResponderResult`), and decoding the LSP result shapes the four queries
  consume (`decodeLocations`, `decodeHover`) plus `pathToUri`/`uriToPath`.
- `src/semantic-tokens.ts` — `decodeSemanticTokens`: the delta-encoding decode against a negotiated
  legend.
- `src/binary.ts` — `resolveTsLspBinary`: dev vs. compiled binary resolution (see gotcha below).
- `src/project-root.ts` — `resolveProjectRoot`: the nearest-`tsconfig.json` upward walk described
  above.
- `src/client.ts` — the process lifecycle (spawn, wire the stdin/stdout pumps, `initialize`, graceful
  shutdown) and the four query methods, composing everything above. The one file that touches
  `ChildProcessSpawner`.
- `src/errors.ts` — `TsLspBinaryResolutionError`, `LspProcessError`, `LspProtocolError`,
  `LspRequestError`.

## One project root per server

`spawnLspServer` takes a root and nothing else — it does not pool or key servers by root, and it
never calls `resolveProjectRoot` itself. A caller still has to decide *which* root to spawn against,
and to pool/bound however many it ends up spawning — the sidecar's
`apps/desktop/sidecar/code-index/state.ts` owns that (a capacity-bounded, LRU-evicted registry keyed
by exactly the roots `resolveProjectRoot` resolves to). This split exists because reference counts
are **not stable across project loads**: querying a symbol from a fresh server scoped to its own
project gives a different (and correct) count than querying the same symbol after a *different*
project has already cold-loaded in the same server — the most-recently-loaded project scopes the
query. Verified against this repo: `packages/settings/src/store.ts`'s `SettingsStore` gives 24
references in 4 files from a server rooted at `packages/settings` alone; a server that has also
loaded a second project can give a different count for the same query. `test/client.test.ts`'s
repo-integration test pins the 24/4 numbers as a regression check.

## Gotchas

- **Every server-initiated request must get a reply, or `references` hangs forever.** Mid-request the
  server sends `client/registerCapability` (a request, not a notification) and a few others
  (`workspace/configuration`, `window/workDoneProgress/create`). An unanswered one blocks the server
  on the round trip — it presents as a hang with the child process burning zero CPU, not a crash.
  `autoResponderResult` (`protocol.ts`) answers every server-initiated request, including methods it
  doesn't specifically recognize, with `null` (or, for `workspace/configuration`, one `null` per
  requested item).
- **The semantic-tokens legend is negotiated, and an incomplete declaration silently breaks it.** If
  `initialize`'s `capabilities.textDocument.semanticTokens` doesn't declare the full standard
  `tokenTypes`/`tokenModifiers` set, the server negotiates a smaller legend — every later token's type
  index is then meaningless, not just missing the undeclared types. `client.ts`'s
  `CLIENT_CAPABILITIES` declares the full 2023 LSP standard set; `decodeSemanticTokens` reads the
  legend from `initialize`'s own response at runtime rather than hardcoding it.
- **`positionEncoding` is asserted, not assumed.** Every position this client sends/receives is
  UTF-16 code units (matching JS string indexing) — `assertUtf16PositionEncoding` (`client.ts`) checks
  the server's `initialize` response and fails loudly (a defect, not a typed error — there's nothing a
  caller could do differently) if it ever disagrees.
- **A position that isn't on an identifier snaps to the nearest one later on the same line rather than
  answering empty.** Only query positions that came from a `semanticTokensFull` token. Genuinely
  out-of-range positions and syntax-broken files *do* answer cleanly (`references` on nowhere gives
  `[]`; `hover` on unresolvable code can give `null`) — nothing here treats that as an error.
- **`typescript/lib/getExePath.js` isn't importable as a bare specifier.** It resolves the platform
  `tsc` binary but isn't listed in `typescript`'s own `package.json` `exports` map, so
  `import("typescript/lib/getExePath.js")` is rejected outright. `resolveDevBinary` (`binary.ts`)
  resolves the exported `typescript/package.json` instead, derives the sibling file's absolute path,
  and imports *that* — subpath restrictions only gate bare-specifier resolution, not a direct
  `file://` import.
- **`getExePath.js` cannot run inside a `bun build --compile` binary.** It resolves its own
  `package.json` relative to `import.meta.url`, which Bun rewrites to a virtual `file:///$bunfs/...`
  path with nothing on disk beside it, and calls `import.meta.resolve` on a specifier computed at
  runtime — nothing for the bundler to embed. `resolveTsLspBinary` detects compiled mode by checking
  whether `import.meta.url` starts with `file:///$bunfs/` (verified empirically: `process.execPath`,
  unlike `import.meta.url`/`import.meta.dir`, still returns the real on-disk path when compiled) and
  in that case looks under the packaged app's bundled `Contents/Resources/ts-lsp/` directory instead
  (`process.execPath` is `Contents/MacOS/sidecar`, so `resolveCompiledBinary` walks up to `Contents/`
  and back down). That directory is built by `apps/desktop/scripts/build-lsp-binary.ts`
  (`bun run build:lsp`) — a plain copy of the platform `tsc` binary (nothing to `bun build --compile`,
  it's already a native executable) plus its `lib.*.d.ts` files (next bullet) — and staged into the
  bundle by `tauri.build.conf.json`'s `bundle.macOS.files`, **not** `externalBin`. `NISI_TS_LSP_BIN`
  bypasses both strategies.
- **The TS7 binary needs its `lib.*.d.ts` files as direct siblings on disk, not just its own
  executable — and that rules out Tauri's `externalBin` mechanism entirely.** Discovered empirically:
  copying only the `tsc`/platform binary produces `panic: bundled: .../lib.d.ts does not exist; this
  executable may be misplaced` on startup — it resolves `dirname(os.Executable())` and looks for the
  ~110 `lib.*.d.ts` declaration files there directly, with no `CWD` or `../Resources` fallback tried.
  `externalBin` (how `sidecar`/`nisi-cli` ship) only stages a single file, always into
  `Contents/MacOS/` — and a second empirical finding rules that directory out even if it didn't:
  `codesign` treats every file under `Contents/MacOS/` as a nested code object requiring its own
  signature, so a plain-text `.d.ts` file dropped there breaks signing the *whole app*
  (`... code object is not signed at all / In subcomponent: .../Contents/MacOS/lib.es2015.core.d.ts`,
  reproduced against a real `tauri build`). The fix is to keep the binary and its `.d.ts` files
  together in one directory and stage that whole directory under `Contents/Resources/ts-lsp/` instead,
  via `bundle.macOS.files: { "Resources/ts-lsp": "binaries/ts-lsp" }` — `codesign` treats `Resources/`
  as ordinary bundle content, not nested code, and still finds and properly signs the nested `ts-lsp`
  executable inside it. Don't split the binary onto `externalBin` and the `.d.ts` files onto
  `bundle.macOS.files` separately — that packages "successfully" and then panics on first spawn
  (Contents/MacOS split) or fails to codesign at all (both under Contents/MacOS).
- **The reviewed project does not need TypeScript installed at all, at any version.** The TS7 native
  binary is self-contained and never consults the queried project's own `typescript` package — this is
  strictly more available than a tool that resolves the reviewed repo's own toolchain. Don't gate
  anything in this package on the queried project's TypeScript version or on its `node_modules` being
  present.
- **The stdin/stdout pump fibers are `forkScoped`, and graceful shutdown writes straight to
  `handle.stdin` rather than through the outbound queue.** Routing the `shutdown`/`exit` frames
  through the same queue the pump fiber drains would race scope teardown: forked-fiber interruption
  and the `Effect.acquireRelease` finalizer aren't ordered against each other, so the pump fiber could
  already be interrupted by the time the finalizer tries to enqueue. Writing directly to the sink
  sidesteps the ordering question instead of depending on it.
