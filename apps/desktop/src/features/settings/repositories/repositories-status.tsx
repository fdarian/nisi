import { AlertTriangleIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";

export function LoadingState(): React.ReactElement {
	return (
		<div className="flex justify-center py-16">
			<Spinner className="size-5" />
		</div>
	);
}

export function ErrorState(props: {
	title: string;
	message: string;
	onRetry: () => void;
}): React.ReactElement {
	return (
		<Empty>
			<EmptyMedia variant="icon">
				<AlertTriangleIcon />
			</EmptyMedia>
			<EmptyTitle>{props.title}</EmptyTitle>
			<EmptyDescription>{props.message}</EmptyDescription>
			<Button onClick={props.onRetry} size="sm" variant="outline">
				Try again
			</Button>
		</Empty>
	);
}

export function EmptyState(props: {
	title: string;
	description: string;
}): React.ReactElement {
	return (
		<Empty>
			<EmptyTitle>{props.title}</EmptyTitle>
			<EmptyDescription>{props.description}</EmptyDescription>
		</Empty>
	);
}
