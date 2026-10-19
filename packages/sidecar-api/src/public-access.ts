import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * Whether the sidecar is reachable through a public tunnel, driven by
 * `Settings.publicAccessEnabled`. `link` is the full capability link —
 * tunnel URL plus the sidecar token in the fragment — so anyone holding it
 * has the same access the app window has. A restart mints a new token and a
 * new tunnel URL, which invalidates it. `error` is terminal until the switch
 * is toggled again: a tunnel that exits on its own is not restarted.
 */
export const PublicAccessStatus = Schema.Union([
	Schema.Struct({ type: Schema.Literal("off") }),
	Schema.Struct({ type: Schema.Literal("starting") }),
	Schema.Struct({ type: Schema.Literal("on"), link: Schema.String }),
	Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type PublicAccessStatus = Schema.Schema.Type<typeof PublicAccessStatus>;

export const publicAccessContract = {
	/** An in-memory read; a change is announced by the `public-access-changed` event. */
	status: oc.output(PublicAccessStatus),
};
