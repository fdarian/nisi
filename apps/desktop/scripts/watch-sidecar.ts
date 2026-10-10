import { type FSWatcher, readFileSync, realpathSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the sidecar and restarts it when a file in its import graph changes —
 * what `bun run --watch sidecar/index.ts` did, minus the leak: `bun --watch`
 * reloads in the same process and leaves every watched file's descriptor open
 * (about 1200 per reload for the sidecar). Past ~10k open descriptors macOS
 * `posix_spawn` fails with `EBADF`, so after a dev session's worth of saves
 * every `git` the sidecar runs does too. Here each restart is a fresh process,
 * and the watchers (FSEvents, no descriptors) are opened once.
 *
 * Like `--watch`, a crashed sidecar stays down until the next change rather
 * than ending this process, which would take the rest of `bun dev` with it.
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(appDir, "sidecar/index.ts");
const DEBOUNCE_MS = 150;
const STOP_TIMEOUT_MS = 5_000;

const typescript = new Bun.Transpiler({ loader: "ts" });
const tsx = new Bun.Transpiler({ loader: "tsx" });
const SCANNABLE = /\.(?:m?[jt]s|[jt]sx)$/;

/**
 * Every source file the entry reaches, outside `node_modules` — workspace
 * packages included, since they are symlinked in. A file that doesn't parse or
 * an import that doesn't resolve is skipped: it is being edited, and the sidecar
 * reports the real error itself when it is started.
 */
function importGraph(): Set<string> {
	const seen = new Set<string>();
	const importsOf = (file: string): string[] => {
		try {
			const transpiler = file.endsWith("x") ? tsx : typescript;
			return transpiler
				.scanImports(readFileSync(file, "utf8"))
				.map((imported) => imported.path);
		} catch {
			return [];
		}
	};
	const resolveImport = (specifier: string, from: string) => {
		try {
			return realpathSync(Bun.resolveSync(specifier, dirname(from)));
		} catch {
			return undefined;
		}
	};
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		if (!SCANNABLE.test(file)) return;
		for (const specifier of importsOf(file)) {
			const resolved = resolveImport(specifier, file);
			if (resolved !== undefined && !resolved.includes("/node_modules/"))
				visit(resolved);
		}
	};
	visit(realpathSync(entry));
	return seen;
}

let files = importGraph();
const watchers = new Map<string, FSWatcher>();
let child: Bun.Subprocess | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let restarting = Promise.resolve();

function syncWatchers() {
	const dirs = new Set([...files].map((file) => dirname(file)));
	for (const [dir, watcher] of watchers) {
		if (dirs.has(dir)) continue;
		watcher.close();
		watchers.delete(dir);
	}
	for (const dir of dirs) {
		if (watchers.has(dir)) continue;
		watchers.set(
			dir,
			watch(dir, (_event, name) => {
				if (name !== null && files.has(join(dir, name))) schedule();
			}),
		);
	}
}

async function stop() {
	const running = child;
	if (running === undefined) return;
	child = undefined;
	running.kill("SIGTERM");
	const forced = setTimeout(() => running.kill("SIGKILL"), STOP_TIMEOUT_MS);
	await running.exited;
	clearTimeout(forced);
}

async function restart() {
	await stop();
	// The graph is rebuilt from the file that just changed, so a new import is watched from now on.
	files = importGraph();
	syncWatchers();
	const started = Bun.spawn(["bun", "run", entry], {
		cwd: appDir,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	child = started;
	void started.exited.then((code) => {
		if (child !== started) return;
		child = undefined;
		console.log(
			`[watch-sidecar] sidecar exited (${code}); waiting for a change`,
		);
	});
}

function schedule() {
	clearTimeout(timer);
	timer = setTimeout(() => {
		restarting = restarting.then(restart);
	}, DEBOUNCE_MS);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void stop().then(() => process.exit(0));
	});
}

syncWatchers();
restarting = restart();
