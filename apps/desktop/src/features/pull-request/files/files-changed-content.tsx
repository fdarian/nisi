import { AlertTriangleIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ComponentProps } from "react";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { FilesChangedSkeleton } from "./files-changed-skeleton";
import { FilesChangedView } from "./files-changed-view";

type FilesChangedContentProps = ComponentProps<typeof FilesChangedView> & {
	isLoading: boolean;
	error: unknown;
};

export function FilesChangedContent(
	props: FilesChangedContentProps,
): React.ReactElement {
	const reducedMotion = useReducedMotion();
	const state =
		props.error != null ? "error" : props.isLoading ? "loading" : "loaded";
	return (
		<div className="relative min-h-0 flex-1">
			<AnimatePresence initial={false}>
				<motion.div
					key={state}
					className="absolute inset-0 flex min-h-0"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
				>
					{state === "error" ? (
						<Empty className="flex-1">
							<EmptyMedia variant="icon">
								<AlertTriangleIcon />
							</EmptyMedia>
							<EmptyTitle>Couldn't load changed files</EmptyTitle>
							<EmptyDescription>
								{props.error instanceof Error
									? props.error.message
									: String(props.error)}
							</EmptyDescription>
						</Empty>
					) : state === "loading" ? (
						<FilesChangedSkeleton />
					) : (
						<FilesChangedView {...props} />
					)}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}
