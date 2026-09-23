import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CiCheck } from "./ci-status";
import { CiStatus } from "./ci-status";

const meta: Meta<typeof CiStatus> = {
	title: "Pr/CiStatus",
	component: CiStatus,
	parameters: { layout: "centered", controls: { disable: true } },
};
export default meta;

type Story = StoryObj<typeof meta>;

const CHECKS: readonly CiCheck[] = [
	{
		name: "build",
		status: "passing",
		detail: "1m 12s",
		detailsUrl: "https://github.com/risedle/mockingbird/actions/runs/1",
	},
	{
		name: "typecheck",
		status: "passing",
		detail: "48s",
		detailsUrl: "https://github.com/risedle/mockingbird/actions/runs/2",
	},
	{ name: "lint", status: "passing", detail: "22s" },
	{ name: "test (bun)", status: "passing", detail: "3m 04s" },
];

/** Everything green — the ring is a solid segmented circle. */
export const AllPassing: Story = {
	args: { checks: CHECKS },
};

/** One red arc is the whole point: it's findable at 22px without reading anything. */
export const Failing: Story = {
	args: {
		checks: [
			...CHECKS.slice(0, 3),
			{ name: "test (bun)", status: "failing", detail: "2 failed" },
		],
	},
};

/** In-flight checks pulse, so a still-running pipeline reads differently from a settled amber. */
export const Running: Story = {
	args: {
		checks: [
			{ name: "build", status: "passing", detail: "1m 12s" },
			{ name: "typecheck", status: "running" },
			{ name: "lint", status: "running" },
			{ name: "test (bun)", status: "pending" },
		],
	},
};

/** Mixed bag — failing outranks running in the popover headline. */
export const Mixed: Story = {
	args: {
		checks: [
			{ name: "build", status: "passing", detail: "1m 12s" },
			{ name: "typecheck", status: "failing", detail: "3 errors" },
			{ name: "lint", status: "running" },
			{ name: "test (bun)", status: "pending" },
			{ name: "e2e", status: "skipped", detail: "no matching paths" },
		],
	},
};

/** A single check gets an unbroken ring — a gap would imply a second check that isn't there. */
export const SingleCheck: Story = {
	args: {
		checks: [{ name: "ci", status: "passing", detail: "2m 30s" }],
	},
};

/**
 * Many checks — the inter-segment gap shrinks proportionally so segments stay
 * visible instead of being eaten by the gap.
 */
export const ManyChecks: Story = {
	args: {
		checks: [
			{ name: "build (macos-14)", status: "passing" },
			{ name: "build (ubuntu-latest)", status: "passing" },
			{ name: "build (windows-latest)", status: "failing" },
			{ name: "typecheck", status: "passing" },
			{ name: "lint", status: "passing" },
			{ name: "test (node 20)", status: "passing" },
			{ name: "test (node 22)", status: "running" },
			{ name: "test (bun)", status: "running" },
			{ name: "e2e", status: "pending" },
			{ name: "codeql", status: "pending" },
			{ name: "vercel — preview deployment", status: "passing" },
			{ name: "changeset", status: "skipped" },
		],
	},
};

/**
 * Long names truncate rather than widening the popover; the status column stays
 * pinned right.
 */
export const LongNames: Story = {
	args: {
		checks: [
			{
				name: "continuous-integration/jenkins/pr-merge/build-and-publish-artifacts",
				status: "passing",
				detail: "8m 41s",
			},
			{
				name: "netlify/deploy-preview/nisi-desktop-storybook",
				status: "failing",
				detail: "build failed",
			},
		],
	},
};

/**
 * Two workflows each defining a job called `test` — real GitHub Actions
 * data doesn't guarantee unique job names, only unique (workflow, job)
 * pairs. `CiStatus` keys its ring segments and popover rows on `name`, so
 * this component trusts its caller (`pr-ci-status.tsx`) to have already
 * qualified any collision as `"<workflow> / <job>"` before these ever
 * arrive here — this story is what that qualified input looks like, not a
 * disambiguation `CiStatus` itself performs.
 */
export const DisambiguatedSameJobName: Story = {
	args: {
		checks: [
			{ name: "CI / test", status: "passing", detail: "1m 40s" },
			{ name: "Nightly / test", status: "failing", detail: "3m 12s" },
			{ name: "CI / build", status: "passing", detail: "58s" },
		],
	},
};
