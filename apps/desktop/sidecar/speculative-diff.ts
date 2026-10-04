import {
	getChangedFiles,
	getFileContents,
	readLocalBase,
	readRepoChangeSignature,
	repoChangeSignatureEquals,
	resolveHeadSha,
	resolveLocalDefaultBranch,
	type FileChange,
	type FileContent,
	type FileContentRequest,
	type RepoChangeSignature,
} from "@repo/git";
import { Deferred, Effect, Option, Scope } from "effect";
import { FILE_CONTENTS_CHUNK_SIZE } from "../src/features/pull-request/data/file-content-demand.ts";
import { comparePaths } from "../shared/compare-paths.ts";

type Candidate = {
	createdAt: number;
	repoRoot: string;
	baseRef: string;
	baseCommit: string;
	headCommit: string;
	includeUncommitted: boolean;
	signature: RepoChangeSignature;
	files: readonly FileChange[];
	contents: ReadonlyMap<string, FileContent>;
};

/** Raw git results only: session review claims must always be attached fresh. */
export const makeSpeculativeDiff = () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope;
		const confirmed = new Map<string, Candidate>();
		const start = (repoRoot: string, includeUncommitted: boolean) =>
			Effect.gen(function* () {
				const pending = yield* Deferred.make<Candidate | undefined>();
				const compute = Effect.gen(function* () {
					const baseRef = yield* resolveLocalDefaultBranch(repoRoot);
					const base = yield* readLocalBase(repoRoot, baseRef);
					if (base.commit === null) return undefined;
					const before = yield* readRepoChangeSignature(repoRoot, {
						includeUncommitted,
					});
					const files = yield* getChangedFiles(repoRoot, base.commit, {
						includeUncommitted,
					});
					const paths = files
						.filter((file) => !file.binary)
						.map((file) => file.path)
						.sort(comparePaths)
						.slice(0, FILE_CONTENTS_CHUNK_SIZE);
					const contents = yield* getFileContents(
						repoRoot,
						base.commit,
						paths.map((path) => ({ path })),
						{ includeUncommitted },
					);
					const after = yield* readRepoChangeSignature(repoRoot, {
						includeUncommitted,
					});
					if (!repoChangeSignatureEquals(before, after)) return undefined;
					return {
						createdAt: Date.now(),
						repoRoot,
						baseRef,
						baseCommit: base.commit,
						headCommit: before.headSha,
						includeUncommitted,
						signature: before,
						files,
						contents,
					} satisfies Candidate;
				}).pipe(Effect.withSpan("session.diff.speculate"));
				yield* compute.pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("speculative diff discarded", { cause }).pipe(
							Effect.as(undefined),
						),
					),
					Effect.flatMap((result) => Deferred.succeed(pending, result)),
					Effect.forkIn(scope),
				);
				return pending;
			});
		const confirm = (
			pending: Deferred.Deferred<Candidate | undefined>,
			repoRoot: string,
			baseRef: string,
		) =>
			Effect.gen(function* () {
				// Do not extend resolution to wait for speculation. A late result is discarded.
				const polled = yield* Deferred.poll(pending);
				if (Option.isNone(polled)) return;
				const candidate = yield* polled.value;
				if (candidate === undefined) return;
				if (candidate.baseRef !== baseRef) return;
				const base = yield* readLocalBase(repoRoot, baseRef);
				const head = yield* resolveHeadSha(repoRoot);
				if (
					base.commit !== candidate.baseCommit ||
					head !== candidate.headCommit
				)
					return;
				if (confirmed.size >= 8) {
					const oldest = confirmed.keys().next();
					if (!oldest.done) confirmed.delete(oldest.value);
				}
				confirmed.set(repoRoot, candidate);
				yield* Effect.annotateCurrentSpan("confirmed", true);
			}).pipe(Effect.withSpan("session.diff.confirm"));
		const lookup = (
			repoRoot: string,
			baseRef: string,
			headRef: string | undefined,
			includeUncommitted: boolean,
		) =>
			Effect.gen(function* () {
				const candidate = confirmed.get(repoRoot);
				if (
					candidate === undefined ||
					Date.now() - candidate.createdAt > 30_000 ||
					candidate.includeUncommitted !== includeUncommitted ||
					candidate.baseRef !== baseRef
				)
					return undefined;
				const base = yield* readLocalBase(repoRoot, baseRef);
				const head = yield* resolveHeadSha(repoRoot, headRef);
				if (
					base.commit !== candidate.baseCommit ||
					head !== candidate.headCommit
				) {
					confirmed.delete(repoRoot);
					return undefined;
				}
				if (includeUncommitted) {
					const signature = yield* readRepoChangeSignature(repoRoot, {
						includeUncommitted,
					});
					if (!repoChangeSignatureEquals(signature, candidate.signature)) {
						confirmed.delete(repoRoot);
						return undefined;
					}
				}
				return candidate;
			});
		return {
			start,
			confirm,
			files: (
				repoRoot: string,
				baseRef: string,
				headRef: string | undefined,
				includeUncommitted: boolean,
			) =>
				lookup(repoRoot, baseRef, headRef, includeUncommitted).pipe(
					Effect.map((candidate) => candidate?.files),
					Effect.tap((files) =>
						Effect.annotateCurrentSpan("hit", files !== undefined),
					),
					Effect.withSpan("diff.speculative.files"),
				),
			contents: (
				repoRoot: string,
				baseRef: string,
				headRef: string | undefined,
				includeUncommitted: boolean,
				requests: readonly FileContentRequest[],
			) =>
				lookup(repoRoot, baseRef, headRef, includeUncommitted).pipe(
					Effect.map((candidate) =>
						candidate !== undefined &&
						requests.every(
							(request) =>
								!request.force && candidate.contents.has(request.path),
						)
							? candidate.contents
							: undefined,
					),
					Effect.tap((contents) =>
						Effect.annotateCurrentSpan("hit", contents !== undefined),
					),
					Effect.withSpan("diff.speculative.contents"),
				),
		};
	});
