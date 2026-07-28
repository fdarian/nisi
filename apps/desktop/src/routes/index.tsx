import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleCheckIcon, CircleXIcon } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Spinner } from "#/components/ui/spinner";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useBackendContext } from "#/lib/backend-context";

export const Route = createFileRoute("/")({
	component: HomePage,
});

function HomePage() {
	const ctx = useBackendContext();

	return (
		<div className="flex size-full items-center justify-center p-8">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>nisi</CardTitle>
					<CardDescription>
						Desktop shell &lt;-&gt; sidecar connection
					</CardDescription>
				</CardHeader>
				<CardContent>
					{ctx.status === "loading" && <ConnectingState />}
					{ctx.status === "error" && <ErrorState message={ctx.message} />}
					{ctx.status === "ready" && (
						<ReadyState orpc={ctx.orpc} port={ctx.backend.port} />
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function ConnectingState() {
	return (
		<div className="flex items-center gap-2 text-muted-foreground text-sm">
			<Spinner className="size-4" />
			Waiting for the sidecar handshake…
		</div>
	);
}

function ErrorState({ message }: { message: string }) {
	return (
		<div className="flex items-start gap-2 text-destructive-foreground text-sm">
			<CircleXIcon className="mt-0.5 size-4 shrink-0" />
			<span>Backend unavailable: {message}</span>
		</div>
	);
}

function ReadyState({ orpc, port }: { orpc: SidecarQueryUtils; port: number }) {
	const health = useQuery(orpc.health.check.queryOptions());

	if (health.isPending) {
		return <ConnectingState />;
	}

	if (health.isError) {
		return <ErrorState message={health.error.message} />;
	}

	return (
		<div className="flex flex-col gap-3">
			<Badge variant="success">
				<CircleCheckIcon />
				{health.data.status}
			</Badge>
			<p className="text-muted-foreground text-sm">
				Round trip confirmed — the frontend reached the sidecar on port{" "}
				<span className="font-mono text-foreground">{port}</span> over the
				authed oRPC channel.
			</p>
		</div>
	);
}
