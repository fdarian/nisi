import type { Meta, StoryObj } from "@storybook/react-vite";
import { DotLoader } from "./dot-loader";

const meta = {
	title: "Components/DotLoader",
	component: DotLoader,
} satisfies Meta<typeof DotLoader>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { className: "w-10 text-foreground" },
};

export const Sizes: Story = {
	render: () => (
		<div className="flex items-center gap-6 text-muted-foreground">
			<DotLoader className="w-4" />
			<DotLoader className="w-8" />
			<DotLoader className="w-16" />
		</div>
	),
};
