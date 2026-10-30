import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

const DEBOUNCE_MS = 150;

type FolderWatch = {
	readonly folder: string | null;
	readonly close: () => void;
};

/**
 * Calls `onChange` (debounced) when anything under the central guide `folder`
 * changes — including `checks/` — or when the folder itself appears or
 * disappears. The folder's parent is created up front and watched for the
 * folder's name, so a guide that doesn't exist yet shows up the moment an
 * agent writes one.
 *
 * macOS fs.watch is FSEvents-backed: a watcher costs no file descriptor, and the
 * parent one only reports direct children, so the name filter below keeps it
 * quiet for the sibling branches' folders.
 */
export function watchGuideFolder(
	folder: string,
	onChange: () => void,
	onError: (cause: unknown) => void,
): FolderWatch {
	const parent = dirname(folder);
	const name = basename(folder);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let inner: FSWatcher | undefined;

	const notify = () => {
		clearTimeout(timer);
		timer = setTimeout(onChange, DEBOUNCE_MS);
	};

	const reopenInner = () => {
		inner?.close();
		inner = undefined;
		// The folder can vanish between the existence check and the watch; the
		// watcher on its parent reports that, so there is nothing to do here.
		if (!existsSync(folder)) return;
		inner = watch(folder, { recursive: true }, notify);
		inner.on("error", onError);
	};

	mkdirSync(parent, { recursive: true });
	const outer = watch(parent, (_event, changed) => {
		if (changed === name) {
			reopenInner();
			notify();
		}
	});
	outer.on("error", onError);
	reopenInner();

	return {
		folder,
		close: () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			outer.close();
			inner?.close();
		},
	};
}

const folderWatches = new Map<string, FolderWatch>();

/**
 * Replaces any watch already running for the session, so a branch that moved is
 * followed. A null `folder` (a detached branch session, which has no central
 * folder) still registers the session, so its head moves are reported, but
 * watches no files.
 */
export function startGuideWatch(
	sessionId: string,
	folder: string | null,
	onChange: () => void,
	onError: (cause: unknown) => void,
): void {
	const existing = folderWatches.get(sessionId);
	if (existing !== undefined && existing.folder === folder) return;
	existing?.close();
	folderWatches.set(
		sessionId,
		folder === null
			? { folder, close: () => {} }
			: watchGuideFolder(folder, onChange, onError),
	);
}

export function stopGuideWatch(sessionId: string): void {
	folderWatches.get(sessionId)?.close();
	folderWatches.delete(sessionId);
}

/** Sessions whose client asked for `guide-changed`; live-poll also checks their head. */
export function guideWatchedSessionIds(): ReadonlySet<string> {
	return new Set(folderWatches.keys());
}
