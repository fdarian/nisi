import { ArrowLeftIcon, GitBranchIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { Skeleton } from "#/components/ui/skeleton";
import { githubAvatarUrl } from "#/features/pull-request/data/pull-requests-data";

type PrHeaderMetaProps =
	| {
			mode: "pr";
			/** `null` for a session not yet re-resolved since the author was added to the target. */
			authorLogin: string | null;
			baseRef: string;
			headRef: string;
	  }
	| { mode: "branch"; baseRef: string };

function BranchChip(props: {
	name: string;
	icon?: boolean;
}): React.ReactElement {
	return (
		<span
			className="inline-flex min-w-10 max-w-64 items-center gap-1 rounded bg-muted px-1.5 font-mono text-muted-foreground"
			title={props.name}
		>
			{props.icon === true && <GitBranchIcon className="size-3 shrink-0" />}
			<span className="truncate">{props.name}</span>
		</span>
	);
}

function Author(props: { login: string }): React.ReactElement {
	return (
		<>
			<Avatar className="size-4 shrink-0 bg-muted text-[8px]">
				<AvatarImage alt="" src={githubAvatarUrl(props.login)} />
				<AvatarFallback>{props.login.slice(0, 2).toUpperCase()}</AvatarFallback>
			</Avatar>
			<span className="shrink-0 font-medium text-foreground">
				{props.login}
			</span>
			<span className="shrink-0">·</span>
		</>
	);
}

/** Segments of `PrHeaderShell`'s context row; the shell owns the row and the repo before them. */
export function PrHeaderMeta(props: PrHeaderMetaProps): React.ReactElement {
	if (props.mode === "branch") {
		return (
			<>
				<GitBranchIcon className="size-3.5 shrink-0" />
				<span className="shrink-0">Local diff against</span>
				<BranchChip name={props.baseRef} />
			</>
		);
	}
	return (
		<>
			{props.authorLogin !== null && <Author login={props.authorLogin} />}
			<BranchChip name={props.baseRef} />
			<ArrowLeftIcon className="size-3 shrink-0" />
			<BranchChip icon name={props.headRef} />
		</>
	);
}

/** Stands in for `PrHeaderMeta`'s segments inside the shell's `h-5` context row, so the loading header doesn't change height when the real one lands. */
export function PrHeaderMetaSkeleton(): React.ReactElement {
	return (
		<>
			<Skeleton className="size-4 shrink-0 rounded-full" />
			<Skeleton className="h-3 w-16 shrink-0" />
			<Skeleton className="h-3 w-14 shrink-0" />
			<Skeleton className="h-3 w-24 shrink-0" />
		</>
	);
}
