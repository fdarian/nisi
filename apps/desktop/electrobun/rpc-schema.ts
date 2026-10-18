import type { RPCSchema } from "electrobun/view";
import type { MenuEvent } from "../electron/native-api";

/**
 * The wire contract between the Bun main process and `bridge.ts`. Requests are
 * `NativeApi`'s promise methods, one-for-one; the only difference is that a
 * primitive-argument method takes a single object, since RPC params travel as
 * one value.
 */
export type NisiRpc = {
	bun: RPCSchema<{
		requests: {
			getBackend: {
				params: undefined;
				response: { port: number; token: string };
			};
			listAvailableEditors: {
				params: undefined;
				response: Array<{ id: string; name: string }>;
			};
			openInEditor: {
				params: { scheme: string; repoRoot: string; path: string };
				response: undefined;
			};
			pickFolder: { params: { title: string }; response: string | null };
			sendNotification: {
				params: { title: string; body: string };
				response: undefined;
			};
			openUrl: { params: { url: string }; response: undefined };
			revealInFinder: { params: { path: string }; response: undefined };
			homeDir: { params: undefined; response: string };
			exit: { params: undefined; response: undefined };
			takePendingDeepLinks: { params: undefined; response: string[] };
		};
		messages: { closeWindow: undefined };
	}>;
	webview: RPCSchema<{
		requests: Record<never, never>;
		messages: { menu: MenuEvent; deepLink: string };
	}>;
};

type BunRequests = NisiRpc["bun"]["requests"];

export type NisiRequestHandlers = {
	[K in keyof BunRequests]: (
		params: BunRequests[K]["params"],
	) => BunRequests[K]["response"] | Promise<BunRequests[K]["response"]>;
};
