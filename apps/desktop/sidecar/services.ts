import type { BunServices } from "@effect/platform-bun";
import type { ReviewStore } from "@repo/review";
import type { RepoMergeMethodStore, SettingsStore } from "@repo/settings";
import type { ChatSessions } from "./chat/sessions.ts";
import type { HarnessModelCache } from "./harness/model-store.ts";
import type { SessionWatch } from "./session-watch.ts";
import type { Store } from "./store.ts";
import type { Updater } from "./updater/service.ts";
import type { WalkthroughStore } from "./walkthrough/store.ts";

/**
 * Every service the sidecar's `mainContext` (captured once at boot, see
 * `index.ts`) carries. One shared alias so `http.ts` and the walkthrough
 * generation loop (which bridges Effect from a plain `async function*`
 * handler, not a `.effect()` one) type their `mainContext` parameter
 * identically instead of each hand-rolling the union.
 */
export type AppServices =
	| Store
	| ReviewStore
	| WalkthroughStore
	| SettingsStore
	| RepoMergeMethodStore
	| SessionWatch
	| Updater
	| ChatSessions
	| HarnessModelCache
	| BunServices.BunServices;
