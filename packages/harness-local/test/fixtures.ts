import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway directory for a test to use as a session's `defaultWorkingDirectory`. */
export const makeTempDir = (): Promise<string> =>
	mkdtemp(join(tmpdir(), "nisi-harness-local-test-"));

export const cleanupTempDir = (dir: string): Promise<void> =>
	rm(dir, { recursive: true, force: true });
