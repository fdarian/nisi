import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Effect, Option, Schema, Semaphore, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const TS_LSP_VERSION = "7.0.2";

type TsLspRelease = {
	readonly packageName: string;
	readonly integrity: string;
};

/** These values mirror the TypeScript 7.0.2 platform packages in pnpm-lock.yaml. */
const TS_LSP_RELEASES: Readonly<Record<string, TsLspRelease>> = {
	"aix/ppc64": {
		packageName: "@typescript/typescript-aix-ppc64",
		integrity:
			"sha512-MTKKkWB7p/0E9xi1d1tHtZ5PiLkGEMIq88pK2CubZjOsLtYTLqhgIgi6zepFa+9GHZ6h05NMCkQxGKiPXMxXtQ==",
	},
	"darwin/arm64": {
		packageName: "@typescript/typescript-darwin-arm64",
		integrity:
			"sha512-gowzar9MwS/aRWp6f3a4KUqzRjAZjOsmGNCM6LcTgXum+dBfgsBVMN+AgvOCCbguXyick6LJhpBszxMebJ8syA==",
	},
	"darwin/x64": {
		packageName: "@typescript/typescript-darwin-x64",
		integrity:
			"sha512-SZ9xZInqApNlNGc9s0W1VSsktYSOe9cFqNOIqmN1Gs8SmkjKZYFt017G4VwPxASInODuAdbTW7sXiFUf893RgA==",
	},
	"freebsd/arm64": {
		packageName: "@typescript/typescript-freebsd-arm64",
		integrity:
			"sha512-W5NH4y/J0plIIS5b2xvTEkU7JFxyqdMAOgf+Ilhl0vHQXKO5dZoxd+C/jEtq56c4F3wk71RB4BMRQ2XdI+bwYQ==",
	},
	"freebsd/x64": {
		packageName: "@typescript/typescript-freebsd-x64",
		integrity:
			"sha512-UMGDx5sTpzNw3WiPebH7l90IWfJggEd+egHt/q6p7/Cm3zqoVxkGXt+3DxPIw8CcmvAB0j3sVVfbhX+M4Tpw==",
	},
	"linux/arm64": {
		packageName: "@typescript/typescript-linux-arm64",
		integrity:
			"sha512-Qh4eU4/y3yDjnfjjyPYihMj5/ODIlmt+Bzu17OI+fiSRDW57QmU5SiN63exPRNJPKUzcc1INa1NXdrJ+MqHjUQ==",
	},
	"linux/arm": {
		packageName: "@typescript/typescript-linux-arm",
		integrity:
			"sha512-gffT3xPz9sR7j/YJExkyPntrI0P2EP9XbOyWzth2/Gs0RstK+90RBcO0ncXoXy/beYll1SXw846Nf2zdnEz0QQ==",
	},
	"linux/loong64": {
		packageName: "@typescript/typescript-linux-loong64",
		integrity:
			"sha512-uEHck9i8hoAzXPiYRib1O7miOnz23SxIeVl6F4LXox+qov1K35jHcEW6VHKvZI+pyvl7fZEP4MCU5LYvIq1GuQ==",
	},
	"linux/mips64el": {
		packageName: "@typescript/typescript-linux-mips64el",
		integrity:
			"sha512-R4KvAMnE43W5Qeqb0Ly56O3mWMWIAgsMyz36DCaycd5nbg/9kzm0liw3JocfRqyJY0KPmzFjbswozXyW0DnIYA==",
	},
	"linux/ppc64": {
		packageName: "@typescript/typescript-linux-ppc64",
		integrity:
			"sha512-DORx5b3sd/4S7eayxmFQv+A7CrkUIGRaHiwI8oiHTAI1fAPWhF4J0vAlkC8biAlHSVVwxMQ3tjZ2/DVbnQiiA==",
	},
	"linux/riscv64": {
		packageName: "@typescript/typescript-linux-riscv64",
		integrity:
			"sha512-wf0jqEDOjrPRnKwYRyyJDRo11KMbvMFrU+q4zqKyChODBzvlkbhNQfKvLxQCcwTpdDaXSHZTVuh0JoCrKCUMHQ==",
	},
	"linux/s390x": {
		packageName: "@typescript/typescript-linux-s390x",
		integrity:
			"sha512-IkwJc3L7yhytWd/ewjyxNDfOmswCm9GWMJT/ue/dU4aZNbwZeYAetq42VyLmsmSjvoX7z74X6ZaYCtzAr0EuGw==",
	},
	"linux/x64": {
		packageName: "@typescript/typescript-linux-x64",
		integrity:
			"sha512-EYdf2cNg7rgCWJnxCdJ+F3V39O8ihb37eHAu1LK8oAFizgTQbPOK7zHHXbPt8rX24COqODXeI3sIf0fCXG7H/A==",
	},
	"netbsd/arm64": {
		packageName: "@typescript/typescript-netbsd-arm64",
		integrity:
			"sha512-+polYF4MF04aPpO5FTkHran9yUQDSXqy5GiSDKpsll5jy3l3+g9QLhpf39T+ePtefhXLOGrLl0QIjkQP6VnelA==",
	},
	"netbsd/x64": {
		packageName: "@typescript/typescript-netbsd-x64",
		integrity:
			"sha512-8YIT0EHM/3dq10ZOVF/A7pc/YSMtbcecct4rWtexrnSCHOPcpC2KTLXfTCR6vDpnSiY12heNb1GiN/wu+T/FyA==",
	},
	"openbsd/arm64": {
		packageName: "@typescript/typescript-openbsd-arm64",
		integrity:
			"sha512-APT8+ClYnuYm1u9+kgGXoMj2VzWzcymwh2gNSQVySHfkRDGOTVkoWLjCmOQSaO+PoqQ57B0flRp9SA+7GnnkzQ==",
	},
	"openbsd/x64": {
		packageName: "@typescript/typescript-openbsd-x64",
		integrity:
			"sha512-yX7s+Q0Dln0Dt9tEzZsAjXXR/+ytBM7AlglaqyeMPxQszJ1JhlJdZ6jLA+IzldHtflX81em7lDao1xXu+aRRkg==",
	},
	"sunos/x64": {
		packageName: "@typescript/typescript-sunos-x64",
		integrity:
			"sha512-dLJDGaLZ1D4HPQn62u1n8mBDkJREwMsAkCdkwd4Ieqw+x3TUyTsqY0YiBCtE6H6OzzgGk3iuZ3vFWRS+E8/d1g==",
	},
	"win32/arm64": {
		packageName: "@typescript/typescript-win32-arm64",
		integrity:
			"sha512-Gyl1Vy6OsWesLzmq+EP0Fb7b4Nid5232AvcA2SFcdYreldpNtYFFofPjnt62y9hQy7VTaZp65ICJjuAQRaVcIQ==",
	},
	"win32/x64": {
		packageName: "@typescript/typescript-win32-x64",
		integrity:
			"sha512-0BQ3HkAHHlKLSp1qRvf3SUhGpGsDuhB/jgFw75guyqbxJqEaS0Cw/VFO8i2nHglJUzQCRtMMR/IBAKE3ETMC4g==",
	},
};

