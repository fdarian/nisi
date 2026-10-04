import { launchTracePath } from "@repo/logging";
import { LaunchRecord } from "@repo/sidecar-api";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	bundlePath,
	cliPath,
	liveInstance,
	requireInstrumentation,
	unavailableAppPath,
} from "./instance.ts";

const RecordSchema = Schema.fromJsonString(LaunchRecord);

export function windowWentHidden(records: readonly LaunchRecord[]): boolean {
	const visibility = records.filter(
		(record) => record.type === "mark" && record.name === "frontend.visibility",
	);
	const visible = visibility.findIndex(
		(record) => record.attrs.hidden === false,
	);
	return (
		visible >= 0 &&
		visibility.slice(visible + 1).some((record) => record.attrs.hidden === true)
	);
}

export const runTracedOpen = (options: {
	cwd: string;
	dataDir: string;
	traceId: string;
	launch: boolean;
	managed: boolean;
	quiet: boolean;
	label: string;
}) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const file = launchTracePath(options.dataDir, options.traceId);
		const child = yield* Effect.try(() =>
			Bun.spawn([process.execPath, cliPath], {
				cwd: options.cwd,
				env: {
					...process.env,
					...(options.managed ? { NISI_MOCK_KEYCHAIN: "1" } : {}),
					NISI_LAUNCH_TRACE: options.traceId,
					NISI_DATA_DIR: options.dataDir,
					NISI_APP_PATH: options.launch ? bundlePath : unavailableAppPath,
				},
				stdout: options.quiet ? "ignore" : "inherit",
				stderr: "inherit",
			}),
		);
		const state: { exit?: number; probed: boolean } = {
			probed: !options.launch,
		};
		void child.exited.then((exit) => {
			state.exit = exit;
		});
		const readRecords = Effect.gen(function* () {
			if (!(yield* fs.exists(file))) return [] as LaunchRecord[];
			const text = yield* fs.readFileString(file);
			return yield* Effect.forEach(text.split("\n").slice(0, -1), (line) =>
				Schema.decodeUnknownEffect(RecordSchema)(line),
			);
		});
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (!state.probed) {
				const instance = yield* liveInstance(options.dataDir);
				if (instance.live) {
					yield* requireInstrumentation(instance.client);
					state.probed = true;
				}
			}
			const records = yield* readRecords;
			if (windowWentHidden(records))
				return yield* Effect.fail(
					new Error(
						`${options.label}: window went hidden; bring the measurement window forward and rerun. Trace: ${file}`,
					),
				);
			if (records.some((record) => record.name === "trace.done")) {
				const exit = yield* Effect.tryPromise(() => child.exited);
				if (exit !== 0)
					return yield* Effect.fail(new Error(`nisi exited with ${exit}`));
				return records;
			}
			if (state.exit !== undefined && state.exit !== 0)
				return yield* Effect.fail(
					new Error(`${options.label}: nisi exited with ${state.exit}`),
				);
			yield* Effect.sleep("100 millis");
		}
		if (state.exit === undefined) child.kill();
		return yield* Effect.fail(
			new Error(
				`${options.label}: timed out waiting for trace.done; keep the measurement window visible. Trace: ${file}`,
			),
		);
	});
