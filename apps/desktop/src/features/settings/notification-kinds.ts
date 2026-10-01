import type { Settings } from "./settings-data";

type NotificationKind = {
	id: string;
	label: string;
	description: string;
	settingsKey: keyof Pick<Settings, "notifyScheduledMergeSettled">;
};

export const NOTIFICATION_KINDS = [
	{
		id: "scheduledMergeSettled",
		label: "Auto-merge settled",
		description:
			"When a scheduled auto-merge completes, fails, or is cancelled.",
		settingsKey: "notifyScheduledMergeSettled",
	},
] as const satisfies readonly NotificationKind[];
