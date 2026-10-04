import type { Context } from "@orpc/server";
import { COMMON_ERROR_STATUS_MAP, ORPCError } from "@orpc/server";
import type {
	StandardHandlerOptions,
	StandardHandlerPlugin,
} from "@orpc/server/standard";
import { onAsyncIteratorObjectError, onError, toArray } from "@orpc/shared";

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

type ErrorLog = (error: unknown, path: readonly string[]) => Promise<void>;
const errorStatusMap: Readonly<Record<string, number>> =
	COMMON_ERROR_STATUS_MAP;

export class RpcErrorsPlugin<T extends Context>
	implements StandardHandlerPlugin<T>
{
	readonly name = "nisi/rpc-errors";

	constructor(private readonly log: ErrorLog) {}

	init(options: StandardHandlerOptions<T>): StandardHandlerOptions<T> {
		const handleError = async (error: unknown, path: readonly string[]) => {
			// oRPC v2 keeps status on the codec's map, not ORPCError; unmapped codes default to 500.
			if (error instanceof ORPCError) {
				const status = errorStatusMap[error.code];
				if (status !== undefined && status < 500) return;
			}
			await this.log(error, path);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: errorMessage(error),
				cause: error,
			});
		};
		return {
			...options,
			clientInterceptors: [
				onError((error, call) => handleError(error, call.path)),
				onAsyncIteratorObjectError((error, call) =>
					handleError(error, call.path),
				),
				...toArray(options.clientInterceptors),
			],
		};
	}
}
