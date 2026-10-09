"use client";

import type { GuideCheck, GuideSymbol } from "@repo/sidecar-api";
import {
	Component,
	type ErrorInfo,
	type ReactNode,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "#/components/ui/empty";
import { ResizablePanel, ResizablePanelGroup } from "#/components/ui/resizable";
import { Spinner } from "#/components/ui/spinner";
import type {
	FileChange,
	ReviewStateEntry,
	Session,
} from "#/features/pull-request/data/pr-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import type { GuideFile } from "./areas";
import { evaluateGuide } from "./evaluate";
import { GUIDE_COMPONENTS } from "./guide-components";
import { GuideProvider } from "./guide-context";
import { GuideDiffPane } from "./guide-diff-pane";
import { GuideResizeHandle } from "./guide-resize-handle";
import { useGuideReviews } from "./guide-reviews";
import type { GuideTarget } from "./guide-target";
import { GuideToc } from "./guide-toc";
import type { GuideRef } from "./refs";
import { symbolMap } from "./symbol-links";
import { useGuide } from "./use-guide";

const SPLIT_STORAGE_ID = "nisi:guide-split";
const CONTENT_PANEL = "content";
const DIFF_PANEL = "diff";
const CONTENT_MIN_WIDTH = "360px";
const DIFF_MIN_WIDTH = "380px";
const DIFF_DEFAULT_SIZE = "46%";

/**
 * The Guide tab: `<repoRoot>/.nisi/guide/guide.mdx`, bundled by the sidecar and
 * evaluated here against the app's own React and kit. Polls faster while
 * visible so an agent's edits show up within a couple of seconds.
 */
export function GuideView(props: {
	orpc: SidecarQueryUtils;
	session: Session;
	enabled: boolean;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	setViewed: (path: string, viewed: boolean) => void;
	onOpenFile: (path: string) => void;
}): React.ReactElement {
	const [target, setTarget] = useState<GuideTarget | null>(null);
	const guide = useGuide(props.orpc, props.session.id, props.enabled);

	if (guide.error != null) {
		return (
			<GuideMessage title="Couldn't load the guide">
				{guide.error instanceof Error
					? guide.error.message
					: String(guide.error)}
			</GuideMessage>
		);
	}
	if (guide.data === undefined) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
				<Spinner /> Loading guide…
			</div>
		);
	}
	const result = guide.data;
	if (result.kind === "missing") {
		return (
			<GuideMessage title="No guide yet">
				Ask your agent to write one to{" "}
				<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
					{result.path}
				</code>
				.
			</GuideMessage>
		);
	}
	if (result.kind === "error") {
		return (
			<GuideMessage title="The guide doesn't build" tone="error">
				{result.message}
			</GuideMessage>
		);
	}
	return (
		<GuideBody
			checks={result.checks}
			code={result.code}
			files={props.files}
			symbols={result.symbols}
			headSha={result.headSha}
			onOpenFile={props.onOpenFile}
			onSelectTarget={setTarget}
			orpc={props.orpc}
			reviewState={props.reviewState}
			session={props.session}
			setViewed={props.setViewed}
			target={target}
			version={result.version}
		/>
	);
}

