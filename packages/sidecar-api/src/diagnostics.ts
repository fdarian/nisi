import { oc } from "@orpc/contract";
import { Schema } from "effect";
import { LaunchMark } from "./launch-record.ts";

export const diagnosticsContract = {
	injectDeepLink: oc
		.errors({ FORBIDDEN: {}, BAD_REQUEST: {} })
		.input(Schema.Struct({ url: Schema.String, traceId: Schema.String }))
		.output(Schema.Void),
	ackDeepLink: oc
		.errors({ FORBIDDEN: {} })
		.input(Schema.Struct({ traceId: Schema.String }))
		.output(Schema.Void),
	launchMarks: oc
		.input(
			Schema.Struct({
				traceId: Schema.String,
				marks: Schema.Array(LaunchMark),
			}),
		)
		.output(Schema.Void),
};
