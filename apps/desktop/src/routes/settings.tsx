import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { SettingsShell } from "#/features/settings/settings-shell";
import { useBackendContext } from "#/infra/backend-context";

export const Route = createFileRoute("/settings")({
	component: SettingsLayout,
});

function SettingsLayout(): React.ReactElement {
	const backend = useBackendContext();
	return (
		<SettingsShell>
			{backend.status === "loading" ? (
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<Spinner className="size-5" />
					</EmptyMedia>
					<EmptyTitle>Connecting to sidecar…</EmptyTitle>
				</Empty>
			) : backend.status === "error" ? (
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<AlertTriangleIcon />
					</EmptyMedia>
					<EmptyTitle>Couldn't reach the sidecar</EmptyTitle>
					<EmptyDescription>{backend.message}</EmptyDescription>
				</Empty>
			) : (
				<Outlet />
			)}
		</SettingsShell>
	);
}
