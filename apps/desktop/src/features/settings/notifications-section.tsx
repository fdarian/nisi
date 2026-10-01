import { Button } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import {
	osNotificationsAvailable,
	sendOsNotification,
} from "#/infra/os-notification";
import { NOTIFICATION_KINDS } from "./notification-kinds";
import {
	useNotificationsEnabled,
	useSettings,
	useUpdateSettings,
} from "./settings-data";
import { SettingsRow, SettingsSection } from "./settings-section";

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
				description="Send a sample notification to check that macOS shows them for nisi."
			>
				<Button
					disabled={!master[0] || !osNotificationsAvailable()}
					onClick={() =>
						sendOsNotification({
							title: "nisi",
							body: "Notifications are working.",
						})
					}
					size="sm"
					variant="outline"
				>
					Send test
				</Button>
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
