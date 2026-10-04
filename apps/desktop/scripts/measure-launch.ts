import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	type LaunchMark,
	traceFilePath,
} from "../sidecar/launch-trace/file-writer.ts";
import { formatTimeline } from "./measure-launch-format.ts";
import { appProcessIds } from "./measure-launch-processes.ts";

const Mark = Schema.fromJsonString(
	Schema.Record(Schema.String, Schema.Unknown),
);
const program = Effect.gen(function* () {
	const options = {
		cwd: process.cwd(),
		nisi: "nisi",
		cold: false,
		json: false,
		args: [] as string[],
	};
	const argv = process.argv.slice(2);
	for (const [index, arg] of argv.entries()) {
		if (arg === "--") {
			options.args = argv.slice(index + 1);
			break;
		}
		const previous = argv[index - 1];
		if (previous !== undefined && ["--cwd", "--nisi"].includes(previous))
			continue;
		if (arg === "--cold") options.cold = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--cwd" || arg === "--nisi") {
			const value = argv[index + 1];
			if (value === undefined)
				return yield* Effect.fail(new Error(`${arg} requires a value`));
			if (arg === "--cwd") options.cwd = resolve(value);
			else options.nisi = value;
		} else return yield* Effect.fail(new Error(`Unknown option: ${arg}`));
	}
	const override = Option.getOrUndefined(
		yield* Config.string("NISI_DATA_DIR").pipe(Config.option),
	);
	const dataDir =
		override === undefined
			? join(homedir(), "Library", "Application Support", "com.nisi.desktop")
			: override;
	if (options.cold && override !== undefined)
		return yield* Effect.fail(
			new Error(
				"--cold is not applicable to a dev sandbox (NISI_DATA_DIR is set).",
			),
		);
	if (options.cold) {
		const appOverride = Option.getOrUndefined(
			yield* Config.string("NISI_APP_PATH").pipe(Config.option),
		);
		const appPaths =
			appOverride === undefined
				? [
						"/Applications/nisi.app",
						resolve(
							import.meta.dir,
							"../src-tauri/target/release/bundle/macos/nisi.app",
						),
					]
				: [resolve(appOverride)];
		const ps = yield* Effect.tryPromise(() => Bun.$`ps -axo pid=,comm=`.text());
		const pids = appProcessIds(ps, appPaths);
		for (const pid of pids)
			yield* Effect.try(() => process.kill(pid, "SIGTERM"));
		const deadline = Date.now() + 10_000;
		while (pids.length > 0) {
			const remaining = yield* Effect.tryPromise(() =>
				Bun.$`ps -axo pid=`.text(),
			);
			const live = new Set(remaining.trim().split(/\s+/).map(Number));
			if (pids.every((pid) => !live.has(pid))) break;
			if (Date.now() >= deadline)
				return yield* Effect.fail(
					new Error(
						"App did not exit after SIGTERM; refusing cold measurement.",
					),
				);
			yield* Effect.sleep("100 millis");
		}
	}
	const traceId = crypto.randomUUID();
	const file = traceFilePath(dataDir, traceId);
	const child = yield* Effect.try(() =>
		Bun.spawn([options.nisi, ...options.args], {
			cwd: options.cwd,
			env: {
				...process.env,
				NISI_LAUNCH_TRACE: traceId,
				NISI_DATA_DIR: dataDir,
			},
			stdout: options.json ? "ignore" : "inherit",
			stderr: "inherit",
		}),
	);
	const fs = yield* FileSystem;
	const deadline = Date.now() + 60_000;
	const readMarks = Effect.gen(function* () {
		if (!(yield* fs.exists(file))) return [] as LaunchMark[];
		const text = yield* fs.readFileString(file);
		const lines = text.split("\n").slice(0, -1);
		return yield* Effect.forEach(lines, (line) =>
			Schema.decodeUnknownEffect(Mark)(line).pipe(
				Effect.flatMap((mark) => {
					if (
						typeof mark.at !== "number" ||
						typeof mark.name !== "string" ||
						!["cli", "sidecar", "frontend"].includes(String(mark.source))
					)
						return Effect.fail(new Error("Invalid launch mark"));
					return Effect.succeed(mark as LaunchMark);
				}),
			),
		);
	});
	while (Date.now() < deadline) {
		const marks = yield* readMarks;
		if (marks.some((mark) => mark.name === "trace.done")) break;
		yield* Effect.sleep("100 millis");
	}
	const marks = yield* readMarks;
	yield* Console.log(
		options.json ? JSON.stringify(marks, null, 2) : formatTimeline(marks),
	);
	if (!marks.some((mark) => mark.name === "trace.done")) {
		child.kill();
		return yield* Effect.fail(new Error(`Launch trace timed out: ${file}`));
	}
	const exit = yield* Effect.tryPromise(() => child.exited);
	if (exit !== 0)
		return yield* Effect.fail(new Error(`nisi exited with ${exit}`));
});
BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
