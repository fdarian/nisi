import type { PublicAccessStatus } from "@repo/sidecar-api";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import {
	usePublicAccessEnabled,
	usePublicAccessStatus,
} from "./public-access-data";
import { SettingsRow, SettingsSection } from "./settings-section";

export function PublicAccessPage(): React.ReactElement | null {
	const backend = useBackendContext();
	if (backend.status !== "ready") return null;
	return <PublicAccessContent orpc={backend.orpc} />;
}

function PublicAccessContent(props: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const enabledState = usePublicAccessEnabled(props.orpc);
	const status = usePublicAccessStatus(props.orpc);

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-8 py-12">
			<h1 className="font-semibold text-2xl tracking-tight">Public Access</h1>
			<SettingsSection>
				<SettingsRow
					description="Open nisi from any browser through a temporary cloudflared tunnel."
					title="Enable public access"
				>
					<Switch checked={enabledState[0]} onCheckedChange={enabledState[1]} />
				</SettingsRow>
				{status !== undefined && status.type !== "off" && (
					<StatusRows status={status} />
				)}
			</SettingsSection>
			<p className="text-muted-foreground text-sm">
				Anyone with this link has full access to nisi on this Mac. Restarting
				nisi invalidates the link.
			</p>
		</div>
	);
}

function StatusRows(props: {
	status: Exclude<PublicAccessStatus, { type: "off" }>;
}): React.ReactElement {
	const status = props.status;
	if (status.type === "error") {
		return (
			<SettingsRow title="Status">
				<span role="alert" className="text-destructive text-sm">
					{status.message}
				</span>
			</SettingsRow>
		);
	}
	if (status.type === "starting") {
		return (
			<SettingsRow title="Status">
				<span className="text-muted-foreground text-sm">Starting tunnel…</span>
			</SettingsRow>
		);
	}
	return (
		<>
			<SettingsRow title="Status">
				<span className="text-sm">On</span>
			</SettingsRow>
			<LinkRow link={status.link} />
		</>
	);
}

function LinkRow(props: { link: string }): React.ReactElement {
	const copyState = useState<"idle" | "copied" | "failed">("idle");
	const copy = copyState[0];
	const setCopy = copyState[1];

	return (
		<div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
			<div className="flex items-center gap-2">
				<Input readOnly value={props.link} aria-label="Public link" />
				<Button
					variant="outline"
					onClick={() => {
						navigator.clipboard.writeText(props.link).then(
							() => setCopy("copied"),
							() => setCopy("failed"),
						);
					}}
				>
					{copy === "copied" ? <CheckIcon /> : <CopyIcon />}
					{copy === "copied" ? "Copied" : "Copy"}
				</Button>
			</div>
			{copy === "failed" && (
				<p role="alert" className="text-destructive text-sm">
					Could not copy to the clipboard. Select the link and copy it by hand.
				</p>
			)}
		</div>
	);
}
