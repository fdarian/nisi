export type MenuEvent = "close-tab" | "open-settings";

export interface NativeApi {
	getBackend(): Promise<{ port: number; token: string }>;
	listAvailableEditors(): Promise<Array<{ id: string; name: string }>>;
	openInEditor(target: {
		scheme: string;
		repoRoot: string;
		path: string;
	}): Promise<void>;
	pickFolder(title: string): Promise<string | null>;
	sendNotification(notification: {
		title: string;
		body: string;
	}): Promise<void>;
	openUrl(url: string): Promise<void>;
	revealInFinder(path: string): Promise<void>;
	homeDir(): Promise<string>;
	exit(): Promise<void>; // app.exit(0); used by the update pill after restart()
	closeWindow(): void;
	onMenu(event: MenuEvent, listener: () => void): () => void;
	takePendingDeepLinks(): Promise<string[]>;
	onDeepLink(listener: (url: string) => void): () => void;
}
