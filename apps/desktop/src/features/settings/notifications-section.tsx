import { Switch } from "#/components/ui/switch";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { osNotificationsAvailable } from "#/infra/os-notification";
import { NOTIFICATION_KINDS } from "./notification-kinds";
import {
	useNotificationsEnabled,
	useSettings,
	useUpdateSettings,
} from "./settings-data";
import { SettingsRow, SettingsSection } from "./settings-section";
import { TestNotificationButton } from "./test-notification-button";

export function NotificationsSection(props: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const query = useSettings(props.orpc);
	const update = useUpdateSettings(props.orpc);
	const master = useNotificationsEnabled(props.orpc);
	return (
		<SettingsSection title="Notifications">
			<SettingsRow
				title="Show system notifications"
				description="System notifications appear only when nisi isn't focused."
			>
				<Switch
					aria-label="Show system notifications"
					checked={master[0]}
					onCheckedChange={master[1]}
				/>
			</SettingsRow>
			<SettingsRow
				title="Test notification"
				description="Sends a sample notification after 5 seconds. Switch to another app to see it as a banner."
			>
				<TestNotificationButton
					disabled={!master[0] || !osNotificationsAvailable()}
				/>
			</SettingsRow>
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
	);
}
