import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "#/shell/app-shell";

export const Route = createFileRoute("/")({
	component: AppShell,
});
