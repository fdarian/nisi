import { oc } from "@orpc/contract";
import { Schema } from "effect";

/** Proves the frontend reached a live sidecar over the authed oRPC channel. */
export const Health = Schema.Struct({
	status: Schema.Literal("ok"),
});
export type Health = Schema.Schema.Type<typeof Health>;

export const healthContract = {
	check: oc.output(Health),
};