export type TsLspBinaryInstallReason =
	| "unsupported-platform"
	| "download"
	| "integrity-mismatch"
	| "extract"
	| "cache";

export class TsLspBinaryInstallError extends Schema.TaggedError<TsLspBinaryInstallError>()(
	"TsLspBinaryInstallError",
	{
		reason: Schema.Literals([
			"unsupported-platform",
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

export type TsLspTarballDownloader = (
	url: string,
) => Effect.Effect<Uint8Array, TsLspBinaryInstallError>;

export type TsLspBinaryInstallOptions = {
	readonly downloadTarball?: TsLspTarballDownloader;
};

const makeInstallError = (
	reason: TsLspBinaryInstallReason,
	cause: unknown,
): TsLspBinaryInstallError => new TsLspBinaryInstallError({ reason, cause });

const currentRelease = (): TsLspRelease | undefined =>
	TS_LSP_RELEASES[`${process.platform}/${process.arch}`];

const executableName = (): string =>
	process.platform === "win32" ? "tsc.exe" : "tsc";

const tarballUrl = (release: TsLspRelease): string => {
	const packageNameStart = release.packageName.indexOf("/") + 1;
	const archiveName = release.packageName.slice(packageNameStart);
	return `https://registry.npmjs.org/${encodeURIComponent(release.packageName)}/-/${archiveName}-${TS_LSP_VERSION}.tgz`;
};

const defaultDownloadTarball = (
	url: string,
): Effect.Effect<Uint8Array, TsLspBinaryInstallError> =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client
			.get(url)
			.pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
		const bytes = yield* response.arrayBuffer;
		return new Uint8Array(bytes);
	}).pipe(
		Effect.mapError((cause) => makeInstallError("download", cause)),
		Effect.provide(FetchHttpClient.layer),
	);

export const verifyTsLspTarballIntegrity = (
	bytes: Uint8Array,
	expectedIntegrity: string,
	packageName: string,
): Effect.Effect<Uint8Array, TsLspBinaryInstallError> => {
	const actualIntegrity = `sha512-${createHash("sha512")
		.update(bytes)
		.digest("base64")}`;
	if (actualIntegrity === expectedIntegrity) return Effect.succeed(bytes);
	return makeInstallError(
		"integrity-mismatch",
		new Error(
			`SHA-512 mismatch for ${packageName}@${TS_LSP_VERSION}: expected ${expectedIntegrity}, got ${actualIntegrity}`,
		),
	);
};

const cachedBinary = (
	targetDir: string,
): Effect.Effect<
	Option.Option<string>,
	TsLspBinaryInstallError,
	import("effect/FileSystem").FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const targetExists = yield* fs
			.exists(targetDir)
			.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));
		if (!targetExists) return Option.none<string>();

		const names = yield* fs
			.readDirectory(targetDir)
			.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));
		const binary = executableName();
		const hasBinary = names.includes(binary);
		const hasDeclarations = names.some((name) => name.endsWith(".d.ts"));
		return hasBinary && hasDeclarations
			? Option.some(join(targetDir, binary))
			: Option.none<string>();
	});

