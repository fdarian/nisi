import { dlopen, FFIType } from "bun:ffi";

const libSystem = dlopen("libSystem.B.dylib", {
	responsibility_get_pid_responsible_for_pid: {
		args: [FFIType.i32],
		returns: FFIType.i32,
	},
});

/**
 * The pid Activity Monitor charges `pid` to. WebKit's WebContent, GPU and
 * Networking processes are XPC services parented to launchd, so the app that
 * owns them is only visible here. Undefined when the call fails, which is what
 * it does for processes we may not inspect (other users', root's).
 */
export function responsiblePid(pid: number): number | undefined {
	const responsible =
		libSystem.symbols.responsibility_get_pid_responsible_for_pid(pid);
	return responsible > 0 ? responsible : undefined;
}
