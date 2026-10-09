import type { Meta, StoryObj } from "@storybook/react-vite";
import { makeSessions, nisiDetail } from "./repositories.fixture";
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

export const UnresolvedStates: Story = {
	args: {
		initialPath: DETAIL_PATH,
		data: {
			repositoryDetail: nisiDetail({
				sessions: makeSessions(12, Date.now()).map((session, index) =>
					index % 4 === 1
						? {
								...session,
								state: {
									kind: "unresolved" as const,
									reason:
										unresolvedReasons[(index - 1) / 4] ?? unresolvedReasons[0],
								},
							}
						: session,
				),
			}),
		},
	},
};

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
