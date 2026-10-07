import { cn } from "cn";
import { AlertTriangleIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ComponentProps, useCallback, useEffect, useState } from "react";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { FilesChangedSkeleton } from "./files-changed-skeleton";
import { FilesChangedView } from "./files-changed-view";

/** How long the skeleton waits for the first diff card before revealing whatever the view shows — a slow `diff.fileContents` should surface as dimmed "Loading diff…" cards, not an endless skeleton. */
const REVEAL_TIMEOUT_MS = 1500;

type FilesChangedContentProps = Omit<
	ComponentProps<typeof FilesChangedView>,
	"onFirstCardPainted" | "countsRevealed"
> & {
	isLoading: boolean;
	error: unknown;
	/** Whether the files tab is on screen, gating the launch-trace loading paint. */
	isVisible: boolean;
};

export function FilesChangedContent(
	props: FilesChangedContentProps,
): React.ReactElement {
	return (
		<div className="relative min-h-0 flex-1">
			<AnimatePresence initial={false}>
				<motion.div
					key={props.error != null ? "error" : "content"}
					className="absolute inset-0 flex min-h-0"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.2, ease: "easeOut" }}
				>
					{props.error != null ? (
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
					) : (
						<FilesChangedReveal {...props} />
					)}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}

/**
 * The view mounts as soon as `diff.files` settles — Pierre's worker pool only
 * starts warming once `DiffCodeView` mounts, and until it's ready Pierre
 * paints nothing, not even placeholders. The skeleton stays overlaid on top
 * (opaque, same chrome geometry) with the view's data hidden underneath, then
 * crossfades out once the first card has painted. The view must stay in layout
 * the whole time (opacity only, never `display: none`) or Pierre can't measure.
 */
function FilesChangedReveal(
	props: FilesChangedContentProps,
): React.ReactElement {
	const reducedMotion = useReducedMotion();
	const [revealed, setRevealed] = useState(false);
	const [skeletonGone, setSkeletonGone] = useState(false);
	const reveal = useCallback(() => setRevealed(true), []);
	const settled = !props.isLoading;

	// Reset in render, not an effect: the view unmounts the same render
	// `settled` flips, so an effect-driven reset would leave one blank frame.
	const [wasSettled, setWasSettled] = useState(settled);
	if (settled !== wasSettled) {
		setWasSettled(settled);
		if (!settled) {
			setRevealed(false);
			setSkeletonGone(false);
		}
	}

	useEffect(() => {
		if (!settled) return;
		const timeout = setTimeout(reveal, REVEAL_TIMEOUT_MS);
		return () => clearTimeout(timeout);
	}, [settled, reveal]);

	const duration = reducedMotion ? 0 : 0.2;
	return (
		<>
			{settled && (
				<motion.div
					className="absolute inset-0 flex min-h-0"
					initial={{ "--files-data-opacity": 0 }}
					animate={{ "--files-data-opacity": revealed ? 1 : 0 }}
					transition={{ duration, ease: "easeOut" }}
				>
					<FilesChangedView
						{...props}
						countsRevealed={revealed}
						onFirstCardPainted={reveal}
					/>
				</motion.div>
			)}
			{!(revealed && skeletonGone) && (
				<motion.div
					className={cn(
						"absolute inset-0 flex min-h-0 pointer-events-none",
						revealed && "pointer-events-none",
					)}
					initial={false}
					animate={{ opacity: revealed ? 0 : 1 }}
					transition={{ duration, ease: "easeOut" }}
					onAnimationComplete={() => {
						if (revealed) setSkeletonGone(true);
					}}
				>
					<FilesChangedSkeleton
						orpc={props.orpc}
						toolbarVisible={!settled}
						when={props.isVisible && !settled}
						sessionId={props.session.id}
					/>
				</motion.div>
			)}
		</>
	);
}
