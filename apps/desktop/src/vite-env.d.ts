/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Dev-only sidecar override — see apps/desktop/AGENTS.md, "Browser dev harness". */
	readonly VITE_DEV_BACKEND_PORT?: string;
	readonly VITE_DEV_BACKEND_TOKEN?: string;
}
