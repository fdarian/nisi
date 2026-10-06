import type { LaunchMark } from "@repo/sidecar-api";
import { LaunchTrace } from "./service.ts";

export function* receiveFrontendMarks(call: {
	input: { traceId: string; marks: readonly LaunchMark[] };
}) {
	const trace = yield* LaunchTrace;
	yield* trace.frontend(call.input.traceId, call.input.marks);
}
