import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import type {
	PullRequestRepository,
	PullRequestSearchResult,
} from "#/features/pull-request/data/pull-requests-data";
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

const orpc = createMockOrpc({
	pullRequestSearchResults: RESULTS,
	pullRequestRepositories: [
		{ owner: "fdarian", repo: "furl" },
		{ owner: "acme", repo: "widgets" },
	],
});

function PaletteStory(): React.ReactElement {
	const [open, setOpen] = useState(false);
	const [repositories, setRepositories] = useState<PullRequestRepository[]>([]);
	return (
		<div className="p-8">
			<Button onClick={() => setOpen(true)}>Open pull requests</Button>
			<OpenPullRequestPalette
				open={open}
				onOpenChange={setOpen}
				orpc={orpc}
				repositories={repositories}
				onRepositoriesChange={setRepositories}
				findExistingSessionId={() => undefined}
				onSessionOpened={() => setOpen(false)}
			/>
		</div>
	);
}

const meta = {
	title: "Pr/OpenPullRequestPalette",
	component: PaletteStory,
	parameters: { controls: { disable: true } },
} satisfies Meta<typeof PaletteStory>;
export default meta;

type Story = StoryObj<typeof meta>;
export const RepositoryFilter: Story = {};
