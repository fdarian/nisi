import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option, Tracer } from "effect";

type RecordBase = {
	source: "cli" | "sidecar" | "frontend";
	name: string;
	attrs: Record<string, unknown>;
};
export type LaunchRecord = RecordBase &
	(
		| {
				type: "span";
				start: number;
				end: number;
				spanId: string;
				parentSpanId?: string;
		  }
		| { type: "mark"; at: number; spanId?: string }
	);

export function launchTracePath(dataDir: string, id: string): string {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
		throw new Error("Invalid launch trace ID");
	return join(dataDir, "logs", "launch-traces", `${id}.jsonl`);
}

export const makeLaunchTracer = (options: {
	dataDir: string;
	source: "cli" | "sidecar";
}) =>
	Effect.gen(function* () {
		const native = yield* Effect.tracer;
		const context = yield* Effect.context<never>();
		const state: {
			active?: { id: string; deadline: number };
			activated: boolean;
		} = { activated: false };
		const bootIds = new Set<string>();
		const boot: LaunchRecord[] = [];
		const activeId = () => {
			if (state.active !== undefined && Date.now() >= state.active.deadline)
				state.active = undefined;
			return state.active?.id;
		};
		const write = (id: string, records: readonly LaunchRecord[]) =>
			Effect.try(() => {
				const file = launchTracePath(options.dataDir, id);
				mkdirSync(join(options.dataDir, "logs", "launch-traces"), {
					recursive: true,
				});
				// One O_APPEND write keeps records from the CLI and sidecar from interleaving.
				appendFileSync(
					file,
					`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
				);
			}).pipe(
				Effect.catch((error) =>
					Effect.logWarning("Launch trace write failed", {
						traceId: id,
						error,
					}),
				),
			);
		const emit = (
			record: LaunchRecord,
			id: string | undefined,
			isBoot: boolean,
		) => {
			const current = activeId();
			if (current !== undefined && (id === undefined || id === current)) {
				Effect.runSync(Effect.provide(write(current, [record]), context));
			} else if (isBoot && !state.activated) boot.push(record);
		};
		const tracer = Tracer.make({
			span(spanOptions) {
				const span = native.span(spanOptions);
				const start = Date.now();
				const id = activeId();
				const parent = Option.getOrUndefined(span.parent);
				const isBoot =
					span.name === "sidecar.boot" ||
					(parent !== undefined && bootIds.has(parent.spanId));
				if (isBoot) bootIds.add(span.spanId);
				const end = span.end.bind(span);
				span.end = (time, exit) => {
					if (span.status._tag === "Ended") return;
					const wallEnd = Date.now();
					end(time, exit);
					emit(
						{
							type: "span",
							source: options.source,
							name: span.name,
							start,
							end: wallEnd,
							spanId: span.spanId,
							...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
							attrs: Object.fromEntries(span.attributes),
						},
						id,
						isBoot,
					);
				};
				const event = span.event.bind(span);
				span.event = (name, time, attrs = {}) => {
					event(name, time, attrs);
					emit(
						{
							type: "mark",
							source: options.source,
							name,
							at: Date.now(),
							spanId: span.spanId,
							attrs,
						},
						id,
						isBoot,
					);
				};
				return span;
			},
			context: native.context,
		});
		return {
			tracer,
			activeId,
			activate: (id: string | undefined) =>
				Effect.gen(function* () {
					if (id === undefined || activeId() === id) return;
					state.active = { id, deadline: Date.now() + 60_000 };
					state.activated = true;
					const records = boot.splice(0);
					if (records.length > 0) yield* write(id, records);
				}),
			deactivate: () =>
				Effect.sync(() => {
					state.active = undefined;
				}),
			append: (id: string, records: readonly LaunchRecord[]) =>
				Effect.suspend(() =>
					activeId() === id && records.length > 0
						? write(id, records)
						: Effect.void,
				),
		};
	});
