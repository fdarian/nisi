import { hasNative, native } from "./native";

/** The system browser inside the desktop shell, a new tab in a plain browser. */
export async function openUrl(url: string): Promise<void> {
	if (hasNative()) return native().openUrl(url);
	window.open(url, "_blank", "noopener");
}
