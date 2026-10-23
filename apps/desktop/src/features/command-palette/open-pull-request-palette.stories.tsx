import type { Meta, StoryObj } from "@storybook/react-vite";
import {
	matchQuery,
	QueryClient,
	QueryClientProvider,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { userEvent, within } from "storybook/test";
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
	{
		owner: "fdarian",
		repo: "furl",
		number: 38,
		title: "Persist repository chips across palette opens",
		author: "fdarian",
		updatedAt: "2026-09-28T12:00:00Z",
		url: "https://github.com/fdarian/furl/pull/38",
		isDraft: false,
		state: "MERGED",
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
		rollupState: "SUCCESS",
	},
	{
		owner: "fdarian",
		repo: "nisi",
		number: 12,
		title: "Try a sticky file header",
		author: "fdarian",
		updatedAt: "2026-09-27T12:00:00Z",
		url: "https://github.com/fdarian/nisi/pull/12",
		isDraft: false,
		state: "CLOSED",
		mergeable: "UNKNOWN",
		mergeStateStatus: "UNKNOWN",
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
				opensOnRepositoryPicker={false}
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

export const RecentlyClosed: Story = {
	play: async ({ canvasElement }) => {
		const input = await within(
			canvasElement.ownerDocument.body,
		).findByPlaceholderText("Open pull requests…");
		await userEvent.click(input);
		await userEvent.keyboard("closed");
		await userEvent.click(
			await within(canvasElement.ownerDocument.body).findByText("Filter by"),
		);
	},
};
