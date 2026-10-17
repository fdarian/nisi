import { createFileRoute } from "@tanstack/react-router";
import { FeatureFlagsPage } from "#/features/settings/feature-flags-page";

export const Route = createFileRoute("/settings/feature-flags")({
	component: FeatureFlagsPage,
});
