import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveWebStatic } from "./web-static.ts";

let root: string;
let webDir: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "web-static-"));
	webDir = join(root, "web");
	mkdirSync(join(webDir, "assets"), { recursive: true });
	writeFileSync(join(webDir, "index.html"), "<html>shell</html>");
	writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log(1)");
	writeFileSync(join(root, "secret.txt"), "secret");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const get = (path: string, method = "GET") =>
	serveWebStatic(webDir, new Request(`http://localhost${path}`, { method }));

test("serves an existing file with its content type", async () => {
	const response = get("/assets/app-abc123.js");
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("javascript");
	expect(await response.text()).toBe("console.log(1)");
});

test("hashed assets are long-cached and index.html is not", () => {
	expect(get("/assets/app-abc123.js").headers.get("cache-control")).toContain(
		"immutable",
	);
	expect(get("/").headers.get("cache-control")).toBe("no-cache");
});

test("extensionless paths fall back to index.html", async () => {
	for (const path of ["/", "/settings/repositories", "/assets"]) {
		const response = get(path);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<html>shell</html>");
	}
});

test("a missing path with an extension is a 404, not the shell", () => {
	expect(get("/assets/gone-xyz.js").status).toBe(404);
});

test("path traversal is rejected", async () => {
	for (const path of [
		"/..%2fsecret.txt",
		"/%2e%2e%2fsecret.txt",
		"/assets/..%2f..%2fsecret.txt",
		"/..%5csecret.txt",
	]) {
		const response = get(path);
		expect(response.status).not.toBe(200);
		expect(await response.text()).not.toContain("secret");
	}
	expect(get("/..%2fsecret.txt").status).toBe(403);
});

test("HEAD returns headers without a body; other methods are 405", async () => {
	const head = get("/assets/app-abc123.js", "HEAD");
	expect(head.status).toBe(200);
	expect(head.headers.get("content-length")).toBe("14");
	expect(await head.text()).toBe("");
	expect(get("/", "POST").status).toBe(405);
});
