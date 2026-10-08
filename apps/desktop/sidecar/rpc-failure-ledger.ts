import { ORPCError } from "@orpc/server";
import { Clock, Context, Effect, Layer, Ref } from "effect";
import { errorMessage } from "./rpc-errors.ts";

export type RpcFailureRecord = {
	readonly path: string;
	readonly errorTag: string;
	readonly count: number;
	readonly firstAt: number;
	readonly lastAt: number;
	readonly lastMessage: string;
};

const MAX_ENTRIES = 100;
const MAX_MESSAGE_LENGTH = 500;

/**
 * A short, stable label for grouping failures: an Effect tagged error's
 * `_tag`, an `ORPCError`'s `code`, otherwise the JS error's `name`.
 */
export const errorTagOf = (error: unknown): string => {
	if (typeof error === "object" && error !== null && "_tag" in error) {
		if (typeof error._tag === "string") return error._tag;
	}
	if (error instanceof ORPCError) return error.code;
	if (error instanceof Error) return error.name;
	return typeof error;
};

/** Effect tagged errors carry their detail in fields and leave `message` empty. */
const describeError = (error: unknown): string => {
	const message = errorMessage(error);
	if (message !== "") return message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
};

/**
 * Counts every failure `RpcErrorsPlugin` logs as "rpc call failed", grouped by
 * RPC path and error tag, so `diagnostics.snapshot` can show a recurring
 * failure without grepping the log. In-memory and bounded; a restart clears it.
 */
export class RpcFailureLedger extends Context.Service<RpcFailureLedger>()(
	"sidecar/rpc-failure-ledger",
	{
		make: Effect.gen(function* () {
			const entries = yield* Ref.make<ReadonlyMap<string, RpcFailureRecord>>(
				new Map(),
			);
			const record = (path: readonly string[], error: unknown) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					const joinedPath = path.join(".");
					const errorTag = errorTagOf(error);
					const lastMessage = describeError(error).slice(0, MAX_MESSAGE_LENGTH);
					yield* Ref.update(entries, (current) => {
						const key = `${joinedPath}\0${errorTag}`;
						const previous = current.get(key);
						const next = new Map(current);
						// Delete first so a repeat moves to the back; the
						// least-recently-failing pair is what gets evicted.
						next.delete(key);
						next.set(key, {
							path: joinedPath,
							errorTag,
							count: previous === undefined ? 1 : previous.count + 1,
							firstAt: previous === undefined ? now : previous.firstAt,
							lastAt: now,
							lastMessage,
						});
						const oldest = next.keys().next();
						if (next.size > MAX_ENTRIES && oldest.done !== true)
							next.delete(oldest.value);
						return next;
					});
				});
			const list = Ref.get(entries).pipe(
				Effect.map((current) => Array.from(current.values())),
			);
			return { record, list };
		}),
	},
) {
	static layer = Layer.effect(RpcFailureLedger, RpcFailureLedger.make);
}
