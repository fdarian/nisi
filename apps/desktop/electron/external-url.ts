const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

const NOTIFICATION_SETTINGS_URL =
	"x-apple.systempreferences:com.apple.Notifications-Settings.extension";

export function isHttpUrl(url: string): boolean {
	const protocol = URL.parse(url)?.protocol;
	return protocol === "http:" || protocol === "https:";
}

/** Mirrors the former `opener:allow-open-url` capability: the web/mail/tel schemes plus exactly the Notifications settings pane. */
export function isOpenUrlAllowed(url: string): boolean {
	if (url === NOTIFICATION_SETTINGS_URL) {
		return true;
	}
	const parsed = URL.parse(url);
	return parsed !== null && OPENABLE_PROTOCOLS.has(parsed.protocol);
}
