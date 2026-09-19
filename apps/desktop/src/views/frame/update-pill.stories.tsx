/**
 * Temporary Storybook coverage for `UpdatePill`'s four visible states —
 * added only to visually verify the pill/circle shape and the `downloading`
 * collapse without a live sidecar or a real Homebrew-cask install (this repo
 * checkout never reports anything but `unsupported` for real). Not meant to
 * stick around as permanent coverage — delete freely once verified, same as
 * `pr-merge-button.stories.tsx`'s own temporary coverage.
 *
 * Builds a minimal fake `SidecarClient` directly rather than extending
 * `.storybook/mock-orpc.ts`'s `createMockOrpc` — that mock's `update.status`
 * is hardcoded to `unsupported` (the honest default for every dev machine
 * building Storybook), and this file only ever needs `update.*`, so there's
 * nothing to gain from wiring a fourth `MockOrpcData` field through the
 * shared mock for a story meant to be thrown away.
 */
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { SidecarClient } from "@repo/sidecar-api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { UpdateState } from "#/lib/update-data";
import { UpdatePill } from "./update-pill";

function orpcFor(state: UpdateState): SidecarQueryUtils {
	const client = {
		update: {
			status: async () => state,
			download: async () => undefined,
			restart: async () => undefined,
		},
	} as unknown as SidecarClient;
	return createTanstackQueryUtils(client);
}

const meta: Meta<typeof UpdatePill> = {
	title: "UpdatePill",
	component: UpdatePill,
	parameters: { layout: "centered" },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const Available: Story = {
	args: { orpc: orpcFor({ type: "available", version: "0.3.0" }) },
};

export const Downloading: Story = {
	args: { orpc: orpcFor({ type: "downloading", version: "0.3.0" }) },
};

export const Ready: Story = {
	args: { orpc: orpcFor({ type: "ready", version: "0.3.0" }) },
};

export const Failed: Story = {
	args: {
		orpc: orpcFor({
			type: "failed",
			version: "0.3.0",
			message: "brew upgrade exited with code 1",
		}),
	},
};
