import { checkBinAvailability } from "@repo/bin-resolver";
import type { PublicAccessStatus } from "@repo/sidecar-api";
import {
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { emit } from "../events.ts";
import { parseTunnelUrl } from "./tunnel-url.ts";

export type PublicAccessOptions = {
	readonly port: number;
	readonly token: string;
	/** `NISI_WEB_DIR`; unset when the sidecar has no frontend bundle to serve. */
	readonly webDir: string | undefined;
};

type RunningTunnel = {
	/** Closing it kills the cloudflared process. */
	readonly scope: Scope.Closeable;
	readonly supervisor: Fiber.Fiber<void>;
};

const lines = <E>(bytes: Stream.Stream<Uint8Array, E>) =>
	Stream.splitLines(Stream.decodeText(bytes));

/**
 * Exposes the sidecar through a cloudflared quick tunnel while
 * `Settings.publicAccessEnabled` is on. The link it reports carries the
 * sidecar token, so it is a full-access capability; see
 * `packages/sidecar-api/src/public-access.ts`.
 */
export class PublicAccess extends Context.Service<PublicAccess>()(
	"sidecar/PublicAccess",
	{
		make: (options: PublicAccessOptions) =>
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const state = yield* Ref.make<PublicAccessStatus>({ type: "off" });
				const running = yield* Ref.make(Option.none<RunningTunnel>());
				// Serialises apply() calls, and keeps a tunnel's supervisor from
				// reporting an exit before start() has registered the tunnel.
				const lock = Semaphore.makeUnsafe(1);

				const transition = (next: PublicAccessStatus) =>
					Ref.set(state, next).pipe(
						Effect.andThen(
							Effect.sync(() => emit({ type: "public-access-changed" })),
						),
					);

				const stopRunning = Effect.gen(function* () {
					const tunnel = yield* Ref.getAndSet(running, Option.none());
					if (Option.isNone(tunnel)) return;
					yield* Scope.close(tunnel.value.scope, Exit.void);
					yield* Fiber.interrupt(tunnel.value.supervisor);
				});

				const reportUnexpectedExit = (scope: Scope.Closeable, reason: string) =>
					lock.withPermit(
						Effect.gen(function* () {
							const current = yield* Ref.get(running);
							if (Option.isNone(current) || current.value.scope !== scope) {
								return;
							}
							yield* Ref.set(running, Option.none());
							yield* Effect.logWarning("public tunnel exited", { reason });
							yield* transition({ type: "error", message: reason });
							// Not stopRunning: that would interrupt this very fiber.
							yield* Scope.close(scope, Exit.void);
						}),
					);

				const start = Effect.gen(function* () {
					if (Option.isSome(yield* Ref.get(running))) return;
					if (options.webDir === undefined) {
						return yield* transition({
							type: "error",
							message:
								"The web bundle is unavailable in this build, so there is nothing to serve.",
						});
					}
					const binary = checkBinAvailability(
						"cloudflared",
						"NISI_CLOUDFLARED_BIN",
					);
					if (binary.path === null) {
						return yield* transition({
							type: "error",
							message:
								"cloudflared is not installed. Install it (brew install cloudflared), then turn Public Access on again.",
						});
					}

					const cloudflared = binary.path;
					yield* transition({ type: "starting" });
					const scope = yield* Scope.make();
					yield* Effect.gen(function* () {
						const handle = yield* spawner
							.spawn(
								ChildProcess.make(
									cloudflared,
									[
										"tunnel",
										"--no-autoupdate",
										"--url",
										`http://127.0.0.1:${options.port}`,
									],
									{ stdin: "ignore" },
								),
							)
							.pipe(Scope.provide(scope));
						const lastLine = yield* Ref.make("");

						yield* Stream.runDrain(handle.stdout).pipe(
							Effect.ignore,
							Effect.forkIn(scope),
						);
						const supervisor = yield* Stream.runForEach(
							lines(handle.stderr),
							(line) =>
								Effect.gen(function* () {
									yield* Ref.set(lastLine, line);
									const url = parseTunnelUrl(line);
									if (url === undefined) return;
									const link = `${url}/#t=${options.token}`;
									const current = yield* Ref.get(state);
									if (current.type === "on" && current.link === link) return;
									yield* Effect.logInfo("public tunnel up", { url });
									yield* transition({ type: "on", link });
								}),
						).pipe(
							Effect.andThen(handle.exitCode),
							Effect.map((code) => `cloudflared exited with code ${code}`),
							// A signal-killed process fails `exitCode` instead of yielding one.
							Effect.catchTag("PlatformError", () =>
								Effect.succeed("cloudflared stopped unexpectedly"),
							),
							Effect.flatMap((reason) =>
								Ref.get(lastLine).pipe(
									Effect.flatMap((last) =>
										reportUnexpectedExit(
											scope,
											last === "" ? reason : `${reason}: ${last}`,
										),
									),
								),
							),
							Effect.forkDetach,
						);
						yield* Ref.set(running, Option.some({ scope, supervisor }));
					}).pipe(
						Effect.catchTag("PlatformError", (cause) =>
							Scope.close(scope, Exit.void).pipe(
								Effect.andThen(
									transition({
										type: "error",
										message: `Could not start cloudflared: ${cause.message}`,
									}),
								),
							),
						),
					);
				});

				const stop = Effect.gen(function* () {
					yield* stopRunning;
					if ((yield* Ref.get(state)).type !== "off") {
						yield* transition({ type: "off" });
					}
				});

				yield* Effect.addFinalizer(() => lock.withPermit(stopRunning));

				return {
					status: Ref.get(state),
					apply: (enabled: boolean) => lock.withPermit(enabled ? start : stop),
				};
			}),
	},
) {
	static layer = (options: PublicAccessOptions) =>
		Layer.effect(PublicAccess, PublicAccess.make(options));
}
