import type { Meta, StoryObj } from "@storybook/react-vite";
import {
	makeSessions,
	nisiDetail,
	withPendingStates,
} from "./repositories.fixture";
import {
	RepositoriesStory,
	stubTauriForRepositories,
} from "./repositories-story-harness";

const DETAIL_PATH = "/settings/repositories/fdarian/nisi";

const meta = {
	title: "Settings/Repositories/Detail",
	component: RepositoriesStory,
	beforeEach: stubTauriForRepositories,
	parameters: { controls: { disable: true } },
} satisfies Meta<typeof RepositoriesStory>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		initialPath: DETAIL_PATH,
		data: { repositoryDetail: nisiDetail() },
	},
};

export const Loading: Story = {
	args: {
		initialPath: DETAIL_PATH,
		data: { repositoryDetail: { pending: true } },
	},
};

const unresolvedReasons = [
	"GitHub is rate-limiting this account: API rate limit exceeded",
	"gh is not authenticated: run `gh auth login`",
	"GitHub could not return this pull request",
];

/** The panel and the All list are there at once; skeletons hold each pending row's state icon until its event lands, and the tabs fill in as they do. */
export const ResolvingStates: Story = (() => {
	const detail = withPendingStates(makeSessions(30, Date.now()), 2);
	const batch = (from: number, to: number) =>
		detail.resolutions.slice(from, to);
	return {
		args: {
			initialPath: DETAIL_PATH,
			data: {
				repositoryDetail: nisiDetail({ sessions: [...detail.sessions] }),
				repositorySessionStates: {
					events: [
						{ delayMs: 2500, batch: batch(0, 8) },
						{ delayMs: 1500, batch: batch(8, 9) },
						{ delayMs: 1500, batch: batch(9, 10) },
					],
					afterEvents: "hang",
				},
			},
		},
	};
})();

export const StatesStreamedIn: Story = (() => {
	const detail = withPendingStates(makeSessions(30, Date.now()), 3);
	return {
		args: {
			initialPath: DETAIL_PATH,
			data: {
				repositoryDetail: nisiDetail({ sessions: [...detail.sessions] }),
				repositorySessionStates: {
					events: [
						{ delayMs: 1500, batch: detail.resolutions.slice(0, 6) },
						{ delayMs: 1000, batch: detail.resolutions.slice(6) },
					],
				},
			},
		},
	};
})();

export const UnresolvedStates: Story = (() => {
	const detail = withPendingStates(makeSessions(12, Date.now()), 4);
	return {
		args: {
			initialPath: DETAIL_PATH,
			data: {
				repositoryDetail: nisiDetail({ sessions: [...detail.sessions] }),
				repositorySessionStates: {
					events: [
						{
							delayMs: 500,
							batch: detail.resolutions.map((resolution, index) => ({
								prNumber: resolution.prNumber,
								state: {
									kind: "unresolved" as const,
									reason:
										unresolvedReasons[index % unresolvedReasons.length] ??
										unresolvedReasons[0],
								},
							})),
						},
					],
				},
			},
		},
	};
})();

export const StateStreamFailed: Story = (() => {
	const detail = withPendingStates(makeSessions(12, Date.now()), 3);
	return {
		args: {
			initialPath: DETAIL_PATH,
			data: {
				repositoryDetail: nisiDetail({ sessions: [...detail.sessions] }),
				repositorySessionStates: {
					events: [{ delayMs: 1000, batch: detail.resolutions.slice(0, 2) }],
					afterEvents: { error: "database is locked" },
				},
			},
		},
	};
})();

export const PathMissing: Story = {
	args: {
		initialPath: DETAIL_PATH,
		data: {
			repositoryDetail: nisiDetail({
				problem: "path-missing",
				remoteUrl: null,
				sessions: makeSessions(8, Date.now()),
			}),
		},
	},
};

export const NoPathSet: Story = {
	args: {
		initialPath: "/settings/repositories/contoso/internal-tools",
		data: {
			repositoryDetail: nisiDetail({
				owner: "contoso",
				repo: "internal-tools",
				path: null,
				remoteUrl: null,
				problem: "no-path",
				sessions: makeSessions(2, Date.now()),
			}),
		},
	},
};

export const NoSessions: Story = {
	args: {
		initialPath: DETAIL_PATH,
		data: { repositoryDetail: nisiDetail({ sessions: [] }) },
	},
};

export const LoadFailed: Story = {
	args: {
		initialPath: DETAIL_PATH,
		data: { repositoryDetail: { error: "database is locked" } },
	},
};
