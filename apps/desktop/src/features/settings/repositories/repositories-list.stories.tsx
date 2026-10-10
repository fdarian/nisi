import type { Meta, StoryObj } from "@storybook/react-vite";
import { REPOSITORIES } from "./repositories.fixture";
import {
	RepositoriesStory,
	stubTauriForRepositories,
} from "./repositories-story-harness";

const LIST_PATH = "/settings/repositories";

const meta = {
	title: "Settings/Repositories/List",
	component: RepositoriesStory,
	beforeEach: stubTauriForRepositories,
	parameters: { controls: { disable: true } },
} satisfies Meta<typeof RepositoriesStory>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { initialPath: LIST_PATH, data: { repositories: REPOSITORIES } },
};

export const Loading: Story = {
	args: { initialPath: LIST_PATH, data: { repositories: { pending: true } } },
};

export const Empty: Story = {
	args: { initialPath: LIST_PATH, data: { repositories: [] } },
};

export const LoadFailed: Story = {
	args: {
		initialPath: LIST_PATH,
		data: {
			repositories: { error: "database is locked" },
		},
	},
};
