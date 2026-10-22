import { ArrowLeftIcon, GitBranchIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { Skeleton } from "#/components/ui/skeleton";
import { githubAvatarUrl } from "#/features/pull-request/data/pull-requests-data";

type PrHeaderMetaProps =
	| {
			mode: "pr";
			variant: "sentence" | "arrow";
			/** `undefined` while the author is still loading. */
			author: string | undefined;
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

function Author(props: { login: string | undefined }): React.ReactElement {
	if (props.login === undefined) {
		return (
			<>
				<Skeleton className="size-4 shrink-0 rounded-full" />
				<Skeleton className="h-3 w-16 shrink-0" />
			</>
		);
	}
	return (
		<>
			<Avatar className="size-4 shrink-0 bg-muted text-[8px]">
				<AvatarImage alt="" src={githubAvatarUrl(props.login)} />
				<AvatarFallback>{props.login.slice(0, 2).toUpperCase()}</AvatarFallback>
			</Avatar>
			<span className="shrink-0 font-medium text-foreground">
				{props.login}
			</span>
		</>
	);
}

export function PrHeaderMeta(props: PrHeaderMetaProps): React.ReactElement {
	return (
		<div className="flex h-5 min-w-0 items-center overflow-hidden gap-1.5 whitespace-nowrap text-muted-foreground text-xs">
			{props.mode === "branch" ? (
				<>
					<GitBranchIcon className="size-3.5 shrink-0" />
					<span className="shrink-0">Local diff against</span>
					<BranchChip name={props.baseRef} />
				</>
			) : props.variant === "sentence" ? (
				<>
					<Author login={props.author} />
					<span className="shrink-0">wants to merge</span>
					<BranchChip icon name={props.headRef} />
					<span className="shrink-0">into</span>
					<BranchChip name={props.baseRef} />
				</>
			) : (
				<>
					<Author login={props.author} />
					<span className="shrink-0">·</span>
					<BranchChip name={props.baseRef} />
					<ArrowLeftIcon className="size-3 shrink-0" />
					<BranchChip icon name={props.headRef} />
				</>
			)}
		</div>
	);
}
