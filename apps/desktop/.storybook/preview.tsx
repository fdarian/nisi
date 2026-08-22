import type { Decorator, Preview } from "@storybook/react-vite";
import "#/index.css";
import { StoryProviders, type StoryTheme } from "./decorators";

const withStoryProviders: Decorator = (Story, context) => (
	<StoryProviders theme={context.globals.theme as StoryTheme}>
		<Story />
	</StoryProviders>
);

const preview: Preview = {
	parameters: {
		layout: "fullscreen",
	},
	decorators: [withStoryProviders],
	globalTypes: {
		theme: {
			description: "Force a color scheme for review",
			toolbar: {
				title: "Theme",
				icon: "circlehollow",
				items: ["system", "light", "dark"],
				dynamicTitle: true,
			},
		},
	},
	initialGlobals: {
		theme: "system",
	},
};

export default preview;
