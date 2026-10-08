import type { RepositoryDetail, RepositorySession } from "@repo/sidecar-api";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ChevronLeftIcon,
	GitMergeIcon,
	GitPullRequestArrowIcon,
	GitPullRequestClosedIcon,
	SearchIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "#/components/ui/input-group";
import { Tabs, TabsList, TabsTab } from "#/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import { enqueuePullRequestOpen } from "#/shell/deep-link/deep-link-store";
import {
	friendlyRepositoryError,
	revealInFinder,
	useChangeRepositoryPath,
	useHomeDir,
	useRepository,
} from "./repositories-data";
import { EmptyState, ErrorState, LoadingState } from "./repositories-status";
import {
	filterSessions,
	formatRemote,
	problemLabel,
	relativeTime,
	SESSION_TABS,
	type SessionTab,
	splitVisibleSessions,
	tildePath,
} from "./repositories-view";

export function RepositoryDetailPage(props: {
	owner: string;
	repo: string;
}): React.ReactElement | null {
	const backend = useBackendContext();
	if (backend.status !== "ready") return null;
	return (
		<RepositoryDetailContent
			orpc={backend.orpc}
			owner={props.owner}
			repo={props.repo}
		/>
	);
}

function RepositoryDetailContent(props: {
	orpc: SidecarQueryUtils;
	owner: string;
	repo: string;
}): React.ReactElement {
	const query = useRepository(props.orpc, props.owner, props.repo);
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-5 overflow-y-auto px-8 py-12">
			<nav
				aria-label="breadcrumb"
				className="flex items-center gap-1.5 text-[15px]"
			>
				<Link
					className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
					to="/settings/repositories"
				>
					<ChevronLeftIcon className="size-4" />
					Repositories
				</Link>
				<span aria-hidden="true" className="text-muted-foreground/60">
					/
				</span>
				<span aria-current="page">
					{props.owner}/{props.repo}
				</span>
			</nav>
			{query.isPending ? (
				<LoadingState />
			) : query.isError ? (
				<ErrorState
					message={friendlyRepositoryError(query.error)}
					onRetry={() => query.refetch()}
					title="Couldn't load this repository"
				/>
			) : (
				<>
					<LocationSection orpc={props.orpc} repository={query.data} />
					<SessionsSection repository={query.data} />
				</>
			)}
		</div>
	);
}

function LocationSection(props: {
	orpc: SidecarQueryUtils;
	repository: RepositoryDetail;
}): React.ReactElement {
	const home = useHomeDir();
	const change = useChangeRepositoryPath(props.orpc);
	const repository = props.repository;
	return (
		<section className="flex flex-col gap-2">
			<h2 className="font-medium text-muted-foreground text-sm">Location</h2>
			<Card className="-mx-6 divide-y divide-border">
				<div className="flex min-h-11 items-center gap-4 px-4 py-2">
					<span className="w-30 shrink-0 text-sm">Path</span>
					<span
						className="min-w-0 flex-1 truncate text-right font-mono text-muted-foreground text-xs"
						title={repository.path ?? undefined}
					>
						{repository.path === null
							? "Not set"
							: tildePath(repository.path, home)}
					</span>
					<div className="flex shrink-0 items-center gap-1">
						{repository.path !== null &&
							repository.problem !== "path-missing" && (
								<Button
									onClick={() => {
										if (repository.path !== null)
											revealInFinder(repository.path);
									}}
									size="xs"
									variant="ghost"
								>
									Reveal in Finder
								</Button>
							)}
						<Button
							disabled={change.isPending}
							onClick={() =>
								change.mutate({
									owner: repository.owner,
									repo: repository.repo,
								})
							}
							size="xs"
							variant="ghost"
						>
							{repository.path === null ? "Choose…" : "Change…"}
						</Button>
					</div>
				</div>
				<div className="flex min-h-11 items-center gap-4 px-4 py-2">
					<span className="w-30 shrink-0 text-sm">Remote</span>
					<span className="min-w-0 flex-1 truncate text-right font-mono text-muted-foreground text-xs">
						{repository.remoteUrl === null
							? "—"
							: formatRemote(repository.remoteUrl)}
					</span>
				</div>
			</Card>
			{repository.problem !== null && (
				<p className="flex items-center gap-1.5 text-sm text-warning-foreground">
					<TriangleAlertIcon className="size-3.5 shrink-0" />
					{problemLabel(repository.problem)}
				</p>
			)}
			{change.isError && (
				<p className="text-destructive-foreground text-sm">
					{friendlyRepositoryError(change.error)}
				</p>
			)}
		</section>
	);
}

