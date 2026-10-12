import { join } from "node:path";
import {
	type Downloader,
	ensureNpmTarball,
	NpmTarballInstallError,
	type Release,
} from "@repo/npm-tarball";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";

export const TS_LSP_VERSION = "7.0.2";

type TsLspRelease = {
	readonly packageName: string;
	readonly integrity: string;
};

/** These values mirror the TypeScript 7.0.2 platform packages in pnpm-lock.yaml. */
export const TS_LSP_RELEASES: Readonly<Record<string, TsLspRelease>> = {
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
			"sha512-UMGDx5sTpzNw3WiPebH7l90IWfJggEd+egHt/q6p7/Cm3zqoV7VxkGXt+3DxPIw8CcmvAB0j3sVVfbhX+M4Tpw==",
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
			"sha512-DORx5b3sd/4S7eayxm4FQv+A7CrkUIGRaHiwI8oiHTAI1fAPWhF4J0vAlkC8biAlHSVVwxMQ3tjZ2/DVbnQiiA==",
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
	| NpmTarballInstallError["reason"];
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
export type TsLspTarballDownloader = Downloader;
export type TsLspBinaryInstallOptions = {
	readonly downloadTarball?: TsLspTarballDownloader;
};

const executableName = () => (process.platform === "win32" ? "tsc.exe" : "tsc");
const validate = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (
			!(yield* fs
				.exists(directory)
				.pipe(
					Effect.mapError(
						(cause) => new NpmTarballInstallError({ reason: "cache", cause }),
					),
				))
		)
			return false;
		const names = yield* fs
			.readDirectory(directory)
			.pipe(
				Effect.mapError(
					(cause) => new NpmTarballInstallError({ reason: "cache", cause }),
				),
			);
		return (
			names.includes(executableName()) &&
			names.some((name) => name.endsWith(".d.ts"))
		);
	});

export const ensureTsLspBinary = (
	cacheDir: string,
	options?: TsLspBinaryInstallOptions,
): Effect.Effect<
	string,
	TsLspBinaryInstallError,
	| import("effect/FileSystem").FileSystem
	| ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const release = TS_LSP_RELEASES[`${process.platform}/${process.arch}`];
		if (release === undefined)
			return yield* new TsLspBinaryInstallError({
				reason: "unsupported-platform",
				cause: new Error(
					`no TypeScript ${TS_LSP_VERSION} integrity pin for ${process.platform}/${process.arch}`,
				),
			});
		const pinned: Release = { ...release, version: TS_LSP_VERSION };
		const directory = yield* ensureNpmTarball(
			join(cacheDir, TS_LSP_VERSION),
			pinned,
			{
				sourceDirectory: "package/lib",
				executable: executableName(),
				validate,
				downloadTarball: options?.downloadTarball,
			},
		).pipe(
			Effect.mapError(
				(error) =>
					new TsLspBinaryInstallError({
						reason: error.reason,
						cause: error.cause,
					}),
			),
		);
		return join(directory, executableName());
	});
