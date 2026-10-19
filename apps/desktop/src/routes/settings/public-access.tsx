import { createFileRoute } from "@tanstack/react-router";
import { PublicAccessPage } from "#/features/settings/public-access-page";

export const Route = createFileRoute("/settings/public-access")({
	component: PublicAccessPage,
});
