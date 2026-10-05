export const isEnoent = (error: unknown): boolean =>
	error instanceof Object && "code" in error && error.code === "ENOENT";
