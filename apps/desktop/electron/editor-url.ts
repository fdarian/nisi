/**
 * Characters left unescaped inside the `file/<path>` segment of an editor URL:
 * every RFC 3986 unreserved character plus `/`, since `path` is an absolute
 * filesystem path whose separators the receiving editor expects literally.
 * Everything else is percent-encoded byte by byte over UTF-8, uppercase hex.
 */
const PATH_SAFE = new Set(
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-_.~",
);

const encoder = new TextEncoder();

export function encodeEditorPath(path: string): string {
	let encoded = "";
	for (const byte of encoder.encode(path)) {
		const char = String.fromCharCode(byte);
		encoded +=
			byte < 0x80 && PATH_SAFE.has(char)
				? char
				: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return encoded;
}

export function editorUrl(scheme: string, path: string): string {
	return `${scheme}://file/${encodeEditorPath(path)}`;
}
