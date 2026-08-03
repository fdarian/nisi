import type { Decorator, Preview } from "@storybook/react-vite";
import "#/index.css";
import { StoryProviders } from "./decorators";

const withStoryProviders: Decorator = (Story) => (
	<StoryProviders>
		<Story />
	</StoryProviders>
);

const preview: Preview = {
	parameters: {
		layout: "fullscreen",
	},
	decorators: [withStoryProviders],
};

export default preview;
