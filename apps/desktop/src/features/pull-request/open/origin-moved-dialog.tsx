"use client";

import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	friendlyOpenPullRequestError,
	type OriginMovedPrompt,
} from "#/features/pull-request/data/pull-requests-data";

/**
 * Offered when the folder picked for a PR's repository is the right clone but
 * its `origin` still names the repo's old GitHub location. Confirming
 * repoints `origin` and re-opens the PR (`useOpenPullRequest`'s
 * `originMoved`); `prompt === null` keeps it closed so callers can mount it
 * unconditionally.
 */
export function OriginMovedDialog(props: {
	prompt: OriginMovedPrompt | null;
}): React.ReactElement {
	const prompt = props.prompt;
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open && prompt !== null && !prompt.isPending) prompt.cancel();
			}}
			open={prompt !== null}
		>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>This repository moved on GitHub</DialogTitle>
					<DialogDescription>
						{prompt === null ? null : (
							<>
								<code className="select-text break-all">
									{prompt.details.path}
								</code>
								's <code>origin</code> still points at{" "}
								<code>
									{prompt.details.actualOwner}/{prompt.details.actualRepo}
								</code>
								, which GitHub now serves as{" "}
								<code>
									{prompt.details.expectedOwner}/{prompt.details.expectedRepo}
								</code>
								. Update <code>origin</code> to the new location and open the
								pull request?
							</>
						)}
					</DialogDescription>
					{prompt !== null &&
						prompt.error !== null &&
						prompt.error !== undefined && (
							<p className="select-text text-destructive-foreground text-sm">
								{friendlyOpenPullRequestError(prompt.error)}
							</p>
						)}
				</DialogHeader>
				<DialogFooter>
					<Button
						disabled={prompt === null || prompt.isPending}
						onClick={() => prompt?.cancel()}
						variant="outline"
					>
						Cancel
					</Button>
					<Button
						loading={prompt?.isPending === true}
						onClick={() => prompt?.confirm()}
					>
						Update origin and open
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
