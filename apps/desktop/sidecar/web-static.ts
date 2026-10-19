import { statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const LONG_CACHE = "public, max-age=31536000, immutable";

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

/**
 * Serves the frontend bundle (`dist/`) to a plain browser. Paths with no file extension fall back
 * to `index.html` because the router uses history routes; a missing path that does have one (a
 * stale hashed asset) is a real 404, never the HTML shell.
 */
export function serveWebStatic(webDir: string, req: Request): Response {
	if (req.method !== "GET" && req.method !== "HEAD") {
		return new Response("method not allowed", {
			status: 405,
			headers: { allow: "GET, HEAD" },
		});
	}
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(req.url).pathname);
	} catch {
		return new Response("bad request", { status: 400 });
	}
	if (pathname.includes("\0")) {
		return new Response("bad request", { status: 400 });
	}
	const root = normalize(webDir);
	const requested = normalize(join(root, pathname));
	if (requested !== root && !requested.startsWith(root + sep)) {
		return new Response("forbidden", { status: 403 });
	}

	let file = requested;
	if (!isFile(file)) {
		if (extname(pathname) !== "") {
			return new Response("not found", { status: 404 });
		}
		file = join(root, "index.html");
		if (!isFile(file)) return new Response("not found", { status: 404 });
	}

	const body = Bun.file(file);
	const headers = new Headers({
		"content-type": body.type,
		"cache-control": file.startsWith(join(root, "assets") + sep)
			? LONG_CACHE
			: "no-cache",
	});
	if (req.method === "HEAD") {
		headers.set("content-length", String(body.size));
		return new Response(null, { headers });
	}
	return new Response(body, { headers });
}
