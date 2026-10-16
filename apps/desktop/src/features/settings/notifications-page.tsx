import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import { hasNative, native } from "#/infra/native";
import { NOTIFICATION_KINDS } from "./notification-kinds";
import { useSettings, useUpdateSettings } from "./settings-data";
import { SettingsRow, SettingsSection } from "./settings-section";
import { TestNotificationRow } from "./test-notification-row";

export function NotificationsPage(): React.ReactElement | null {
	const backend = useBackendContext();
	if (backend.status !== "ready") return null;
	return <NotificationsContent orpc={backend.orpc} />;
}

function NotificationsContent(props: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const query = useSettings(props.orpc);
	const update = useUpdateSettings(props.orpc);
	const openErrorState = useState<string | null>(null);
	const openError = openErrorState[0];
	const setOpenError = openErrorState[1];
	const toggle = useMutation({
		mutationFn: async (enabled: boolean) => {
			update({ notificationsEnabled: enabled });
		},
	});
	const enabled = query.settings.notificationsEnabled;
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-8 py-12">
			<h1 className="font-semibold text-2xl tracking-tight">Notifications</h1>
			<SettingsSection>
				<SettingsRow
					title="Enable notifications"
					description="System notifications appear only when nisi isn't focused."
				>
					<Switch
						aria-label="Enable notifications"
						checked={enabled}
						disabled={!hasNative() || toggle.isPending}
						onCheckedChange={(checked) => toggle.mutate(checked)}
					/>
				</SettingsRow>
				{!hasNative() && (
					<p className="px-3.5 text-muted-foreground text-sm">
						Available in the installed app.
					</p>
				)}
				{hasNative() && (
					<div className="flex items-center justify-between gap-4 px-3.5 py-2">
						<p className="text-muted-foreground text-sm">
							Notifications not showing up? Allow nisi in System Settings.
						</p>
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setOpenError(null);
								void native()
									.openUrl(
										"x-apple.systempreferences:com.apple.Notifications-Settings.extension",
									)
									.catch((error: unknown) => setOpenError(String(error)));
							}}
						>
							Open System Settings
						</Button>
					</div>
				)}
				{(toggle.error || openError) && (
					<p role="alert" className="px-3.5 text-destructive text-sm">
						{String(toggle.error || openError)}
					</p>
				)}
				<TestNotificationRow
					disabled={!enabled || !hasNative()}
					className="pt-6"
				/>
			</SettingsSection>
			<section
				className="flex flex-col gap-2"
				aria-labelledby="general-notifications-title"
			>
				<h2
					className="font-medium text-sm tracking-tight"
					id="general-notifications-title"
				>
					General notifications
				</h2>
				<SettingsSection>
					{NOTIFICATION_KINDS.map((kind) => (
						<SettingsRow
							key={kind.id}
							title={kind.label}
							description={kind.description}
						>
							<Switch
								aria-label={kind.label}
								checked={query.settings[kind.settingsKey]}
								disabled={!enabled}
								onCheckedChange={(enabled) =>
									update({ [kind.settingsKey]: enabled })
								}
							/>
						</SettingsRow>
					))}
				</SettingsSection>
			</section>
		</div>
	);
}
