import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { GuideFile } from "./areas";
import { GuideProvider } from "./guide-context";
import {
	After,
	Area,
	Areas,
	Before,
	Event,
	Ref,
	Sequence,
	Step,
	Wait,
} from "./kit";

/** The diffstat from fdarian/nisi#149, the Overview the guide design was drawn from. */
const FILES: GuideFile[] = [
	{
		path: "apps/desktop/sidecar/repositories.ts",
		additions: 159,
		deletions: 82,
	},
	{
		path: "packages/git/src/github/gh/pull-request.ts",
		additions: 75,
		deletions: 0,
	},
	{
		path: "packages/sidecar-api/src/repositories.ts",
		additions: 53,
		deletions: 14,
	},
	{ path: "apps/desktop/sidecar/http.ts", additions: 23, deletions: 7 },
	{ path: "packages/git/src/github/github.ts", additions: 13, deletions: 0 },
	{ path: "packages/git/src/errors.ts", additions: 7, deletions: 0 },
	{ path: "packages/git/src/github/gh/github.ts", additions: 3, deletions: 0 },
	{ path: "packages/git/src/index.ts", additions: 1, deletions: 0 },
	{
		path: "packages/git/src/github/gh/watch.ts",
		additions: 2,
		deletions: 0,
	},
	{
		path: "packages/git/src/github/gh/graphql.ts",
		additions: 4,
		deletions: 1,
	},
	{
		path: "apps/desktop/src/features/settings/repositories/repository-detail-page.tsx",
		additions: 53,
		deletions: 13,
	},
	{
		path: "apps/desktop/src/features/settings/repositories/repositories-view.ts",
		additions: 47,
		deletions: 4,
	},
	{
		path: "apps/desktop/src/features/settings/repositories/repositories-data.ts",
		additions: 21,
		deletions: 0,
	},
	{
		path: "apps/desktop/src/features/settings/repositories/repositories-data.test.ts",
		additions: 90,
		deletions: 0,
	},
];

function Overview(props: { width: number }): React.ReactElement {
	const [areaOrder, setAreaOrder] = useState<readonly string[]>([]);
	const [hoveredArea, setHoveredArea] = useState<string | null>(null);
	return (
		<GuideProvider
			value={{
				sessionId: "story",
				files: FILES,
				changedPaths: new Set(FILES.map((file) => file.path)),
				checks: [],
				headSha: "0".repeat(40),
				selectedRef: null,
				selectRef: () => {},
				areaOrder,
				setAreaOrder,
				hoveredArea,
				setHoveredArea,
			}}
		>
			<div
				className="@container overflow-auto p-6"
				style={{ width: props.width }}
			>
				<div className="flex flex-col gap-3 text-foreground text-sm leading-relaxed">
					<h2 className="mt-2 border-b pb-1 font-heading font-semibold text-base">
						Overview
					</h2>
					<p>
						The detail page no longer waits on GitHub. It renders from what nisi
						already knows, then streams in each PR's state.
					</p>
					<Sequence
						lanes={["Sidecar", "Page"]}
						title="Opening a repository's page"
					>
						<Before caption="Nothing shows until every PR's state has been fetched, and nothing is saved until the last one returns.">
							<Step area="fetching" lane="Sidecar" span={8}>
								get: gh pr view × every session
							</Step>
							<Wait lane="Page" span={8} />
							<Step area="ui" lane="Page" span={2}>
								everything renders
							</Step>
						</Before>
						<After caption="The page renders as soon as get answers; each tick is a sessionStates event filling in rows.">
							<Step area="fetching" lane="Sidecar" span={1}>
								get
							</Step>
							<Step area="fetching" lane="Sidecar" span={2}>
								gh pr list
							</Step>
							<Step area="fetching" lane="Sidecar" span={4}>
								gh pr view × missed only
							</Step>
							<Wait lane="Page" span={1} />
							<Step area="ui" lane="Page" span={2}>
								renders now
							</Step>
							<Event area="ui" at={4} lane="Page" />
							<Event area="ui" at={5} lane="Page" />
							<Event area="ui" at={6} lane="Page" />
						</After>
					</Sequence>
					<Areas>
						<Area
							id="fetching"
							paths={[
								"apps/desktop/sidecar/**",
								"packages/git/src/**",
								"packages/sidecar-api/src/**",
							]}
							subtitle="sidecar · contract · git"
							title="Fetching"
						>
							<ul className="list-disc space-y-1 pl-5">
								<li>
									<code>repositories.get</code> answers from local data only:
									each session is <code>resolved</code> or <code>pending</code>.{" "}
									<Ref path="apps/desktop/sidecar/repositories.ts" />
								</li>
								<li>
									New <code>sessionStates</code> stream: one{" "}
									<code>gh pr list</code>, then <code>gh pr view</code> only for
									numbers the list missed.
								</li>
								<li>
									Each state is saved before it's sent, so leaving mid-stream
									keeps the progress.
								</li>
							</ul>
						</Area>
						<Area
							id="ui"
							paths={["apps/desktop/src/features/settings/**"]}
							subtitle="Settings › Repositories"
							title="UI"
						>
							<ul className="list-disc space-y-1 pl-5">
								<li>
									Location and every row appear on first paint.{" "}
									<Ref path="apps/desktop/src/features/settings/repositories/repository-detail-page.tsx" />
								</li>
								<li>
									A pending row shows a skeleton in its icon slot, so nothing
									shifts when the state lands.
								</li>
								<li>
									The Open, Merged and Closed tabs fill in as events arrive.
								</li>
							</ul>
						</Area>
					</Areas>
				</div>
			</div>
		</GuideProvider>
	);
}

const meta = {
	title: "Guide/Overview",
	component: Overview,
	parameters: { controls: { disable: true } },
} satisfies Meta<typeof Overview>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Wide: Story = { args: { width: 860 } };

/** Under the 2xl container width the cards stack. */
export const Narrow: Story = { args: { width: 520 } };
