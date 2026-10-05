import { Config, Effect } from "effect";
import { emit } from "./events.ts";

export const measurementInstance = Config.string(
	"NISI_MEASUREMENT_INSTANCE",
).pipe(
	Config.withDefault("0"),
	Effect.map((value) => value === "1"),
);

export function createInjectedDeepLinks() {
	const pending = new Map<
		string,
		{ type: "deep-link-injected"; url: string; traceId: string; seq: number }
	>();
	return {
		inject: (url: string, traceId: string) => {
			if (pending.has(traceId)) return;
			if (pending.size >= 100)
				throw new Error("Too many unacknowledged measurement deep links");
			const event = emit({ type: "deep-link-injected", url, traceId });
			pending.set(traceId, {
				...event,
				type: "deep-link-injected",
				url,
				traceId,
			});
		},
		list: () => [...pending.values()],
		ack: (traceId: string) => {
			pending.delete(traceId);
		},
	};
}

export const injectedDeepLinks = createInjectedDeepLinks();
