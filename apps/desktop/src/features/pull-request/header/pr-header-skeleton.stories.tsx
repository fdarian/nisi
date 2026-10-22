import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrHeaderSkeleton } from "./pr-header-skeleton";

const meta: Meta<typeof PrHeaderSkeleton> = {
	title: "Pr/PrHeaderSkeleton",
	component: PrHeaderSkeleton,
	parameters: { layout: "fullscreen", controls: { disable: true } },
};
export default meta;

type Story = StoryObj<typeof meta>;

/** A deep link already names the PR: text for the repo and number, bars for the rest. */
export const KnownPullRequest: Story = {
	args: { pullRequest: { owner: "acme", repo: "widgets", number: 42 } },
};

export const Unknown: Story = {};
