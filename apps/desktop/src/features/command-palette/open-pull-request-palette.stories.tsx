import type { Meta, StoryObj } from "@storybook/react-vite";
import {
	matchQuery,
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Button } from "#/components/ui/button";
import type {
	PullRequestRepository,
	PullRequestSearchResult,
} from "#/features/pull-request/data/pull-requests-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { createMockOrpc } from "../../../.storybook/mock-orpc";
import { OpenPullRequestPalette } from "./open-pull-request-palette";

const RESULTS: PullRequestSearchResult[] = [
	{
		owner: "fdarian",
		repo: "furl",
		number: 42,
		title: "Add repository filters to the command palette",
		author: "fdarian",
		updatedAt: "2026-09-30T12:00:00Z",
		url: "https://github.com/fdarian/furl/pull/42",
		isDraft: false,
		state: "OPEN",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		rollupState: "SUCCESS",
	},
	{
		owner: "fdarian",
		repo: "nisi",
		number: 17,
		title: "Improve tracked change navigation",
		author: "fdarian",
		updatedAt: "2026-09-29T12:00:00Z",
		url: "https://github.com/fdarian/nisi/pull/17",
		isDraft: true,
		state: "OPEN",
		mergeable: "UNKNOWN",
		mergeStateStatus: "DRAFT",
		rollupState: null,
	},
];

type SearchState = "loading" | "loaded" | "revalidating";

/** Searches resolve this many times before every later one stays pending: none, all, or just the first (so a refetch leaves them revalidating). */
const SETTLE_LIMIT: Record<SearchState, number | undefined> = {
	loading: 0,
	loaded: undefined,
	revalidating: 1,
};

function PaletteStory(props: { state: SearchState }): React.ReactElement {
	// Keyed by `state` from the outside, so each state gets its own cache and its own call count.
	const queryClient = useMemo(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		[],
	);
	const orpc = useMemo(
		() =>
			createMockOrpc({
				pullRequestSearchResults: RESULTS,
				pullRequestRepositories: [
					{ owner: "fdarian", repo: "furl" },
					{ owner: "acme", repo: "widgets" },
				],
				pullRequestSearchSettleLimit: SETTLE_LIMIT[props.state],
			}),
		[props.state],
	);
	return (
		<QueryClientProvider client={queryClient}>
			<Palette orpc={orpc} refetchOnceLoaded={props.state === "revalidating"} />
		</QueryClientProvider>
	);
}

function Palette(props: {
	orpc: SidecarQueryUtils;
	refetchOnceLoaded: boolean;
}): React.ReactElement {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(true);
	const [repositories, setRepositories] = useState<PullRequestRepository[]>([]);

	useEffect(() => {
		if (!props.refetchOnceLoaded) return;
		// The first search is the only one that settles, so the refetch this
		// triggers is deterministically left in flight with results on screen.
		const filters = { queryKey: props.orpc.pullRequests.search.key() };
		return queryClient.getQueryCache().subscribe((event) => {
			if (
				event.type === "updated" &&
				event.action.type === "success" &&
				matchQuery(filters, event.query)
			)
				void queryClient.invalidateQueries(filters);
		});
	}, [queryClient, props.orpc, props.refetchOnceLoaded]);

	return (
		<div className="p-8">
			<Button onClick={() => setOpen(true)}>Open pull requests</Button>
			<OpenPullRequestPalette
				open={open}
				onOpenChange={setOpen}
				orpc={props.orpc}
				repositories={repositories}
				onRepositoriesChange={setRepositories}
				findExistingSessionId={() => undefined}
				onSessionOpened={() => setOpen(false)}
			/>
		</div>
	);
}

function KeyedPaletteStory(props: { state: SearchState }): React.ReactElement {
	return <PaletteStory key={props.state} state={props.state} />;
}

const meta = {
	title: "Pr/OpenPullRequestPalette",
	component: KeyedPaletteStory,
	args: { state: "loaded" },
	argTypes: {
		state: {
			control: "radio",
			options: ["loading", "loaded", "revalidating"],
		},
	},
} satisfies Meta<typeof KeyedPaletteStory>;
export default meta;

type Story = StoryObj<typeof meta>;
export const Default: Story = {};
