# sidecar/chat

Wires `packages/sidecar-api`'s `chat` contract to a `HarnessAgent` conversation per thread — a
normal conversation with the coding agent, with its full builtin tool set (write, edit, bash, all
of it), the same as a standalone `claude`/`codex`/`opencode` session would have. Reuses
`sidecar/harness`'s adapter/sandbox plumbing — nothing here builds a harness adapter itself, and
unlike `sidecar/walkthrough`, nothing here restricts one either (see `sessions.ts`'s
`startChatSession`). A thread's answer is AI SDK's own `UIMessageChunk` stream forwarded as-is, not
a structured document validated turn by turn, so there's no coverage loop, no persistence, and no
reattach/pub-sub: `http.ts`'s `chat.send` handler drives one turn directly against the request's
own connection.

- `context.ts` — `resolveChatPromptContext`: `sessionId` → the live, worktree-relocation-healed
  `repoRoot` (`Store.resolveSessionRepoRoot`) plus enough of the review session (`baseRef`/`headRef`/
  `pr`) to name in the system prompt. Throws `ChatSessionNotFound` for an unknown `sessionId`, same
  treatment `http.ts` gives `walkthrough.generate`'s `GenerateSessionNotFound`.
- `prompt.ts` — `buildChatInstructions`: deliberately thin. Names the repo/branch/PR under review,
  nothing else. The agent has its full tool set against the same real worktree and can look (or act)
  for itself, so this never grows into a second `gatherGenerationContext` diff briefing.
- `sessions.ts` — `ChatSessions`, a `Context.Service` holding the popup's live thread registry:
  `threadId -> ThreadEntry` plus a `sessionId -> Set<threadId>` reverse index, both `Map`s closed
  over inside the service rather than module-scope globals — wired into `AppServices`/`mainContext`
  via `index.ts`'s `MainLayer`, same as every other stateful sidecar service. Keyed by `threadId`,
  not `sessionId` — one review session can host several concurrent chat threads, each its own
  `HarnessAgent` conversation — but every thread still records the `sessionId` (PR tab) it's scoped
  to, since **chat threads are scoped per PR tab**: closing a tab must dispose every thread it owns,
  or that thread's harness subprocess/sandbox leaks for the rest of the sidecar's lifetime.
  `http.ts`'s `sessions.close` handler calls `closeChatThreadsForSession` the same way it already
  stops `walkthrough`'s live session. A thread's `pending` field is the in-flight construction
  *promise*, not the resolved session, so two `chat.send` calls racing on a brand-new thread both
  await the same construction instead of each starting (and leaking) their own sandbox. The three
  module-level `getOrCreateChatSession`/`closeChatThread`/`closeChatThreadsForSession` exports are
  the promise-returning bridge `chat.send`'s plain `async function*` handler calls — it can't
  `yield*` the service directly (see that handler's own comment in `http.ts`) — pulling
  `ChatSessions` out of the same captured `mainContext` every `.effect()` handler gets implicitly,
  the same bridge `context.ts`'s `resolveChatPromptContext` and `walkthrough/generate.ts` use. Gone
  on sidecar restart, same posture as `walkthrough/live-sessions.ts` — chat threads are ephemeral by
  design (`packages/sidecar-api/src/chat.ts`'s doc), no stored fallback to reattach to.
- `stream.ts` — `streamChatTurn`: runs one turn and forwards it as AI SDK's own `UIMessageChunk`
  stream — no hand-rolled `fullStream` projection the way `walkthrough/generate.ts`'s turn loop has
  one. Calls the *standalone* `toUIMessageStream({ stream, tools })` helper from `ai`, not
  `result`'s own (deprecated) instance method of the same name: the instance method always turns
  *every* `fullStream` `"error"` part into a visible chunk, including `sidecar/harness`'s
  `describeStreamError`-classified meaningless ones, and `onError` can't suppress a chunk, only its
  message. `filterMeaninglessStreamErrors` drops that part first, on the raw `TextStreamPart`
  stream, before AI SDK ever sees it. See the function's own doc for which of
  `HarnessStreamTextResult`'s other stream-exit methods throw `notSupportedYet`.

## Non-obvious decisions

- **Chat is not read-only, unlike walkthrough.** `sessions.ts`'s `startChatSession` builds its
  `HarnessAgent` with no `inactiveTools` — the point of chat is a normal conversation with the
  coding agent, capable of actually doing things, not just narrating a diff. Don't reach for
  `sidecar/harness`'s `FILE_MUTATING_BUILTINS` here by analogy with `walkthrough/generate.ts`; that
  constant stays walkthrough-only, since a generated walkthrough must never touch the worktree it's
  describing — chat has no such guarantee to keep.
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
  on every `ai` bump.
- **`stream.ts` reuses `sidecar/harness`'s `describeStreamError` for filtering, not describing.**
  Chat never reads a `fullStream` `error` part's message by hand the way `walkthrough/generate.ts`
  does — AI SDK's own `toUIMessageStream` already turns a real transport failure into its own
  `{ type: "error" }` chunk. What chat still needs from `describeStreamError` is its "is this error
  part meaningful at all" judgment, via `filterMeaninglessStreamErrors` — see `stream.ts`'s own
  doc.
