import { invoke } from "@tauri-apps/api/core";

type BackendInfo = {
	port: number;
	token: string;
};

/** Invoke the Rust get_backend command to get sidecar connection info. Throws on failure. */
async function getBackend(): Promise<BackendInfo> {
	return invoke<BackendInfo>("get_backend");
}

export type { BackendInfo };
export { getBackend };