const extractTarball = (
	archivePath: string,
	extractDir: string,
): Effect.Effect<
	void,
	TsLspBinaryInstallError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner.spawn(
				ChildProcess.make("tar", ["-xzf", archivePath, "-C", extractDir], {
					stdout: "ignore",
					stderr: "pipe",
				}),
			);
			const processResult = yield* Effect.all([
				Stream.decodeText(handle.stderr).pipe(Stream.mkString),
				handle.exitCode,
			]);
			if (processResult[1] !== 0) {
				return yield* makeInstallError(
					"extract",
					new Error(
						`tar exited with code ${processResult[1]}: ${processResult[0]}`,
					),
				);
			}
		}),
	).pipe(
		Effect.mapError((cause) =>
			cause instanceof TsLspBinaryInstallError
				? cause
				: makeInstallError("extract", cause),
		),
	);

const installFresh = (
	cacheDir: string,
	targetDir: string,
	release: TsLspRelease,
	downloader: TsLspTarballDownloader,
): Effect.Effect<string, TsLspBinaryInstallError, Requirements> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const existing = yield* cachedBinary(targetDir);
		if (Option.isSome(existing)) return existing.value;

		const targetExists = yield* fs
			.exists(targetDir)
			.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));
		if (targetExists) {
			yield* fs
				.remove(targetDir, { recursive: true, force: true })
				.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));
		}

		const tempDir = join(
			cacheDir,
			`.tmp-${TS_LSP_VERSION}-${process.pid}-${randomUUID()}`,
		);
		const archivePath = join(tempDir, "typescript.tgz");
		const extractDir = join(tempDir, "extracted");
		const cleanup = fs
			.remove(tempDir, { recursive: true, force: true })
			.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));

		return yield* Effect.gen(function* () {
			yield* fs
				.makeDirectory(cacheDir, { recursive: true })
				.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));
			yield* fs
				.makeDirectory(tempDir, { recursive: true })
				.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));

			const downloaded = yield* downloader(tarballUrl(release));
			const verified = yield* verifyTsLspTarballIntegrity(
				downloaded,
				release.integrity,
				release.packageName,
			);
			yield* fs
				.writeFile(archivePath, verified)
				.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));
			yield* fs
				.makeDirectory(extractDir, { recursive: true })
				.pipe(Effect.mapError((cause) => makeInstallError("extract", cause)));
			yield* extractTarball(archivePath, extractDir);

			const extractedLibDir = join(extractDir, "package", "lib");
			const names = yield* fs
				.readDirectory(extractedLibDir)
				.pipe(Effect.mapError((cause) => makeInstallError("extract", cause)));
			const binary = executableName();
			if (!names.includes(binary)) {
				return yield* makeInstallError(
					"extract",
					new Error(`archive has no ${binary} beside its declaration files`),
				);
			}
			if (!names.some((name) => name.endsWith(".d.ts"))) {
				return yield* makeInstallError(
					"extract",
					new Error("archive has no lib .d.ts files beside its executable"),
				);
			}
			yield* fs
				.chmod(join(extractedLibDir, binary), 0o755)
				.pipe(Effect.mapError((cause) => makeInstallError("extract", cause)));
			yield* fs
				.rename(extractedLibDir, targetDir)
				.pipe(Effect.mapError((cause) => makeInstallError("cache", cause)));
			return join(targetDir, binary);
		}).pipe(
			// A cleanup failure must not hide the integrity or extraction failure that caused it.
			Effect.ensuring(cleanup.pipe(Effect.catch(() => Effect.void))),
		);
	});

