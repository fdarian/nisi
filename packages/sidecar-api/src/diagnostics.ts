import { oc } from "@orpc/contract";
import { Schema } from "effect";

export const diagnosticsContract = {
	launchMarks: oc
		.input(
			Schema.Struct({
				traceId: Schema.String,
				marks: Schema.Array(
					Schema.Struct({
						at: Schema.Number,
						name: Schema.String,
						tab: Schema.optional(Schema.String),
						hidden: Schema.optional(Schema.Boolean),
					}),
				),
			}),
		)
		.output(Schema.Void),
};
