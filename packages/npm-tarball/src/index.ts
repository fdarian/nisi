import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Effect, Schema, Semaphore, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type Release = {
	readonly packageName: string;
	readonly version: string;
	readonly integrity: string;
};
export type InstallReason =
	| "download"
	| "integrity-mismatch"
	| "extract"
	| "cache";
export class NpmTarballInstallError extends Schema.TaggedError<NpmTarballInstallError>()(
	"NpmTarballInstallError",
	{
		reason: Schema.Literals([
			"download",
			"integrity-mismatch",
			"extract",
			"cache",
		]),
		cause: Schema.Defect(),
	},
) {}
type Requirements =
	| import("effect/FileSystem").FileSystem
	| ChildProcessSpawner.ChildProcessSpawner;
export type Downloader = (
	url: string,
) => Effect.Effect<Uint8Array, NpmTarballInstallError>;
export type InstallOptions = {
	readonly downloadTarball?: Downloader;
	readonly validate: (
		directory: string,
	) => Effect.Effect<
		boolean,
		NpmTarballInstallError,
		import("effect/FileSystem").FileSystem
	>;
	readonly sourceDirectory: string;
	readonly executable?: string;
};
const failure = (reason: InstallReason, cause: unknown) =>
	new NpmTarballInstallError({ reason, cause });

export const tarballUrl = (release: Release): string => {
	const archiveName = release.packageName.slice(
		release.packageName.indexOf("/") + 1,
	);
	return `https://registry.npmjs.org/${encodeURIComponent(release.packageName)}/-/${archiveName}-${release.version}.tgz`;
};

const defaultDownload: Downloader = (url) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client
			.get(url)
			.pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
		return new Uint8Array(yield* response.arrayBuffer);
	}).pipe(
		Effect.mapError((cause) => failure("download", cause)),
		Effect.provide(FetchHttpClient.layer),
	);

export const verifyIntegrity = (
	bytes: Uint8Array,
	release: Release,
): Effect.Effect<Uint8Array, NpmTarballInstallError> => {
	const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	return actual === release.integrity
		? Effect.succeed(bytes)
		: failure(
				"integrity-mismatch",
				new Error(
					`SHA-512 mismatch for ${release.packageName}@${release.version}: expected ${release.integrity}, got ${actual}`,
				),
			);
};

const extractTarball = (
	archive: string,
	directory: string,
): Effect.Effect<
	void,
	NpmTarballInstallError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner.spawn(
				ChildProcess.make("tar", ["-xzf", archive, "-C", directory], {
					stdout: "ignore",
					stderr: "pipe",
				}),
			);
			const result = yield* Effect.all([
				Stream.decodeText(handle.stderr).pipe(Stream.mkString),
				handle.exitCode,
			]);
			if (result[1] !== 0)
				return yield* failure(
					"extract",
					new Error(`tar exited with code ${result[1]}: ${result[0]}`),
				);
		}),
	).pipe(
		Effect.mapError((cause) =>
			cause instanceof NpmTarballInstallError
				? cause
				: failure("extract", cause),
		),
	);

const cached = (directory: string, options: InstallOptions) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (
			!(yield* fs
				.exists(directory)
				.pipe(Effect.mapError((cause) => failure("cache", cause))))
		)
			return false;
		return yield* options.validate(directory);
	});

const installFresh = (
	target: string,
	release: Release,
	options: InstallOptions,
): Effect.Effect<string, NpmTarballInstallError, Requirements> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (yield* cached(target, options)) return target;
		const parent = join(target, "..");
		const temp = join(
			parent,
			`.tmp-${release.version}-${process.pid}-${randomUUID()}`,
		);
		const cleanup = fs
			.remove(temp, { recursive: true, force: true })
			.pipe(Effect.catch(() => Effect.void));
		return yield* Effect.gen(function* () {
			yield* fs
				.makeDirectory(temp, { recursive: true })
				.pipe(Effect.mapError((cause) => failure("cache", cause)));
			const bytes = yield* (options.downloadTarball ?? defaultDownload)(
				tarballUrl(release),
			);
			yield* fs
				.writeFile(
					join(temp, "archive.tgz"),
					yield* verifyIntegrity(bytes, release),
				)
				.pipe(Effect.mapError((cause) => failure("cache", cause)));
			const extracted = join(temp, "extracted");
			yield* fs
				.makeDirectory(extracted, { recursive: true })
				.pipe(Effect.mapError((cause) => failure("extract", cause)));
			yield* extractTarball(join(temp, "archive.tgz"), extracted);
			const source = join(extracted, options.sourceDirectory);
			if (!(yield* options.validate(source)))
				return yield* failure(
					"extract",
					new Error(`archive ${release.packageName} is missing required files`),
				);
			if (options.executable !== undefined)
				yield* fs
					.chmod(join(source, options.executable), 0o755)
					.pipe(Effect.mapError((cause) => failure("extract", cause)));
			if (
				yield* fs
					.exists(target)
					.pipe(Effect.mapError((cause) => failure("cache", cause)))
			)
				yield* fs
					.remove(target, { recursive: true, force: true })
					.pipe(Effect.mapError((cause) => failure("cache", cause)));
			yield* fs
				.rename(source, target)
				.pipe(Effect.mapError((cause) => failure("cache", cause)));
			return target;
		}).pipe(Effect.ensuring(cleanup));
	});

const flights = new Map<
	string,
	Effect.Effect<string, NpmTarballInstallError, Requirements>
>();
const lock = Semaphore.makeUnsafe(1);

export const ensureNpmTarball = (
	target: string,
	release: Release,
	options: InstallOptions,
): Effect.Effect<string, NpmTarballInstallError, Requirements> =>
	Effect.gen(function* () {
		if (yield* cached(target, options)) return target;
		const key = `${target}/${release.packageName}@${release.version}`;
		const install = yield* lock.withPermit(
			Effect.gen(function* () {
				const existing = flights.get(key);
				if (existing !== undefined) return existing;
				const shared = yield* Effect.cached(
					Effect.uninterruptible(installFresh(target, release, options)),
				);
				flights.set(key, shared);
				return shared;
			}),
		);
		return yield* install;
	});