const installFlights = new Map<
	string,
	Effect.Effect<string, TsLspBinaryInstallError, Requirements>
>();
const installFlightsLock = Semaphore.makeUnsafe(1);

const sharedInstall = (
	cacheDir: string,
	targetDir: string,
	release: TsLspRelease,
	downloader: TsLspTarballDownloader,
): Effect.Effect<string, TsLspBinaryInstallError, Requirements> =>
	Effect.gen(function* () {
		const key = `${targetDir}/${release.packageName}`;
		const install = yield* installFlightsLock.withPermit(
			Effect.gen(function* () {
				const existing = installFlights.get(key);
				if (existing !== undefined) return existing;
				const cached = yield* Effect.cached(
					Effect.uninterruptible(
						installFresh(cacheDir, targetDir, release, downloader),
					),
				);
				installFlights.set(key, cached);
				return cached;
			}),
		);
		return yield* install;
	});

export const ensureTsLspBinary = (
	cacheDir: string,
	options?: TsLspBinaryInstallOptions,
): Effect.Effect<string, TsLspBinaryInstallError, Requirements> =>
	Effect.gen(function* () {
		const release = currentRelease();
		if (release === undefined) {
			return yield* makeInstallError(
				"unsupported-platform",
				new Error(
					`no TypeScript ${TS_LSP_VERSION} integrity pin for ${process.platform}/${process.arch}`,
				),
			);
		}

		const targetDir = join(cacheDir, TS_LSP_VERSION);
		const existing = yield* cachedBinary(targetDir);
		if (Option.isSome(existing)) return existing.value;

		const downloader =
			options === undefined || options.downloadTarball === undefined
				? defaultDownloadTarball
				: options.downloadTarball;
		return yield* sharedInstall(cacheDir, targetDir, release, downloader);
	});
