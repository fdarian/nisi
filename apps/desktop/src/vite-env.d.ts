/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** Dev-only sidecar override — see apps/desktop/AGENTS.md, "Browser dev harness". */
	readonly VITE_DEV_BACKEND_PORT?: string;
	readonly VITE_DEV_BACKEND_TOKEN?: string;
}

/** Injected by `vite.config.ts`'s `define` block — the running build's app version and commit, shown in `about-dialog.tsx`. */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT_SHA__: string;
