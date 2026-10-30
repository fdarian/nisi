import path from "node:path";
import { resolveRepoRoot } from "@repo/git/repo";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FileSystem } from "effect/FileSystem";
import { recordCheck } from "./check.ts";
import { guideFolderOf } from "./folder.ts";
import { renderPreview } from "./preview.ts";
import { callGuideSidecar, describeGuideFailure } from "./sidecar.ts";

const baseFlag = Flag.String("base").pipe(
	Flag.withDescription(
		"Ref the diff is measured against. Default: origin/main when it isn't behind main, else main, else master.",
	),
	Flag.optional,
);

/** The repo the command was run in. Every `nisi guide` command works on that checkout's guide folder (see `guideFolderOf`). */
const currentRepoRoot = <E>(fail: Effect.Effect<never, E>) =>
	resolveRepoRoot(process.cwd()).pipe(
		Effect.catchTag("NotAGitRepository", () =>
			Console.error(`${process.cwd()} is not inside a git repository.`).pipe(
				Effect.andThen(fail),
			),
		),
	);

const describeBase = (diff: {
	base: string;
	mergeBase: string;
	changedFiles: number;
}) =>
	`base ${diff.base} (merge-base ${diff.mergeBase.slice(0, 7)}), ${diff.changedFiles} changed files`;

