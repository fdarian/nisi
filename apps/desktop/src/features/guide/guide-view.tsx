"use client";

import { useQuery } from "@tanstack/react-query";
import { Component, type ErrorInfo, type ReactNode, useMemo } from "react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import type { Session } from "#/features/pull-request/data/pr-data";
import { useFileChanges } from "#/features/pull-request/data/pr-data";
import { useSessionOpenFiles } from "#/features/pull-request/data/session-ui-store";
import { proseComponents } from "#/features/pull-request/prose-markdown";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { evaluateGuide } from "./evaluate";
import { GuideProvider } from "./guide-context";
import * as kit from "./kit";

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
			code={result.code}
			orpc={props.orpc}
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
}): React.ReactElement {
	const files = useFileChanges(props.orpc, props.session.id).files;
	const changedPaths = useMemo(
		() => new Set(files.map((file) => file.path)),
		[files],
	);
	const sessionOpenFiles = useSessionOpenFiles(props.session.id);
	const openFile = sessionOpenFiles.openFile;
	const context = useMemo(
		() => ({ sessionId: props.session.id, changedPaths, openFile }),
		[props.session.id, changedPaths, openFile],
	);

	return (
		<div className="min-h-0 min-w-0 flex-1 overflow-auto px-6 py-5">
			<div className="mx-auto flex max-w-3xl flex-col gap-3 pb-12 text-foreground text-sm leading-relaxed">
				<GuideProvider value={context}>
					<GuideErrorBoundary resetKey={props.version}>
						<EvaluatedGuide code={props.code} version={props.version} />
					</GuideErrorBoundary>
				</GuideProvider>
			</div>
		</div>
	);
}

// Kit components resolve without an import too, so a guide that forgets `import { Outcome } from "@nisi/guide"` still renders.
const MDX_COMPONENTS = { ...proseComponents, ...kit };

function EvaluatedGuide(props: {
	version: string;
	code: string;
}): React.ReactElement {
	const Guide = evaluateGuide(props.version, props.code);
	return <Guide components={MDX_COMPONENTS as never} />;
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
