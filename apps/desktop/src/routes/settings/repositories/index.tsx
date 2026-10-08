import { createFileRoute } from "@tanstack/react-router";
import { RepositoriesPage } from "#/features/settings/repositories/repositories-page";

export const Route = createFileRoute("/settings/repositories/")({
	component: RepositoriesPage,
});
