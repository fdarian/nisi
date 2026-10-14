import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { GUIDE_DIR } from "./build.ts";

const DEBOUNCE_MS = 150;
const NISI_DIR = ".nisi";
const GUIDE_NAME = "guide";

type FolderWatch = {
	readonly repoRoot: string;
	readonly close: () => void;
};

/**
 * Calls `onChange` (debounced) when anything under `<repoRoot>/.nisi/guide/`
 * changes — including `checks/` — or when that folder, or `.nisi/` above it,
 * appears or disappears. A guide that doesn't exist yet is watched through its
 * ancestors, so the Guide tab can show up the moment an agent writes one.
 *
 * macOS fs.watch is FSEvents-backed: a watcher costs no file descriptor, and the
 * repo-root one only reports direct children, so the filename filter below keeps
 * it quiet for the rest of the worktree.
 */
export function watchGuideFolder(
	repoRoot: string,
	onChange: () => void,
	onError: (cause: unknown) => void,
): FolderWatch {
	const nisiDir = join(repoRoot, NISI_DIR);
	const guideDir = join(repoRoot, GUIDE_DIR);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let nested: FSWatcher[] = [];

	const notify = () => {
		clearTimeout(timer);
		timer = setTimeout(onChange, DEBOUNCE_MS);
	};

	const open = (
		dir: string,
		recursive: boolean,
		onEvent: (name: string) => void,
	) => {
		// The directory can vanish between the existence check and the watch;
		// the watcher on its parent reports that, so there is nothing to do here.
		if (!existsSync(dir)) return undefined;
		const watcher = watch(dir, { recursive }, (_event, name) =>
			onEvent(name ?? ""),
		);
		watcher.on("error", onError);
		return watcher;
	};

	const reopenNested = () => {
		for (const watcher of nested) watcher.close();
		nested = [
			open(nisiDir, false, (name) => {
				if (name === GUIDE_NAME) {
					reopenNested();
					notify();
				}
			}),
			open(guideDir, true, notify),
		].filter((watcher) => watcher !== undefined);
	};

	const root = watch(repoRoot, (_event, name) => {
		if (name === NISI_DIR) {
			reopenNested();
			notify();
		}
	});
	root.on("error", onError);
	reopenNested();

	return {
		repoRoot,
		close: () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			root.close();
			for (const watcher of nested) watcher.close();
		},
	};
}

const folderWatches = new Map<string, FolderWatch>();

/** Replaces any watch already running for the session, so a worktree that moved is followed. */
export function startGuideWatch(
	sessionId: string,
	repoRoot: string,
	onChange: () => void,
	onError: (cause: unknown) => void,
): void {
	const existing = folderWatches.get(sessionId);
	if (existing?.repoRoot === repoRoot) return;
	existing?.close();
	folderWatches.set(sessionId, watchGuideFolder(repoRoot, onChange, onError));
}

export function stopGuideWatch(sessionId: string): void {
	folderWatches.get(sessionId)?.close();
	folderWatches.delete(sessionId);
}

/** Sessions whose client asked for `guide-changed`; live-poll also checks their head. */
export function guideWatchedSessionIds(): ReadonlySet<string> {
	return new Set(folderWatches.keys());
}
