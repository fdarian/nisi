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
import { Skeleton } from "#/components/ui/skeleton";
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
import { EmptyState, ErrorState } from "./repositories-status";
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
			<header className="flex flex-col items-start gap-1.5">
				<nav aria-label="Back">
					<Button
						className="-ml-6 text-muted-foreground hover:text-foreground"
						render={(props) => (
							<Link {...props} to="/settings/repositories">
								<ChevronLeftIcon className="size-4" />
								Repositories
							</Link>
						)}
						size="xs"
						variant="ghost"
					/>
				</nav>
				<h1 className="font-semibold text-xl tracking-tight">
					{props.owner}/{props.repo}
				</h1>
			</header>
			{query.isPending ? (
				<RepositoryDetailSkeleton />
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

/** Heading and card shared by the loaded Location section and its skeleton. */
function LocationFrame(props: {
	pathValue: React.ReactNode;
	pathTitle?: string;
	pathActions?: React.ReactNode;
	remoteValue: React.ReactNode;
	children?: React.ReactNode;
}): React.ReactElement {
	return (
		<section className="flex flex-col gap-2">
			<h2 className="font-medium text-muted-foreground text-sm">Location</h2>
			<Card className="-mx-4 divide-y divide-border" radius="lg">
				<div className="flex min-h-11 items-center gap-4 px-4 py-2">
					<span className="w-30 shrink-0 text-sm">Path</span>
					<div
						className="min-w-0 flex-1 truncate text-right font-mono text-muted-foreground text-xs"
						title={props.pathTitle}
					>
						{props.pathValue}
					</div>
					{props.pathActions !== undefined && (
						<div className="flex shrink-0 items-center gap-1">
							{props.pathActions}
						</div>
					)}
				</div>
				<div className="flex min-h-11 items-center gap-4 px-4 py-2">
					<span className="w-30 shrink-0 text-sm">Remote</span>
					<div className="min-w-0 flex-1 truncate text-right font-mono text-muted-foreground text-xs">
						{props.remoteValue}
					</div>
				</div>
			</Card>
			{props.children}
		</section>
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
		<LocationFrame
			pathActions={
				<>
					{repository.path !== null &&
						repository.problem !== "path-missing" && (
							<Button
								onClick={() => {
									if (repository.path !== null) revealInFinder(repository.path);
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
				</>
			}
			pathTitle={repository.path ?? undefined}
			pathValue={
				repository.path === null ? "Not set" : tildePath(repository.path, home)
			}
			remoteValue={
				repository.remoteUrl === null ? "—" : formatRemote(repository.remoteUrl)
			}
		>
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
		</LocationFrame>
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
			<SessionsHeader
				count={repository.sessions.length}
				onSearchChange={setSearch}
				onTabChange={setTab}
				search={search}
				tab={tab}
			/>
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
				<SessionsCard>
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
				</SessionsCard>
			)}
		</section>
	);
}

/** Title, tabs and filter; `count` is absent and the controls inert while the sessions are still loading. */
function SessionsHeader(props: {
	count?: number;
	tab: SessionTab;
	onTabChange: (tab: SessionTab) => void;
	search: string;
	onSearchChange: (search: string) => void;
	disabled?: boolean;
}): React.ReactElement {
	return (
		<div className="flex h-7 items-center justify-between gap-3">
			<h2 className="flex items-baseline gap-1.5 font-medium text-muted-foreground text-sm">
				Sessions
				{props.count !== undefined && (
					<span className="font-normal">{props.count}</span>
				)}
			</h2>
			<div className="-mr-4 flex items-center gap-2">
				<Tabs
					onValueChange={(value) => props.onTabChange(value as SessionTab)}
					value={props.tab}
				>
					<TabsList size="sm">
						{SESSION_TABS.map((entry) => (
							<TabsTab
								disabled={props.disabled}
								key={entry.value}
								value={entry.value}
							>
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
						disabled={props.disabled}
						onChange={(event) => props.onSearchChange(event.target.value)}
						placeholder="Filter by title or #"
						value={props.search}
					/>
				</InputGroup>
			</div>
		</div>
	);
}

function SessionsCard(props: {
	children: React.ReactNode;
	loading?: boolean;
}): React.ReactElement {
	return (
		<Card
			aria-label={props.loading ? "Loading sessions" : undefined}
			className="-mx-4 divide-y divide-border overflow-hidden"
			radius="lg"
			role={props.loading ? "status" : undefined}
		>
			{props.children}
		</Card>
	);
}

const SESSION_ROW = "flex h-10 w-full items-center gap-2.5 px-4";

/** The row's columns, shared by the loaded row and its skeleton so the two can't drift apart. */
function SessionRowCells(props: {
	icon: React.ReactNode;
	number: React.ReactNode;
	title: React.ReactNode;
	time: React.ReactNode;
}): React.ReactElement {
	return (
		<>
			{props.icon}
			<div className="w-10 shrink-0 text-muted-foreground text-sm">
				{props.number}
			</div>
			<div className="min-w-0 flex-1 truncate text-sm">{props.title}</div>
			<div className="flex w-10 shrink-0 justify-end text-right text-muted-foreground text-xs">
				{props.time}
			</div>
		</>
	);
}

const SKELETON_TITLE_WIDTHS = [
	"w-3/4",
	"w-1/2",
	"w-2/3",
	"w-5/6",
	"w-2/5",
	"w-3/5",
	"w-1/2",
] as const;

function RepositoryDetailSkeleton(): React.ReactElement {
	const noop = () => {};
	return (
		<>
			<LocationFrame
				pathValue={<Skeleton className="ml-auto h-3.5 w-36" />}
				remoteValue={<Skeleton className="ml-auto h-3.5 w-44" />}
			/>
			<section className="flex flex-col gap-2">
				<SessionsHeader
					disabled
					onSearchChange={noop}
					onTabChange={noop}
					search=""
					tab="all"
				/>
				<SessionsCard loading>
					{SKELETON_TITLE_WIDTHS.map((width, index) => (
						<div
							aria-hidden="true"
							className={SESSION_ROW}
							// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
							key={index}
						>
							<SessionRowCells
								icon={<Skeleton className="size-3.5 shrink-0 rounded-full" />}
								number={<Skeleton className="h-3.5 w-8" />}
								time={<Skeleton className="h-3 w-6" />}
								title={<Skeleton className={cn("h-3.5", width)} />}
							/>
						</div>
					))}
				</SessionsCard>
			</section>
		</>
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
			className={cn(
				SESSION_ROW,
				"cursor-pointer text-left transition-colors hover:bg-accent/50",
			)}
			onClick={props.onOpen}
			type="button"
		>
			<SessionRowCells
				icon={<StateIcon state={session.state} />}
				number={`#${session.prNumber}`}
				time={relativeTime(session.updatedAt, props.now)}
				title={session.prTitle}
			/>
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
