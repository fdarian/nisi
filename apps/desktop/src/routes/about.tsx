import { createFileRoute } from "@tanstack/react-router";
import { AboutPage } from "#/views/about/about-page";

export const Route = createFileRoute("/about")({
	component: AboutPage,
});
