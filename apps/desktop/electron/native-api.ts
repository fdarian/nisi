export type MenuEvent = "close-tab" | "open-settings";

export type ThemeSource = "light" | "dark" | "system";

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
	/** `app.exit(0)`; used by the update pill after `restart()`. */
	exit(): Promise<void>;
	closeWindow(): void;
	/** Resolves whether the calling window now shows glass, which is when its frame should be transparent. */
	setWindowGlass(enabled: boolean): Promise<boolean>;
	/** Pins the native appearance, so glass follows the app's own light/dark choice rather than the system's. */
	setThemeSource(source: ThemeSource): Promise<void>;
	onMenu(event: MenuEvent, listener: () => void): () => void;
	takePendingDeepLinks(): Promise<string[]>;
	onDeepLink(listener: (url: string) => void): () => void;
}
