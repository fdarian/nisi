import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRightIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Card } from "#/components/ui/card";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "#/components/ui/input-group";
import { Skeleton } from "#/components/ui/skeleton";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import {
	friendlyRepositoryError,
	useHomeDir,
	useRepositories,
} from "./repositories-data";
import { EmptyState, ErrorState } from "./repositories-status";
import {
	filterRepositories,
	problemLabel,
	sessionSummary,
	tildePath,
} from "./repositories-view";

export function RepositoriesPage(): React.ReactElement | null {
	const backend = useBackendContext();
	if (backend.status !== "ready") return null;
	return <RepositoriesContent orpc={backend.orpc} />;
}

function RepositoriesContent(props: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const query = useRepositories(props.orpc);
	const home = useHomeDir();
	const searchState = useState("");
	const search = searchState[0];
	const setSearch = searchState[1];
	const repositories =
		query.data === undefined ? [] : filterRepositories(query.data, search);

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-8 py-12">
			<header className="flex flex-col gap-1.5">
				<h1 className="font-semibold text-2xl tracking-tight">Repositories</h1>
				<p className="text-muted-foreground text-sm">
					Local clones nisi uses to open pull requests.
				</p>
			</header>
			<div className="-mx-4">
				<InputGroup>
					<InputGroupAddon>
						<SearchIcon />
					</InputGroupAddon>
					<InputGroupInput
						aria-label="Search repositories"
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search repositories"
						value={search}
					/>
				</InputGroup>
			</div>
			{query.isPending ? (
				<RepositoryListSkeleton />
			) : query.isError ? (
				<ErrorState
					message={friendlyRepositoryError(query.error)}
					onRetry={() => query.refetch()}
					title="Couldn't load repositories"
				/>
			) : repositories.length === 0 ? (
				<EmptyState
					description={
						search.trim() === ""
							? "Repositories appear here once you open a pull request."
							: "Nothing matches that search."
					}
					title={search.trim() === "" ? "No repositories yet" : "No matches"}
				/>
			) : (
				<RepositoryListCard>
					{repositories.map((repository) => (
						<Link
							className={cn(
								REPOSITORY_ROW,
								"transition-colors hover:bg-accent/50",
							)}
							key={`${repository.owner}/${repository.repo}`}
							params={{ owner: repository.owner, repo: repository.repo }}
							to="/settings/repositories/$owner/$repo"
						>
							<RepositoryRowCells
								meta={
									repository.problem === null ? (
										sessionSummary(repository)
									) : (
										<>
											<TriangleAlertIcon className="size-3.5" />
											{problemLabel(repository.problem)}
										</>
									)
								}
								metaClassName={
									repository.problem === null
										? "text-muted-foreground"
										: "gap-1.5 text-warning-foreground"
								}
								name={`${repository.owner}/${repository.repo}`}
								path={
									repository.path === null
										? ""
										: tildePath(repository.path, home)
								}
							/>
						</Link>
					))}
				</RepositoryListCard>
			)}
		</div>
	);
}

const REPOSITORY_ROW = "flex h-13 items-center gap-3 px-4";

function RepositoryListCard(props: {
	children: React.ReactNode;
	loading?: boolean;
}): React.ReactElement {
	return (
		<Card
			aria-label={props.loading ? "Loading repositories" : undefined}
			className="-mx-4 divide-y divide-border overflow-hidden"
			radius="lg"
			role={props.loading ? "status" : undefined}
		>
			{props.children}
		</Card>
	);
}

/** The row's columns, shared by the loaded row and its skeleton so the two can't drift apart. */
function RepositoryRowCells(props: {
	name: React.ReactNode;
	path: React.ReactNode;
	meta: React.ReactNode;
	metaClassName?: string;
}): React.ReactElement {
	return (
		<>
			<div className="w-44 shrink-0 truncate font-medium text-sm">
				{props.name}
			</div>
			<div className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
				{props.path}
			</div>
			<div
				className={cn(
					"flex shrink-0 items-center text-sm",
					props.metaClassName,
				)}
			>
				{props.meta}
			</div>
			<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
		</>
	);
}

const SKELETON_ROWS: readonly { name: string; path: string; meta: string }[] = [
	{ name: "w-28", path: "w-40", meta: "w-28" },
	{ name: "w-24", path: "w-44", meta: "w-24" },
	{ name: "w-32", path: "w-36", meta: "w-16" },
	{ name: "w-20", path: "w-48", meta: "w-32" },
	{ name: "w-28", path: "w-32", meta: "w-20" },
	{ name: "w-36", path: "w-40", meta: "w-24" },
];

function RepositoryListSkeleton(): React.ReactElement {
	return (
		<RepositoryListCard loading>
			{SKELETON_ROWS.map((row, index) => (
				<div
					aria-hidden="true"
					className={REPOSITORY_ROW}
					// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
					key={index}
				>
					<RepositoryRowCells
						meta={<Skeleton className={cn("h-4", row.meta)} />}
						name={<Skeleton className={cn("h-4", row.name)} />}
						path={<Skeleton className={cn("h-3.5", row.path)} />}
					/>
				</div>
			))}
		</RepositoryListCard>
	);
}
