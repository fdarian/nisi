import { copyActionsErrors, flattenActionsLog } from "@repo/git/actions-log";
import type { CiJob, CiLogNode } from "@repo/sidecar-api";
import { openUrl } from "@tauri-apps/plugin-opener";
import Anser from "anser";
import { cn } from "cn";
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleMinus,
	Copy,
	ExternalLink,
	LoaderCircle,
	RotateCw,
	X,
	XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "#/components/ui/dialog";
import { Group, GroupSeparator } from "#/components/ui/group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { toastManager } from "#/components/ui/toast";
import {
	type CiJobParams,
	useCiJob,
	useRerunCiJob,
} from "#/features/pull-request/data/pr-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";

type DialogProps = {
	orpc: SidecarQueryUtils;
	params: CiJobParams;
	workflowName?: string;
	onClose: () => void;
};

function failed(conclusion: string | null) {
	return (
		conclusion === "failure" ||
		conclusion === "timed_out" ||
		conclusion === "startup_failure" ||
		conclusion === "action_required"
	);
}

function JobStatusIcon(props: { status: string; conclusion: string | null }) {
	if (props.status === "in_progress")
		return (
			<LoaderCircle className="size-4 shrink-0 animate-spin text-warning" />
		);
	if (props.status !== "completed")
		return <Circle className="size-4 shrink-0 text-muted-foreground/40" />;
	if (failed(props.conclusion))
		return <XCircle className="size-4 shrink-0 text-destructive" />;
	if (props.conclusion === "success")
		return <CheckCircle2 className="size-4 shrink-0 text-success" />;
	return <CircleMinus className="size-4 shrink-0 text-muted-foreground" />;
}

