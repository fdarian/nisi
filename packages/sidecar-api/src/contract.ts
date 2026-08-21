// Side-effect imports that patch `@orpc/contract`'s `oc` builder and `@orpc/server`'s
// `os`/`ProcedureImplementer` so Effect `Schema` works natively in `.input()`/`.output()`
// and `.effect()` handler bodies are available. Must run before any domain contract
// module (which call `oc.input()`/`oc.output()` at module init) is evaluated — every
// domain module below is imported only from here, never directly by another module in
// this package, so this ordering is guaranteed regardless of import order elsewhere.
// `package.json`'s `exports` map (only `.` → `src/index.ts`) keeps outside consumers from
// deep-importing a domain module and hitting the builder before it's patched.
import "@orpc/experimental-effect/extensions/effect";
import "@orpc/experimental-effect/extensions/input-output";

import { oc } from "@orpc/contract";
import { diffContract } from "./diff.ts";
import { eventsContract } from "./events.ts";
import { healthContract } from "./health.ts";
import { pullRequestsContract } from "./pull-requests.ts";
import { reviewContract } from "./review.ts";
import { sessionsContract } from "./sessions.ts";
import { settingsContract } from "./settings.ts";
import { updateContract } from "./update.ts";
import { walkthroughContract } from "./walkthrough.ts";

export * from "./diff.ts";
export * from "./events.ts";
export * from "./health.ts";
export * from "./pull-requests.ts";
export * from "./review.ts";
export * from "./sessions.ts";
export * from "./settings.ts";
export * from "./update.ts";
export * from "./walkthrough.ts";

// `.errors()` here augments *every* procedure in the router below with UNAUTHORIZED,
// so the bearer-auth middleware (applied once, router-wide, in the sidecar's
// implementation) has a typed error to throw regardless of which procedure it guards.
export const contract = oc.errors({ UNAUTHORIZED: {} }).router({
	health: healthContract,
	sessions: sessionsContract,
	diff: diffContract,
	review: reviewContract,
	events: eventsContract,
	walkthrough: walkthroughContract,
	settings: settingsContract,
	pullRequests: pullRequestsContract,
	update: updateContract,
});
