import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "#/views/frame/app-shell";

export const Route = createFileRoute("/")({
	component: AppShell,
});
