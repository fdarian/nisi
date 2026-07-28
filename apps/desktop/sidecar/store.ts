import { join } from "node:path";
import {
	type FileChange,
	type FileContent,
	FileNotChanged,
	type GhOutputDecodeError,
	type GitCommandError,
	getChangedFiles,
	getFileContent,
	type NoDefaultBranch,
	resolveCurrentBranch,
	resolveRepoRoot,
	resolveReviewTarget,
} from "@repo/git";
import {
	type Session as ReviewSession,
	ReviewStore,
	SessionNotFound,
} from "@repo/review";
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";

/** `sessions.open`'s `cwd` doesn't resolve to a git working tree. */
export class InvalidCwd extends Schema.TaggedErrorClass<InvalidCwd>()(
	"InvalidCwd",
	{
		cwd: Schema.String,
	},
) {}

export type Session = {
	readonly id: string;
	readonly repoRoot: string;
	readonly pr: {
		readonly number: number;
		readonly title: string;
		readonly baseRef: string;
		readonly headRef: string;
		readonly owner: string;
		readonly repo: string;
	} | null;
};

const toWireSession = (session: ReviewSession): Session => ({
	id: session.id,
	repoRoot: session.repoRoot,
	pr:
		session.pr === null
			? null
			: {
					number: session.pr.number,
					title: session.pr.title,
					baseRef: session.baseRef,
					headRef: session.headRef,
					owner: session.owner,
					repo: session.repo,
				},
});

/**
 * Combines `@repo/git` (pure PR/diff detection) and `@repo/review`
 * (persistence) into the one service the sidecar's oRPC handlers depend on.
 * Sessions are `@repo/review`'s row plus `@repo/git`'s resolution of what
 * that row's `repoRoot`/PR state actually *is* right now.
 */
export class Store extends Context.Service<Store>()("Store", {
	make: Effect.gen(function* () {
		const reviewStore = yield* ReviewStore;
		const fs = yield* FileSystem;

		const openSession = (cwd: string) =>
			Effect.gen(function* () {
				const repoRoot = yield* resolveRepoRoot(cwd).pipe(
					Effect.catchTag("NotAGitRepository", () => new InvalidCwd({ cwd })),
				);
				const [reviewTarget, currentBranch] = yield* Effect.all([
					resolveReviewTarget(repoRoot),
					resolveCurrentBranch(repoRoot),
				]);
				const baseRef = reviewTarget.pr?.baseRef ?? reviewTarget.defaultBranch;
				const headRef = reviewTarget.pr?.headRef ?? currentBranch;

				const session = yield* reviewStore.openSession({
					repoRoot,
					owner: reviewTarget.owner,
					repo: reviewTarget.repo,
					baseRef,
					headRef,
					pr:
						reviewTarget.pr === null
							? null
							: {
									number: reviewTarget.pr.number,
									title: reviewTarget.pr.title,
								},
				});
				return toWireSession(session);
			});

		const listSessions = () =>
			reviewStore
				.listOpenSessions()
				.pipe(Effect.map((sessions) => sessions.map(toWireSession)));

		const closeSession = (sessionId: string) =>
			reviewStore.closeSession(sessionId);

		const listChangedFiles = (sessionId: string) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				return yield* getChangedFiles(session.repoRoot, session.baseRef);
			});

		const readFileContent = (sessionId: string, path: string, force: boolean) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				return yield* getFileContent(session.repoRoot, session.baseRef, path, {
					force,
				});
			});

		/**
		 * Un-ticking Reviewed just clears the snapshot. Ticking it reads the
		 * file's *current worktree* content directly — this is a plain read, not
		 * `@repo/git`'s size-gated `getFileContent`, since a review snapshot's
		 * whole point is fidelity. A missing file (ticking Reviewed on a
		 * deletion) snapshots as empty content, matching how git itself treats
		 * "diff against /dev/null" — not a swallowed error.
		 */
		const setFileViewed = (sessionId: string, path: string, viewed: boolean) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				if (!viewed) {
					yield* reviewStore.markFileUnviewed(sessionId, path);
					return;
				}
				const content = yield* fs
					.readFile(join(session.repoRoot, path))
					.pipe(Effect.orElseSucceed(() => new Uint8Array()));
				yield* reviewStore.markFileViewed(sessionId, path, content);
			});

		return {
			openSession,
			listSessions,
			closeSession,
			listChangedFiles,
			readFileContent,
			setFileViewed,
		};
	}),
}) {
	static layer = Layer.effect(Store, Store.make).pipe(
		Layer.provide(ReviewStore.layer),
	);
}

export type {
	FileChange,
	FileContent,
	GhOutputDecodeError,
	GitCommandError,
	NoDefaultBranch,
};
export { FileNotChanged, SessionNotFound };
