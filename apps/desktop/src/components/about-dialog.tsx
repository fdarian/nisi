"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "#/components/ui/dialog";

const REPO_URL = "https://github.com/fdarian/nisi";

type AboutDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/**
 * Replaces the native macOS about panel — muda hands AppKit an unattributed
 * `NSAttributedString` for `AboutMetadata.credits`, which can't render a
 * hyperlink, so the commit this build was produced from (`__APP_COMMIT_SHA__`,
 * injected by `vite.config.ts`) is shown here instead, linked to its GitHub
 * page. Opened by `useAboutDialog` in response to the app menu's "About nisi"
 * item (`src-tauri/src/lib.rs`).
 */
export function AboutDialog({
	open,
	onOpenChange,
}: AboutDialogProps): React.ReactElement {
	const shortSha = __APP_COMMIT_SHA__.slice(0, 7);
	const commitUrl = `${REPO_URL}/commit/${__APP_COMMIT_SHA__}`;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>About nisi</DialogTitle>
					<DialogDescription>Version {__APP_VERSION__}</DialogDescription>
				</DialogHeader>
				<DialogPanel scrollFade={false}>
					<span className="text-muted-foreground text-sm">
						Built from commit{" "}
						<Button
							className="h-auto p-0 align-baseline"
							onClick={() => void openUrl(commitUrl)}
							variant="link"
						>
							{shortSha}
						</Button>
					</span>
				</DialogPanel>
			</DialogContent>
		</Dialog>
	);
}
