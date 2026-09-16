# @repo/code-lsp

A JSON-RPC-over-stdio client for TypeScript 7's native LSP server (`<tsc> --lsp --stdio`) —
`references`, `definition`, `hover`, and `semanticTokens/full` against a live process, no index
built or query data cached anywhere. One server process per repository/worktree root:
`spawnLspServer(rootPath, cacheDir)` spawns, completes `initialize`/`initialized`, and returns an
`LspServer` scoped to the caller's `Scope` — the process (and its stdio pump fibers) dies when that
scope closes. The package receives the cache directory as a parameter and has no oRPC, SQLite, or
app-config dependency.

Queries read files straight off disk by default. `openDocument(path, text)` is available when a
caller needs deterministic TypeScript project loading: its first call sends `textDocument/didOpen`,
and later calls send a full `textDocument/didChange` with the current text.

## Public API

- `spawnLspServer(rootPath, cacheDir): Effect<LspServer, TsLspBinaryResolutionError | LspProcessError, Scope | ChildProcessSpawner | FileSystem>`
  — the only constructor. `LspServer` exposes `openDocument(path, text)`,
  `semanticTokensFull(path)`, `references(path, position)`, `definition(path, position)`, and
  `hover(path, position)`. Query methods return `Effect<_, LspRequestError | LspProtocolError>`;
  `openDocument` is a notification and returns `Effect<void>`. Every path in and out is a plain
  filesystem path — `file://` URIs never leak into or out of this API.
- `resolveTsLspBinary(rootPath, cacheDir)` (`src/binary.ts`) — resolves the absolute path to the
  platform `tsc` binary.
  Exported mainly so a caller can check it independently of spawning.

## File map

- `src/protocol.ts` — pure wire-level pieces: `Content-Length` frame codec (`encodeFrame`/
  `decodeFrames`), classifying a decoded message (`classifyMessage`), the server-request
  auto-responder (`autoResponderResult`), and decoding the LSP result shapes the four queries
  consume (`decodeLocations`, `decodeHover`) plus `pathToUri`/`uriToPath`.
- `src/semantic-tokens.ts` — `decodeSemanticTokens`: the delta-encoding decode against a negotiated
  legend.
- `src/binary.ts` — root-aware `resolveTsLspBinary`, including the environment override and
  worktree-local TypeScript 7 check.
- `src/ts-lsp-download.ts` — the pinned platform release map, SHA-512 verification, atomic cache
  install, and process-wide single-flight for concurrent worktree starts.
- `src/client.ts` — the process lifecycle (spawn, wire the stdin/stdout pumps, `initialize`, graceful
  shutdown), document-open notifications, and the four query methods, composing everything above.
  The one file that touches `ChildProcessSpawner`.
- `src/errors.ts` — `TsLspBinaryResolutionError`, `LspProcessError`, `LspProtocolError`,
  `LspRequestError`.

## One repository root per server

`spawnLspServer` takes the repository/worktree root and the caller-owned TypeScript cache directory —
it does not pool or key servers itself. The sidecar passes the exact root already resolved by
`Store.resolveSessionRepoRoot`, computes `<data dir>/lsp/ts` from `@repo/db`, and owns the
capacity-bounded, lease-aware pool. A root server's project service can load projects from every
package in that worktree, so splitting by nearest `tsconfig.json` would make cross-package
references incomplete.

The root-server spike against this repository established the loading rule. `semanticTokensFull`
returned tokens for nested `packages/*`, `apps/desktop/src`, and `apps/desktop/sidecar` files without
`didOpen`. References were not stable on a cold server: `SettingsStore` returned 24 locations in 4
settings files; querying other packages first produced 32 locations in 6 files (and a narrower
three-file warm-up produced 8). Sending `openDocument` for the 11 relevant files before querying
returned 46 locations in 11 files, and opening those same files in reverse order returned the same
46 locations. The regression in `test/client.test.ts` pins that cross-package, order-independent
result rather than the old 24/4 project-local count.

This is how tsgo's project service is exposed through LSP: a document request/open causes its
project tree to load, while `references` searches the projects currently loaded by the
cross-project orchestrator. The LSP surface has no cheap "load every configured project" request;
the internal all-project-tree operation is intended for expensive operations such as file rename.
The sidecar therefore opens each queried worktree document before semantic-token and reference
work. As a reviewer visits more diff files, their projects are opened on the same root server; the
server's own empty result remains the answer for a file it cannot associate with a project (there is
no project-membership field in these LSP responses).

The same spike measured about 206 MiB RSS for a cold root server and about 773 MiB after those 11
documents were opened (the TypeScript automatic-acquisition helper was a separate child). The pool
keeps two roots live; see the sidecar state comment for the memory rationale.

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
- **Open documents are the project-loading signal.** `semanticTokensFull` can read a nested file from
  disk without an open notification, but cross-project `references` only sees project trees tsgo has
  loaded. Call `openDocument` with the current full text before a project-sensitive query; the client
  sends `didOpen` once per path and full-text `didChange` updates thereafter, with a small lock around
  notification ordering only. Query requests themselves remain concurrent.
- **TS7 binary resolution has a fixed order.** `NISI_TS_LSP_BIN` wins when it is non-empty. The next
  candidate is `<rootPath>/node_modules/typescript` only when its package version has major `7`, its
  own `lib/getExePath.js` resolves the current platform optional package, and the returned binary has
  sibling `.d.ts` declarations. The final candidate is the pinned cache at
  `<cacheDir>/7.0.2/`; a local TypeScript package without its native optional package falls through
  to this cache.
- **The pinned release lives in `src/ts-lsp-download.ts`.** It records TypeScript `7.0.2`, the npm
  platform package for every lockfile-supported platform, and each lockfile SHA-512 integrity value.
  The registry tarball is verified byte-for-byte before `tar` sees it. A missing platform entry is an
  explicit unsupported-platform failure.
- **The TS7 executable needs its sibling declaration files.** The cache installer extracts into a
  unique temporary directory and validates the executable plus `.d.ts` files under `package/lib`.
  The versioned cache keeps the executable and declarations together, and the final directory is
  populated by atomic rename. A process-wide single-flight map shares one install across different
  worktree roots.
- **Bump the pinned release deliberately.** Update `TS_LSP_VERSION`, replace every platform integrity
  value in `src/ts-lsp-download.ts` from the matching `pnpm-lock.yaml` entries, then run
  `test/ts-lsp-download.test.ts` and the package tests. That test discovers the lockfile, checks all
  20 first-resolution integrity entries, and fails if a package or lockfile is missing. Refresh
  `test/client.test.ts`'s populated cache fixture if the package layout changes.
- **The stdin/stdout pump fibers are `forkScoped`, and graceful shutdown writes straight to
  `handle.stdin` rather than through the outbound queue.** Routing the `shutdown`/`exit` frames
  through the same queue the pump fiber drains would race scope teardown: forked-fiber interruption
  and the `Effect.acquireRelease` finalizer aren't ordered against each other, so the pump fiber could
  already be interrupted by the time the finalizer tries to enqueue. Writing directly to the sink
  sidesteps the ordering question instead of depending on it.
