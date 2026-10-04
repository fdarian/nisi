import type React from "react";
import { Empty, EmptyMedia, EmptyTitle } from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { markFilesLoadingPainted } from "#/infra/launch-trace";

export function FilesChangedLoading(props: {
	when?: boolean;
	sessionId?: string;
}): React.ReactElement<React.ComponentProps<typeof Empty>> {
	return (
		<Empty
			className="flex-1"
			ref={(node) => {
				if (node !== null && props.when !== false)
					markFilesLoadingPainted(node, props.sessionId);
			}}
		>
			<EmptyMedia variant="icon">
				<Spinner className="size-5" />
			</EmptyMedia>
			<EmptyTitle>Loading changed files…</EmptyTitle>
		</Empty>
	);
}
