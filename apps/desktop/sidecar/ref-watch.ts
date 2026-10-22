import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveGitDirs } from "./ref-state.ts";

const DEBOUNCE_MS = 150;

type RefWatch = {
	readonly close: () => void;
};

/**
 * Calls `onChange` (debounced) when a commit, checkout, branch update or ref
 * packing could have moved a repo's HEAD: `HEAD` in the git dir, `packed-refs`
 * in the common dir, or anything under `refs/heads/`. Undefined when
 * `resolveGitDirs` can't read the layout; the caller keeps polling then.
 *
 * Directories are watched, never the ref files: git writes `X.lock` and renames
 * it over `X`, which would leave a file watch on the replaced inode. Every other
 * name (`index`, `ORIG_HEAD`, `FETCH_HEAD`, `logs/`, ...) is ignored, since those
 * change far more often than HEAD does. A change that leaves HEAD where it was,
 * like a commit on another branch of the same clone, still fires; the caller's
 * fingerprint compare is what filters it.
 */
export const watchRefs = (
	repoRoot: string,
	onChange: () => void,
	onError: (cause: unknown) => void,
) =>
	Effect.gen(function* () {
		const dirs = yield* resolveGitDirs(repoRoot);
		if (dirs === undefined) return undefined;

		let timer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		const watchers: FSWatcher[] = [];

		const notify = () => {
			clearTimeout(timer);
			timer = setTimeout(onChange, DEBOUNCE_MS);
		};

		const open = (
			dir: string,
			recursive: boolean,
			onEvent: (name: string | null) => void,
		) => {
			const watcher = watch(dir, { recursive }, (_event, name) =>
				onEvent(name),
			);
			watcher.on("error", onError);
			watchers.push(watcher);
		};

		const close = () => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
		};

		const heads = join(dirs.commonDir, "refs/heads");
		if (!existsSync(heads)) return undefined;

		yield* Effect.try(() => {
			if (dirs.gitDir === dirs.commonDir) {
				open(dirs.gitDir, false, (name) => {
					if (name === "HEAD" || name === "packed-refs") notify();
				});
			} else {
				open(dirs.gitDir, false, (name) => {
					if (name === "HEAD") notify();
				});
				open(dirs.commonDir, false, (name) => {
					if (name === "packed-refs") notify();
				});
			}
			open(heads, true, (name) => {
				if (!name?.endsWith(".lock")) notify();
			});
		}).pipe(Effect.tapError(() => Effect.sync(close)));

		return { close } satisfies RefWatch;
	});