export const guideCommand = <E>(fail: Effect.Effect<never, E>) => {
	const guidePath = Command.make("path", {}, () =>
		Effect.gen(function* () {
			const repoRoot = yield* currentRepoRoot(fail);
			const folder = yield* guideFolderOf(repoRoot, fail);
			const fs = yield* FileSystem;
			yield* fs
				.makeDirectory(folder, { recursive: true })
				.pipe(
					Effect.catch((cause) =>
						Console.error(`could not create ${folder}: ${cause.message}`).pipe(
							Effect.andThen(fail),
						),
					),
				);
			const legacy = path.join(repoRoot, ".nisi/guide");
			if (yield* fs.exists(legacy)) {
				yield* Console.error(
					`${legacy} holds a guide from an earlier version. Move its files into ${folder} and remove ${legacy}.`,
				);
			}
			yield* Console.log(folder);
		}),
	).pipe(
		Command.withDescription(
			"Print the folder the guide goes in (guide.mdx, screenshots, components), creating it. Write the guide there: $(nisi guide path)/guide.mdx. The folder belongs to the repo and branch, not to the worktree. Needs no running app.",
		),
	);

	const check = Command.make(
		"check",
		{
			title: Argument.String("title"),
			command: Argument.String("command").pipe(Argument.variadic({ min: 1 })),
		},
		(options) =>
			Effect.gen(function* () {
				// Effect CLI folds what comes after `--` into the positionals, so the
				// separator is only visible in argv. Without it a multi-word title
				// would silently become the first words of the command.
				const separator = process.argv.indexOf("--");
				const checkIndex = process.argv.indexOf("check");
				if (separator !== checkIndex + 2) {
					yield* Console.error(
						'usage: nisi guide check "<Title>" -- <command…>   (the title is one argument)',
					);
					return yield* fail;
				}
				const repoRoot = yield* currentRepoRoot(fail);
				const guideFolder = yield* guideFolderOf(repoRoot, fail);
				const exitCode = yield* Effect.tryPromise(() =>
					recordCheck(repoRoot, guideFolder, options.title, options.command),
				).pipe(
					Effect.catch((cause) =>
						Console.error(`nisi guide check: ${String(cause.cause)}`).pipe(
							Effect.andThen(fail),
						),
					),
				);
				process.exitCode = exitCode;
			}),
	).pipe(
		Command.withDescription(
			"Run a command and record the result for the guide's <Checks /> in the guide folder (nisi guide path). nisi guide check \"Type check\" -- pnpm turbo run check:type. A single quoted argument after -- is a shell line (run with sh -c, for cd and &&). Exits with the command's exit code. Needs no running app.",
		),
	);

	const validate = Command.make("validate", { base: baseFlag }, (options) =>
		Effect.gen(function* () {
			const repoRoot = yield* currentRepoRoot(fail);
			const outcome = yield* callGuideSidecar((client, signal) =>
				client.guide.validate(
					{ repoRoot, base: Option.getOrUndefined(options.base) },
					{ signal },
				),
			);
			if (outcome._tag !== "ok") {
				yield* Console.error(describeGuideFailure(outcome));
				return yield* fail;
			}
			const report = outcome.data;
			const errors = report.issues.filter((issue) => issue.level === "error");
			if (report.issues.length === 0) {
				return yield* Console.log(`Guide is valid. ${describeBase(report)}.`);
			}
			yield* Console.error(
				`${report.issues.length} problem${report.issues.length === 1 ? "" : "s"} in the guide (${describeBase(report)}):\n`,
			);
			for (const issue of report.issues) {
				yield* Console.error(
					`- ${issue.level === "warning" ? "warning: " : ""}${issue.message}`,
				);
			}
			if (errors.length > 0) return yield* fail;
		}),
	).pipe(
		Command.withDescription(
			"Check the guide the way the Guide tab will show it, plus what only the author can fix: changed code no Area covers, Refs to lines outside the diff, stale checks. Exits non-zero on any error. Launches the app if it isn't running.",
		),
	);

	const render = Command.make(
		"render",
		{
			expand: Flag.Boolean("expand").pipe(
				Flag.withDescription(
					"Stack every Tour frame, show both Sequence states, open the Area file lists.",
				),
				Flag.withDefault(false),
			),
			text: Flag.Boolean("text").pipe(
				Flag.withDescription(
					"Print what a reader would take from the page as plain text (always expanded). Launches no browser.",
				),
				Flag.withDefault(false),
			),
			theme: Flag.Literals("theme", ["light", "dark"]).pipe(
				Flag.withDefault("light"),
			),
			width: Flag.Int("width").pipe(
				Flag.withDescription("Page width in CSS px."),
				Flag.withDefault(900),
			),
			scale: Flag.Finite("scale").pipe(
				Flag.withDescription("Device scale factor."),
				Flag.withDefault(2),
			),
			base: baseFlag,
		},
		(options) =>
			Effect.gen(function* () {
				if (options.width <= 0 || options.scale <= 0) {
					yield* Console.error("--width and --scale need a positive number");
					return yield* fail;
				}
				const repoRoot = yield* currentRepoRoot(fail);
				const outcome = yield* callGuideSidecar((client, signal) =>
					client.guide.preview(
						{
							repoRoot,
							base: Option.getOrUndefined(options.base),
							expand: options.text || options.expand,
							withCss: !options.text,
						},
						{ signal },
					),
				);
				if (outcome._tag !== "ok") {
					yield* Console.error(describeGuideFailure(outcome));
					return yield* fail;
				}
				const preview = outcome.data;
				if (options.text) {
					yield* Console.error(describeBase(preview));
					return yield* Effect.sync(() => process.stdout.write(preview.text));
				}
				if (preview.css === undefined) {
					yield* Console.error("the sidecar returned no stylesheet");
					return yield* fail;
				}
				const css = preview.css;
				const guideDir = yield* guideFolderOf(repoRoot, fail);
				const shots = yield* Effect.tryPromise(() =>
					renderPreview({
						guideDir,
						html: preview.html,
						css,
						theme: options.theme,
						width: options.width,
						scale: options.scale,
					}),
				).pipe(
					Effect.catch((cause) =>
						Console.error(String(cause.cause)).pipe(Effect.andThen(fail)),
					),
				);
				yield* Console.log(
					`${options.theme}${options.expand ? ", expanded" : ""}, ${options.width}px wide. ${describeBase(preview)}:`,
				);
				for (const shot of shots.screenshots) yield* Console.log(shot);
				yield* Console.log(`(page: ${shots.pagePath})`);
			}),
	).pipe(
		Command.withDescription(
			"Preview the guide as the reader sees it: one PNG per ## section plus full.png in .preview/ inside the guide folder (nisi guide path), taken by a freshly launched headless Chrome. Launches the app if it isn't running.",
		),
	);

	return Command.make("guide", {}, () =>
		Console.error(
			"Specify a subcommand: nisi guide path|check|validate|render (see nisi guide --help)",
		).pipe(Effect.andThen(fail)),
	).pipe(
		Command.withDescription(
			"Author the walkthrough guide, kept in a folder per repo and branch (nisi guide path): record checks, validate it against the diff, preview it. On a dev build, point NISI_DATA_DIR at the dev sandbox (or run the CLI from source).",
		),
		Command.withSubcommands([guidePath, check, validate, render]),
	);
};
