import { SparklesIcon } from "lucide-react";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";

export function WalkthroughEmptyState(): React.ReactElement {
	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<SparklesIcon />
			</EmptyMedia>
			<EmptyTitle>Walkthrough</EmptyTitle>
			<EmptyDescription>
				The agent-narrated walkthrough arrives in a later phase.
			</EmptyDescription>
		</Empty>
	);
}