function GuideBody(props: {
	orpc: SidecarQueryUtils;
	session: Session;
	version: string;
	code: string;
	checks: readonly GuideCheck[];
	symbols: readonly GuideSymbol[];
	headSha: string;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	setViewed: (path: string, viewed: boolean) => void;
	onOpenFile: (path: string) => void;
	target: GuideTarget | null;
	onSelectTarget: (target: GuideTarget | null) => void;
}): React.ReactElement {
	const files = props.files;
	const changedPaths = useMemo(
		() => new Set(files.map((file) => file.path)),
		[files],
	);
	const guideFiles = useMemo(
		() =>
			files.map(
				(file): GuideFile => ({
					path: file.path,
					additions: file.additions,
					deletions: file.deletions,
					hunks: file.hunks,
					generated: file.category === "generated",
				}),
			),
		[files],
	);
	const onSelectTarget = props.onSelectTarget;
	const selectRef = useCallback(
		(ref: GuideRef, scope?: readonly string[], span?: GuideTarget["span"]) =>
			onSelectTarget({ ref, scope: scope ?? null, span }),
		[onSelectTarget],
	);
	const closePane = useCallback(() => onSelectTarget(null), [onSelectTarget]);
	const selectedRef = props.target === null ? null : props.target.ref;
	const symbols = useMemo(() => symbolMap(props.symbols), [props.symbols]);
	const reviews = useGuideReviews({
		orpc: props.orpc,
		sessionId: props.session.id,
		files,
		reviewState: props.reviewState,
		setViewed: props.setViewed,
	});
	const [areaOrder, setAreaOrder] = useState<readonly string[]>([]);
	const [hoveredArea, setHoveredArea] = useState<string | null>(null);
	const context = useMemo(
		() => ({
			sessionId: props.session.id,
			files: guideFiles,
			changedPaths,
			checks: props.checks,
			headSha: props.headSha,
			selectedRef,
			selectRef,
			symbols,
			reviews,
			areaOrder,
			setAreaOrder,
			hoveredArea,
			setHoveredArea,
		}),
		[
			props.session.id,
			guideFiles,
			changedPaths,
			props.checks,
			props.headSha,
			selectedRef,
			selectRef,
			symbols,
			reviews,
			areaOrder,
			hoveredArea,
		],
	);
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);

	const layout = useDefaultLayout({
		id: SPLIT_STORAGE_ID,
		panelIds:
			props.target === null ? [CONTENT_PANEL] : [CONTENT_PANEL, DIFF_PANEL],
		storage: localStorage,
	});

	return (
		<ResizablePanelGroup
			className="min-h-0 flex-1"
			defaultLayout={layout.defaultLayout}
			onLayoutChanged={layout.onLayoutChanged}
			orientation="horizontal"
		>
			<ResizablePanel id={CONTENT_PANEL} minSize={CONTENT_MIN_WIDTH}>
				<div
					className="@container h-full min-h-0 min-w-0 overflow-auto px-6 py-5"
					ref={scroller}
				>
					<div className="relative mx-auto max-w-3xl">
						<div
							className="flex flex-col gap-3 pb-12 text-foreground text-sm leading-relaxed"
							ref={content}
						>
							<GuideProvider value={context}>
								<GuideErrorBoundary resetKey={props.version}>
									<EvaluatedGuide code={props.code} version={props.version} />
								</GuideErrorBoundary>
							</GuideProvider>
						</div>
						{props.target === null && (
							<aside className="absolute top-0 left-full ml-8 hidden h-full w-44 @5xl:block">
								<div className="sticky top-0">
									<GuideToc
										content={content}
										scroller={scroller}
										version={props.version}
									/>
								</div>
							</aside>
						)}
					</div>
				</div>
			</ResizablePanel>
			{props.target !== null && (
				<>
					<GuideResizeHandle onCollapse={closePane} />
					<ResizablePanel
						defaultSize={DIFF_DEFAULT_SIZE}
						id={DIFF_PANEL}
						minSize={DIFF_MIN_WIDTH}
					>
						<GuideDiffPane
							files={files}
							onClose={closePane}
							onOpenFile={props.onOpenFile}
							orpc={props.orpc}
							reviewState={props.reviewState}
							session={props.session}
							setViewed={props.setViewed}
							target={props.target}
						/>
					</ResizablePanel>
				</>
			)}
		</ResizablePanelGroup>
	);
}

function EvaluatedGuide(props: {
	version: string;
	code: string;
}): React.ReactElement {
	const Guide = evaluateGuide(props.version, props.code);
	return <Guide components={GUIDE_COMPONENTS as never} />;
}

type BoundaryProps = { resetKey: string; children: ReactNode };

/** A guide that throws while evaluating or rendering shows the error in place of itself; a new `version` (the author's next save) retries. */
class GuideErrorBoundary extends Component<
	BoundaryProps,
	{ error: Error | null; resetKey: string }
> {
	state = { error: null as Error | null, resetKey: this.props.resetKey };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	static getDerivedStateFromProps(
		props: BoundaryProps,
		state: { error: Error | null; resetKey: string },
	) {
		if (props.resetKey === state.resetKey) return null;
		return { error: null, resetKey: props.resetKey };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("guide failed to render", error, info.componentStack);
	}

	render() {
		if (this.state.error === null) return this.props.children;
		return (
			<GuideMessage title="The guide failed to render" tone="error">
				{this.state.error.message}
			</GuideMessage>
		);
	}
}

function GuideMessage(props: {
	title: string;
	tone?: "error";
	children: ReactNode;
}): React.ReactElement {
	return (
		<Empty>
			<EmptyHeader>
				<EmptyTitle>{props.title}</EmptyTitle>
				<EmptyDescription
					className={
						props.tone === "error"
							? "max-w-full whitespace-pre-wrap text-left font-mono text-destructive-foreground text-xs"
							: undefined
					}
				>
					{props.children}
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
