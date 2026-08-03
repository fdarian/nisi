---
type: Decision
title: The @ai-sdk/harness-pi model resolver patch — why, the trap, and when to drop it
description: nisi's Pi model ids are provider-scoped ("xai/grok-4.3"); harness-pi's own resolver isn't — and the obvious fix breaks in a way that only shows up once a real user picks a real model.
tags: [walkthrough, harness, pi, patches]
status: stable
generated: { by: claude-code/claude-sonnet-5, at: 2026-08-03T04:40:00Z }
---

# Why the patch exists

`apps/desktop/sidecar/walkthrough/model-discovery.ts`'s `discoverPiModels` mints compound model ids,
`"<provider>/<id>"`, for every Pi model nisi's picker offers. `@ai-sdk/harness-pi`'s own
`createPiModelResolver` (`src/pi-model-resolver.ts`, compiled into `dist/index.js`) only ever did
flat equality against a catalog entry's bare `id`/`name` — it never split a compound id into
`provider` + `id` before matching. So every Pi model nisi's own picker offered was, by construction,
unresolvable by the harness that had to run it: the resolver silently returned `undefined`, and
`@earendil-works/pi-coding-agent` fell back to its own hardcoded `defaultModelPerProvider` table,
whose iteration order puts `vercel-ai-gateway` before `xai` — producing a misleading "No API key
found for vercel-ai-gateway" no matter which real provider the user actually picked.

Pi's own CLI already solves this. `resolveCliModel` in
`@earendil-works/pi-coding-agent/dist/core/model-resolver.js` splits on the first `/` and, if the
prefix case-insensitively matches a known provider, resolves within that provider's models first.
`@ai-sdk/harness-pi`'s adapter never reused that logic — it built its own resolver from scratch and
only ever compared the whole string flat.

# The trap: gateway/router proxy entries mirror another provider's id

The straightforward fix — split on `/`, look up the provider, match the remainder against that
provider's models — has a landmine: Pi's catalog (`@earendil-works/pi-ai`) has `vercel-ai-gateway`
and `openrouter` entries whose own `id` field is *itself* a compound string that mirrors another
provider's compound id verbatim. A `vercel-ai-gateway`-provider entry can have
`id: "xai/grok-4.3"` — the exact same string a scoped, provider-aware match produces for the real
`xai` model. `DEFAULT_PI_GATEWAY_MODEL_ID` (`'anthropic/claude-sonnet-4.6'`, the fallback used when
no model is configured but gateway credentials are present) relies on this same shape to find its
gateway-routed default.

That collision breaks both naive fixes:

- **OR the scoped check into the same flat-equality predicate, one `models.find()` over the whole
  ~1120-entry catalog:** which of the two matching entries (the real `xai` one, or the
  `vercel-ai-gateway` proxy) wins now depends on **array order** — undefined from the caller's
  perspective. This shipped once and passed review-by-reading; it only broke once a real user picked
  `"xai/grok-4.3"` and Pi dispatched through the gateway instead.
- **Replace the flat match with a scoped-only match whenever a provider prefix resolves:** breaks
  `DEFAULT_PI_GATEWAY_MODEL_ID`. Its prefix, `"anthropic"`, *is* a real, directly-authenticatable
  provider — but that provider's own catalog entries use dash-cased ids (`"claude-sonnet-4-6"`) and
  spaced display names (`"Claude Sonnet 4.6"`), never the dot-cased compound string. A scoped-only
  match finds nothing under `"anthropic"` and gives up, when the correct answer was the
  `vercel-ai-gateway` entry whose *literal* `id` is the full compound string.

Both failure modes throw the exact same misleading error from the exact same place:
`@earendil-works/pi-coding-agent/dist/core/agent-session.js`'s `prompt()`, on a
`hasConfiguredAuth(this.model.provider)` check — nowhere near the resolver, and only once the user
actually sends a message, not when the session opens. That's what makes this expensive to diagnose
by reading alone: the resolver's logic looks locally correct in isolation; the wrongness only shows
up in *which* catalog entry a `.find()` happens to land on first.

**The fix that holds:** ordered priority tiers, not one predicate. Try
`scopedProvider != null && models.find(scopedMatches)` first, as its own step — deterministic
regardless of catalog array order. Only if that finds nothing does resolution fall through to the
gateway-preference tier, then the flat-literal tier. This keeps `DEFAULT_PI_GATEWAY_MODEL_ID` working
(its scoped tier legitimately finds nothing, so it falls through to the literal match) while making
an explicit `<provider>/<id>` pick always resolve within that provider first.

# `dist/` is what loads, not `src/`

`@ai-sdk/harness-pi`'s `package.json` `exports["."]` points at `dist/index.js`; there's no
`source`/`bun` export condition, so Bun resolves the compiled output. Patching `src/pi-model-resolver.ts`
alone changes nothing at runtime — the patch must cover both files, and verifying it means reading
the patched `dist/index.js` under `node_modules`, not just the `src/` copy.

# When to drop this patch

Drop it once upstream `@ai-sdk/harness-pi`'s `createPiModelResolver` is provider-aware on its own.
**Don't trust the version number to tell you that.** As of `1.0.54` the resolver is byte-for-byte
unchanged from `1.0.46` — every version bump in between happened only because `@ai-sdk/harness`
itself republished; that package's own `CHANGELOG.md` for those versions reads "Updated dependencies
— `@ai-sdk/harness@x.y.z`" and nothing else. Checking whether it's safe to drop means diffing the
actual `createPiModelResolver` body in the new version's `dist/index.js` against
`patches/@ai-sdk%2Fharness-pi@<current-version>.patch`'s pre-patch side — not reading a changelog,
and not checking whether the version number moved.
