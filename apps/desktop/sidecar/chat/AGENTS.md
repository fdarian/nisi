# sidecar/chat

Wires `packages/sidecar-api`'s `chat` contract to a read-only `HarnessAgent` conversation per
thread. Reuses `sidecar/harness`'s adapter/sandbox/inactive-tools plumbing — nothing here builds a
harness adapter itself. Unlike `sidecar/walkthrough`, a thread's answer is AI SDK's own
`UIMessageChunk` stream forwarded as-is, not a structured document validated turn by turn, so
there's no coverage loop, no persistence, and no reattach/pub-sub: `http.ts`'s `chat.send` handler
drives one turn directly against the request's own connection.

- `context.ts` — `resolveChatPromptContext`: `sessionId` → the live, worktree-relocation-healed
  `repoRoot` (`Store.resolveSessionRepoRoot`) plus enough of the review session (`baseRef`/`headRef`/
  `pr`) to name in the system prompt. Throws `ChatSessionNotFound` for an unknown `sessionId`, same
  treatment `http.ts` gives `walkthrough.generate`'s `GenerateSessionNotFound`.
- `prompt.ts` — `buildChatInstructions`: deliberately thin. Names the repo/branch/PR under review and
  tells the agent its tools are read-only — nothing else. The agent has the same `bash`/`read`/`grep`/
  `glob` builtins walkthrough's does and can explore the worktree itself, so this never grows into a
  second `gatherGenerationContext` diff briefing.
- `sessions.ts` — `getOrCreateChatSession`/`closeChatThread`/`closeChatThreadsForSession`: an
  in-process `Map<threadId, ThreadEntry>` plus a `Map<sessionId, Set<threadId>>` reverse index.
  Keyed by `threadId`, not `sessionId` — one review session can host several concurrent chat
  threads, each its own `HarnessAgent` conversation — but every thread still records the
  `sessionId` (PR tab) it's scoped to, since **chat threads are scoped per PR tab**: closing a tab
  must dispose every thread it owns, or that thread's harness subprocess/sandbox leaks for the rest
  of the sidecar's lifetime. `http.ts`'s `sessions.close` handler calls `closeChatThreadsForSession`
  the same way it already stops `walkthrough`'s live session. A thread's `pending` field is the
  in-flight construction *promise*, not the resolved session, so two `chat.send` calls racing on a
  brand-new thread both await the same construction instead of each starting (and leaking) their own
  sandbox. Gone on sidecar restart, same posture as `walkthrough/live-sessions.ts` — chat threads are
  ephemeral by design (`packages/sidecar-api/src/chat.ts`'s doc), no stored fallback to reattach to.
- `stream.ts` — `streamChatTurn`: runs one turn and forwards `agent.stream()`'s own
  `toUIMessageStream()` output verbatim — `@ai-sdk/harness`'s `HarnessStreamTextResult` (what
  `HarnessAgent.stream()` actually resolves to) implements this directly, so there's no hand-rolled
  `fullStream` projection the way `walkthrough/generate.ts`'s turn loop has one. See the function's
  own doc for which of that result type's other stream-exit methods throw `notSupportedYet`.

## Non-obvious decisions

- **No `chat.stop` procedure.** `chat.send`'s handler passes oRPC's own request `signal` straight
  into `agent.stream({ abortSignal })` — a client disconnect (the chat popup closing mid-stream, a
  dropped connection) aborts the in-flight turn on its own, so there's nothing a separate cancel
  procedure would add for a turn this short-lived.
- **`harness`/`model` only matter for a thread's first `chat.send`.** Once a thread's session is
  live, `getOrCreateChatSession` reuses it and ignores whatever `harness`/`model` a later call
  supplies — same reattach posture as `walkthrough.generate`'s "whatever's already running wins."
- **`closeChatThread` tolerates a construction that never resolved.** A thread whose
  `agent.createSession()` is still in flight (or failed) when it's disposed has nothing live to
  stop — `entry.pending.catch(() => undefined)` drops that case rather than letting it reject the
  caller, which matters for `closeChatThreadsForSession`: one broken thread must not stop
  `sessions.close` from disposing the rest, or from succeeding at all.
- **`chat.send`'s wire payload is untyped on purpose.** `packages/sidecar-api/src/chat.ts`'s
  `ChatStreamChunk` is `Schema.Unknown` — AI SDK's `UIMessageChunk` protocol passed through as
  opaque JSON rather than transcribed into Effect Schema, since a hand-maintained copy would drift
  on every `ai` bump. `stream.ts` doesn't need `sidecar/harness`'s `describeStreamError` the way
  `walkthrough/generate.ts` does: `toUIMessageStream()` already turns an in-stream transport
  failure into its own `{ type: "error" }` chunk, so there's no `fullStream` `error` part for chat
  to interpret by hand anymore.
