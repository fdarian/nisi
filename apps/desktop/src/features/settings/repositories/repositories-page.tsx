import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Card } from "#/components/ui/card";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "#/components/ui/input-group";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import {
	friendlyRepositoryError,
	useHomeDir,
	useRepositories,
} from "./repositories-data";
import { EmptyState, ErrorState, LoadingState } from "./repositories-status";
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
			{query.isPending ? (
				<LoadingState />
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
				<Card className="-mx-6 divide-y divide-border overflow-hidden">
					{repositories.map((repository) => (
						<Link
							className="flex h-13 items-center gap-3 px-4 transition-colors hover:bg-accent/50"
							key={`${repository.owner}/${repository.repo}`}
							params={{ owner: repository.owner, repo: repository.repo }}
							to="/settings/repositories/$owner/$repo"
						>
							<span className="w-44 shrink-0 truncate font-medium text-sm">
								{repository.owner}/{repository.repo}
							</span>
							<span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
								{repository.path === null
									? ""
									: tildePath(repository.path, home)}
							</span>
							{repository.problem === null ? (
								<span className="shrink-0 text-muted-foreground text-sm">
									{sessionSummary(repository)}
								</span>
							) : (
								<span className="flex shrink-0 items-center gap-1.5 text-sm text-warning-foreground">
									<TriangleAlertIcon className="size-3.5" />
									{problemLabel(repository.problem)}
								</span>
							)}
							<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
						</Link>
					))}
				</Card>
			)}
		</div>
	);
}