export function CiLogDialog(props: DialogProps) {
	const query = useCiJob(props.orpc, props.params);
	const rerun = useRerunCiJob(props.orpc);
	const job = query.data;
	const copy = (text: string, label: string) => {
		void navigator.clipboard.writeText(text).then(
			() => toastManager.add({ title: `${label} copied`, type: "success" }),
			(error: unknown) =>
				toastManager.add({
					title: "Couldn't copy logs",
					description: String(error),
					type: "error",
				}),
		);
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			<DialogContent
				className="h-[85vh] w-[calc(100vw-2rem)] max-w-6xl overflow-hidden p-0"
				showCloseButton={false}
			>
				<div className="flex shrink-0 items-center gap-3 border-b px-5 py-4">
					{job !== undefined && (
						<JobStatusIcon status={job.status} conclusion={job.conclusion} />
					)}
					<DialogTitle className="min-w-0 flex-1 truncate text-base">
						{props.workflowName !== undefined && props.workflowName !== ""
							? `${props.workflowName} / `
							: ""}
						{job === undefined ? "Job logs" : job.name}
					</DialogTitle>
					{job !== undefined && (
						<Button
							aria-label="Open in GitHub"
							size="icon"
							variant="ghost"
							onClick={() =>
								void openUrl(job.htmlUrl).catch((error: unknown) =>
									toastManager.add({
										title: "Couldn't open GitHub",
										description: String(error),
										type: "error",
									}),
								)
							}
						>
							<ExternalLink />
						</Button>
					)}
					<DialogClose
						render={
							<Button aria-label="Close job logs" size="icon" variant="ghost" />
						}
					>
						<X />
					</DialogClose>
				</div>
				<DialogDescription className="sr-only">
					GitHub Actions job steps and logs
				</DialogDescription>
				{query.isError ? (
					<div role="alert" className="flex-1 p-6">
						<p>Couldn't load job logs: {query.error.message}</p>
						<Button
							variant="outline"
							className="mt-3"
							onClick={() => void query.refetch()}
						>
							Retry
						</Button>
					</div>
				) : job === undefined ? (
					<div
						role="status"
						className="flex flex-1 items-center justify-center gap-2 text-muted-foreground"
					>
						<LoaderCircle className="size-4 animate-spin" />
						Loading job logs…
					</div>
				) : (
					<JobSteps
						job={job}
						onRetry={() => void query.refetch()}
						refreshing={query.isFetching}
					/>
				)}
				<DialogFooter className="shrink-0">
					<Group aria-label="Copy job logs">
						<Button
							variant="outline"
							disabled={
								job?.logs.status !== "available" ||
								!job.steps.some((step) => failed(step.conclusion))
							}
							onClick={() => {
								if (job !== undefined)
									copy(copyActionsErrors(job.steps), "Errors");
							}}
						>
							<Copy />
							Copy errors
						</Button>
						<GroupSeparator />
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label="More copy options"
										size="icon"
										variant="outline"
										disabled={job?.logs.status !== "available"}
									/>
								}
							>
								<ChevronDown />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={() => {
										if (job?.logs.status === "available")
											copy(job.logs.raw, "Full logs");
									}}
								>
									Copy full logs
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</Group>
					<Button
						variant="outline"
						disabled={job?.status !== "completed" || rerun.isPending}
						onClick={() => rerun.mutate(props.params)}
					>
						<RotateCw className={cn(rerun.isPending && "animate-spin")} />
						Re-run
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function JobSteps(props: {
	job: CiJob;
	onRetry: () => void;
	refreshing: boolean;
}) {
	const root = useRef<HTMLDivElement>(null);
	const scrolled = useRef(false);
	const lines = useMemo(
		() => props.job.steps.flatMap((step) => flattenActionsLog(step.nodes)),
		[props.job.steps],
	);
	const firstError = lines.find((line) => line.kind === "error");
	const deltas = useMemo(
		() =>
			new Map(
				lines.map((line, index) => {
					const previous = lines[index - 1];
					return [
						line,
						previous === undefined
							? 0
							: Math.max(0, line.timestamp - previous.timestamp),
					] as const;
				}),
			),
		[lines],
	);
	useEffect(() => {
		if (scrolled.current || firstError === undefined) return;
		const pending = {
			timer: undefined as ReturnType<typeof setTimeout> | undefined,
		};
		const scroll = () => {
			const error = root.current?.querySelector("[data-first-error]");
			if (
				error !== null &&
				error !== undefined &&
				pending.timer === undefined
			) {
				observer.disconnect();
				// Wait for the collapsible panels' 200ms height transition before measuring the error's position.
				pending.timer = setTimeout(() => {
					error.scrollIntoView({ block: "center" });
					scrolled.current = true;
				}, 250);
			}
		};
		const observer = new MutationObserver(scroll);
		const element = root.current;
		if (element !== null) {
			observer.observe(element, { childList: true, subtree: true });
			scroll();
		}
		return () => {
			observer.disconnect();
			clearTimeout(pending.timer);
		};
	}, [firstError]);
	return (
		<div ref={root} className="min-h-0 flex-1 overflow-y-auto">
			{props.job.logs.status === "unavailable" && (
				<div
					role="status"
					className="border-b bg-muted/40 px-5 py-4 text-muted-foreground text-sm"
				>
					{props.job.status !== "completed"
						? "Job is in progress. Logs appear when the job finishes."
						: props.job.logs.reason}
					{props.job.status === "completed" && (
						<Button
							size="sm"
							variant="outline"
							className="ml-3"
							onClick={props.onRetry}
							disabled={props.refreshing}
						>
							Retry
						</Button>
					)}
				</div>
			)}
			{props.job.steps.map((step) => (
				<StepLogs
					key={step.number}
					step={step}
					firstError={firstError}
					deltas={deltas}
				/>
			))}
			{props.job.steps.length === 0 && (
				<p className="p-5 text-muted-foreground text-sm">
					No steps reported yet.
				</p>
			)}
		</div>
	);
}

type LogProps = {
	firstError: CiLogNode | undefined;
	deltas: ReadonlyMap<CiLogNode, number>;
};
function StepLogs(props: LogProps & { step: CiJob["steps"][number] }) {
	const open = useState(failed(props.step.conclusion));
	const containsFirstError =
		props.firstError !== undefined &&
		flattenActionsLog(props.step.nodes).some(
			(line) => line === props.firstError,
		);
	useEffect(() => {
		if (failed(props.step.conclusion) || containsFirstError) open[1](true);
	}, [props.step.conclusion, containsFirstError]);
	return (
		<Collapsible open={open[0]} onOpenChange={open[1]} className="border-b">
			<CollapsibleTrigger className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm hover:bg-muted/40">
				<JobStatusIcon
					status={props.step.status}
					conclusion={props.step.conclusion}
				/>
				<ChevronRight
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						open[0] && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate">{props.step.name}</span>
				{props.step.durationMs !== null && (
					<span className="shrink-0 font-mono text-muted-foreground text-xs">
						{formatDuration(props.step.durationMs)}
					</span>
				)}
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<div className="overflow-x-auto bg-muted/20 py-2 font-mono text-xs">
					<div className="min-w-full w-max">
						<LogNodes
							nodes={props.step.nodes}
							firstError={props.firstError}
							deltas={props.deltas}
						/>
					</div>
				</div>
			</CollapsiblePanel>
		</Collapsible>
	);
}

function formatDuration(ms: number) {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function LogNodes(props: LogProps & { nodes: readonly CiLogNode[] }) {
	return props.nodes.map((node, index) =>
		node.type === "group" ? (
			<LogGroup
				// biome-ignore lint/suspicious/noArrayIndexKey: Completed logs are immutable; timestamps and group names can repeat.
				key={`${index}-${node.title}`}
				node={node}
				firstError={props.firstError}
				deltas={props.deltas}
			/>
		) : (
			<div
				// biome-ignore lint/suspicious/noArrayIndexKey: Completed logs are immutable and multiple lines can share a timestamp.
				key={`${index}-${node.timestamp}`}
				data-first-error={node === props.firstError ? "" : undefined}
				className={cn(
					"flex min-h-5 items-start whitespace-pre px-3 leading-5",
					node.kind === "error" && "bg-destructive/10",
					node.kind === "warning" && "bg-warning/10",
					node.kind === "command" && "bg-blue-500/5 text-blue-500",
					node.kind === "debug" && "text-muted-foreground",
				)}
			>
				<span className="sticky left-0 mr-3 w-16 shrink-0 select-none bg-popover text-right text-muted-foreground">
					+{formatDuration(logDelta(props.deltas, node))}
				</span>
				<span
					className={cn(
						"mt-2 mr-2 size-1.5 shrink-0 rounded-full",
						node.kind === "error"
							? "bg-destructive"
							: node.kind === "warning"
								? "bg-warning"
								: "bg-transparent",
					)}
				/>
				<span>
					{Anser.ansiToJson(node.text).map((part, partIndex) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: SGR spans are immutable fragments of a single log line.
							key={`${partIndex}-${part.content}`}
							style={{
								color:
									part.fg_truecolor || part.fg
										? `rgb(${part.fg_truecolor || part.fg})`
										: undefined,
								backgroundColor:
									part.bg_truecolor || part.bg
										? `rgb(${part.bg_truecolor || part.bg})`
										: undefined,
								fontWeight: part.decorations.includes("bold")
									? "bold"
									: undefined,
							}}
						>
							{part.content}
						</span>
					))}
				</span>
			</div>
		),
	);
}

function LogGroup(
	props: LogProps & { node: Extract<CiLogNode, { type: "group" }> },
) {
	const open = useState(false);
	// Reveal only the first error's ancestors so scrolling can reach an otherwise collapsed line.
	useEffect(() => {
		if (
			props.firstError !== undefined &&
			flattenActionsLog(props.node.children).some(
				(line) => line === props.firstError,
			)
		)
			open[1](true);
	}, [props.firstError, props.node.children]);
	return (
		<Collapsible open={open[0]} onOpenChange={open[1]} className="ml-4">
			<CollapsibleTrigger className="flex items-center gap-2 whitespace-pre px-3 py-1 text-muted-foreground hover:text-foreground">
				<ChevronRight
					className={cn("size-3 transition-transform", open[0] && "rotate-90")}
				/>
				{props.node.title}
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<LogNodes
					nodes={props.node.children}
					firstError={props.firstError}
					deltas={props.deltas}
				/>
			</CollapsiblePanel>
		</Collapsible>
	);
}

function logDelta(
	deltas: ReadonlyMap<CiLogNode, number>,
	node: CiLogNode,
): number {
	const delta = deltas.get(node);
	if (delta === undefined) throw new Error("Missing log line timestamp delta");
	return delta;
}
