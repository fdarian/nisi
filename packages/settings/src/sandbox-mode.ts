/**
 * Where a harness agent runs. Its own file, with no imports, so the wire
 * contract (and through it the frontend) can take the value list without
 * pulling in the SQLite-backed store.
 *
 * Adding a backend starts here; the full checklist is in
 * `apps/desktop/sidecar/harness/AGENTS.md`.
 */
export const SANDBOX_MODES = ["local"] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];
