"use client";

import type { GuideCheck } from "@repo/sidecar-api";
import { useQuery } from "@tanstack/react-query";
import {
	Component,
	type ErrorInfo,
	type ReactNode,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import type { Session } from "#/features/pull-request/data/pr-data";
import { useFileChanges } from "#/features/pull-request/data/pr-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { evaluateGuide } from "./evaluate";
import { GUIDE_COMPONENTS } from "./guide-components";
import { GuideProvider } from "./guide-context";
import { GuideToc } from "./guide-toc";
import { ReferenceSidePane } from "./reference-side-pane";
import type { GuideRef } from "./refs";

const POLL_MS = 2000;

/**
 * The Guide tab: `<repoRoot>/.nisi/guide/guide.mdx`, bundled by the sidecar and
 * evaluated here against the app's own React and kit. Polls while mounted so
 * an agent's edits show up within a couple of seconds.
 */
export function GuideView(props: {
	orpc: SidecarQueryUtils;
	session: Session;
	enabled: boolean;
}): React.ReactElement {
	const [selectedRef, setSelectedRef] = useState<GuideRef | null>(null);
	const guide = useQuery({
		...props.orpc.guide.get.queryOptions({
			input: { sessionId: props.session.id },
		}),
		refetchInterval: props.enabled ? POLL_MS : false,
	});

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
			headSha={result.headSha}
			onSelectRef={setSelectedRef}
			orpc={props.orpc}
			selectedRef={selectedRef}
			session={props.session}
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
	headSha: string;
	selectedRef: GuideRef | null;
	onSelectRef: (ref: GuideRef | null) => void;
}): React.ReactElement {
	const files = useFileChanges(props.orpc, props.session.id).files;
	const changedPaths = useMemo(
		() => new Set(files.map((file) => file.path)),
		[files],
	);
	const onSelectRef = props.onSelectRef;
	const selectRef = useCallback(
		(ref: GuideRef) => onSelectRef(ref),
		[onSelectRef],
	);
	const closeRef = useCallback(() => onSelectRef(null), [onSelectRef]);
	const context = useMemo(
		() => ({
			sessionId: props.session.id,
			changedPaths,
			checks: props.checks,
			headSha: props.headSha,
			selectedRef: props.selectedRef,
			selectRef,
		}),
		[
			props.session.id,
			changedPaths,
			props.checks,
			props.headSha,
			props.selectedRef,
			selectRef,
		],
	);
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);

	return (
		<div className="flex min-h-0 flex-1">
			<div
				className="@container min-h-0 min-w-0 flex-1 overflow-auto px-6 py-5"
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
					{props.selectedRef === null && (
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
			{props.selectedRef !== null && (
				<ReferenceSidePane
					files={files}
					onClose={closeRef}
					orpc={props.orpc}
					reference={props.selectedRef}
					sessionId={props.session.id}
				/>
			)}
		</div>
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
