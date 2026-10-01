import { Switch } from "#/components/ui/switch";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import { osNotificationsAvailable } from "#/infra/os-notification";
import { NOTIFICATION_KINDS } from "./notification-kinds";
import {
	useNotificationsEnabled,
	useSettings,
	useUpdateSettings,
} from "./settings-data";
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
	const master = useNotificationsEnabled(props.orpc);
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
						checked={master[0]}
						onCheckedChange={master[1]}
					/>
				</SettingsRow>
				<TestNotificationRow
					disabled={!master[0] || !osNotificationsAvailable()}
				/>
			</SettingsSection>
			<section
				className="flex flex-col gap-2"
				aria-labelledby="general-notifications-title"
			>
				<h2
					className="px-3.5 font-medium text-sm tracking-tight"
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
								disabled={!master[0]}
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
