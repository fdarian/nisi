import { oc } from "@orpc/contract";
import { Schema } from "effect";
import { LaunchMark } from "./launch-record.ts";

export const diagnosticsContract = {
	launchMarks: oc
		.input(
			Schema.Struct({
				traceId: Schema.String,
				marks: Schema.Array(LaunchMark),
			}),
		)
		.output(Schema.Void),
};
