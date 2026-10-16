import { statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

/** Must run before `app` is ready. */
export function registerAppScheme() {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: "app",
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				corsEnabled: true,
				stream: true,
			},
		},
	]);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Serves `dist/` at `app://nisi/`. Unknown paths fall back to `index.html`,
 * since TanStack router uses history routes and `/about` must load directly.
 */
export function handleAppProtocol() {
	const root = join(__dirname, "../dist");
	protocol.handle("app", (request) => {
		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(request.url).pathname);
		} catch {
			return new Response("bad request", { status: 400 });
		}
		const requested = normalize(join(root, pathname));
		if (requested !== root && !requested.startsWith(root + sep)) {
			return new Response("forbidden", { status: 403 });
		}
		const file = isFile(requested) ? requested : join(root, "index.html");
		return net.fetch(pathToFileURL(file).toString());
	});
}
