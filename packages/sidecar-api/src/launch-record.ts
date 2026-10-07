import { Schema } from "effect";

const fields = {
	source: Schema.Literals(["cli", "sidecar", "frontend"]),
	name: Schema.String,
	attrs: Schema.Record(Schema.String, Schema.Unknown),
};
export const LaunchMark = Schema.Struct({
	type: Schema.Literal("mark"),
	...fields,
	at: Schema.Number,
	spanId: Schema.optional(Schema.String),
});
export type LaunchMark = Schema.Schema.Type<typeof LaunchMark>;
export const LaunchRecord = Schema.Union([
	LaunchMark,
	Schema.Struct({
		type: Schema.Literal("span"),
		...fields,
		start: Schema.Number,
		end: Schema.Number,
		spanId: Schema.String,
		parentSpanId: Schema.optional(Schema.String),
	}),
]);
export type LaunchRecord = Schema.Schema.Type<typeof LaunchRecord>;