function SessionsSection(props: {
	repository: RepositoryDetail;
}): React.ReactElement {
	const tabState = useState<SessionTab>("all");
	const tab = tabState[0];
	const setTab = tabState[1];
	const searchState = useState("");
	const search = searchState[0];
	const setSearch = searchState[1];
	const expandedState = useState(false);
	const expanded = expandedState[0];
	const setExpanded = expandedState[1];
	const repository = props.repository;
	const matching = filterSessions(repository.sessions, tab, search);
	const visible = splitVisibleSessions(matching, expanded);
	const now = Date.now();

	return (
		<section className="flex flex-col gap-2">
			<div className="flex h-7 items-center justify-between gap-3">
				<h2 className="flex items-baseline gap-1.5 font-medium text-muted-foreground text-sm">
					Sessions
					<span className="font-normal">{repository.sessions.length}</span>
				</h2>
				<div className="-mr-4 flex items-center gap-2">
					<Tabs
						onValueChange={(value) => setTab(value as SessionTab)}
						value={tab}
					>
						<TabsList>
							{SESSION_TABS.map((entry) => (
								<TabsTab key={entry.value} value={entry.value}>
									{entry.label}
								</TabsTab>
							))}
						</TabsList>
					</Tabs>
					<InputGroup className="w-42">
						<InputGroupAddon>
							<SearchIcon />
						</InputGroupAddon>
						<InputGroupInput
							aria-label="Filter sessions"
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Filter by title or #"
							value={search}
						/>
					</InputGroup>
				</div>
			</div>
			{matching.length === 0 ? (
				<EmptyState
					description={
						repository.sessions.length === 0
							? "Pull requests you open from this repository show up here."
							: "No sessions match this filter."
					}
					title={
						repository.sessions.length === 0 ? "No sessions yet" : "No matches"
					}
				/>
			) : (
				<Card className="-mx-6 divide-y divide-border overflow-hidden">
					{visible.shown.map((session) => (
						<SessionRow
							key={session.id}
							now={now}
							onOpen={() =>
								enqueuePullRequestOpen(
									repository.owner,
									repository.repo,
									session.prNumber,
								)
							}
							session={session}
						/>
					))}
					{visible.hiddenCount > 0 && (
						<button
							className="flex h-10 w-full cursor-pointer items-center justify-center text-muted-foreground text-sm transition-colors hover:bg-accent/50 hover:text-foreground"
							onClick={() => setExpanded(true)}
							type="button"
						>
							Show {visible.hiddenCount} more
						</button>
					)}
				</Card>
			)}
		</section>
	);
}

function SessionRow(props: {
	session: RepositorySession;
	now: number;
	onOpen: () => void;
}): React.ReactElement {
	const session = props.session;
	return (
		<button
			className="flex h-10 w-full cursor-pointer items-center gap-2.5 px-4 text-left transition-colors hover:bg-accent/50"
			onClick={props.onOpen}
			type="button"
		>
			<StateIcon state={session.state} />
			<span className="w-10 shrink-0 text-muted-foreground text-sm">
				#{session.prNumber}
			</span>
			<span className="min-w-0 flex-1 truncate text-sm">{session.prTitle}</span>
			<span className="w-10 shrink-0 text-right text-muted-foreground text-xs">
				{relativeTime(session.updatedAt, props.now)}
			</span>
		</button>
	);
}

function StateIcon(props: {
	state: RepositorySession["state"];
}): React.ReactElement {
	const className = "size-3.5 shrink-0";
	if (props.state.kind === "unresolved")
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<span className="flex shrink-0">
							<TriangleAlertIcon
								aria-label="State unavailable"
								className={cn(className, "text-muted-foreground")}
							/>
						</span>
					}
				/>
				<TooltipPopup>{props.state.reason}</TooltipPopup>
			</Tooltip>
		);
	switch (props.state.state) {
		case "open":
			return (
				<GitPullRequestArrowIcon className={cn(className, "text-success")} />
			);
		case "merged":
			return <GitMergeIcon className={cn(className, "text-merged")} />;
		case "closed":
			return (
				<GitPullRequestClosedIcon
					className={cn(className, "text-destructive")}
				/>
			);
	}
}
