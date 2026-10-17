import { Switch } from "#/components/ui/switch";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import { useWalkthroughEnabled } from "./settings-data";
import { SettingsRow, SettingsSection } from "./settings-section";

export function FeatureFlagsPage(): React.ReactElement | null {
	const backend = useBackendContext();
	if (backend.status !== "ready") return null;
	return <FeatureFlagsContent orpc={backend.orpc} />;
}

function FeatureFlagsContent(props: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-8 py-12">
			<h1 className="font-semibold text-2xl tracking-tight">Feature Flags</h1>
			<FeatureFlagsSection orpc={props.orpc} />
		</div>
	);
}

/**
 * The master toggle for the entire walkthrough feature — currently
 * unstable, so it defaults to off (see `@repo/settings`'s
 * `walkthroughEnabled`). It also gates the PR view's Walkthrough tab/keyboard
 * shortcuts (`pr-view.tsx`).
 */
function FeatureFlagsSection({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const [walkthroughEnabled, setWalkthroughEnabled] =
		useWalkthroughEnabled(orpc);

	return (
		<SettingsSection>
			<SettingsRow
				description="Let an agent narrate this PR, every claim linked to a set of line ranges. Unstable — off by default."
				title="Enable walkthrough"
			>
				<Switch
					checked={walkthroughEnabled}
					onCheckedChange={setWalkthroughEnabled}
				/>
			</SettingsRow>
		</SettingsSection>
	);
}
