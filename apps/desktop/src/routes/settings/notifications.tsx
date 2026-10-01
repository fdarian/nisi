import { createFileRoute } from "@tanstack/react-router";
import { NotificationsPage } from "#/features/settings/notifications-page";

export const Route = createFileRoute("/settings/notifications")({
	component: NotificationsPage,
});
