# @repo/sidecar-api

Contract-first oRPC v2 contract for the desktop sidecar's wire API — the single source of truth shared
by the sidecar (implementer, [`@repo/desktop`](../../apps/desktop/AGENTS.md)) and its frontend client.
One procedure today: `health.check`, proving the frontend can reach a live, authed sidecar.

- `health.ts` — schema + procedure contract, following the per-domain-module pattern
  (`packages/sidecar-api/src/<domain>.ts`) later phases will add more of.
- `contract.ts` — composes domain contracts into the router; owns the two
  `@orpc/experimental-effect/extensions/*` side-effect imports. These **must** run before any domain
  module calls `oc.input()`/`oc.output()` — every domain module is imported only from here, never
  directly, which `package.json`'s narrow `exports` map (`"." -> "./src/index.ts"`) enforces from
  outside this package.
- `client.ts` — `makeSidecarClient({ port, token })`, a typed `RouterContractClient`.

## Gotchas
- `effect` here is the `beta` dist-tag (`4.0.0-beta.x`) — `latest` on npm is still v3. Pinned exact,
  not `^`.
