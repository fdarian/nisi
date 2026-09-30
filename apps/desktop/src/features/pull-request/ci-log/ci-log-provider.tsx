import { openUrl } from "@tauri-apps/plugin-opener";
import { createContext, useContext, useEffect, useState } from "react";
import { toastManager } from "#/components/ui/toast";
import type { Session } from "#/features/pull-request/data/pr-data";
import type { CiCheck } from "#/features/pull-request/header/ci-status";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { CiLogDialog } from "./ci-log-dialog";

const OpenCiCheck = createContext<((check: CiCheck) => void) | null>(null);

export function useOpenCiCheck() {
	const open = useContext(OpenCiCheck);
	return (check: CiCheck) => {
		if (check.actionsJobId !== undefined) {
			if (open !== null) open(check);
			else
				toastManager.add({
					title: "Job viewer is unavailable in this view",
					type: "error",
				});
		} else if (check.detailsUrl !== undefined) {
			void openUrl(check.detailsUrl).catch((error: unknown) =>
				toastManager.add({
					title: "Couldn't open check",
					description: String(error),
					type: "error",
				}),
			);
		}
	};
}

export function CiLogProvider(props: {
	session: Session;
	orpc: SidecarQueryUtils;
	active: boolean;
	children: React.ReactNode;
}) {
	const selection = useState<CiCheck | null>(null);
	useEffect(() => {
		if (!props.active) selection[1](null);
	}, [props.active]);
	const target = props.session.target;
	const check = selection[0];
	return (
		<OpenCiCheck value={selection[1]}>
			{props.children}
			{props.active &&
				target.kind === "pr" &&
				check !== null &&
				check.actionsJobId !== undefined && (
					<CiLogDialog
						key={check.actionsJobId}
						orpc={props.orpc}
						runId={check.actionsRunId}
						params={{
							repoRoot: props.session.repoRoot,
							owner: target.owner,
							repo: target.repo,
							number: target.number,
							jobId: check.actionsJobId,
						}}
						workflowName={
							check.workflowName === undefined
								? check.detail
								: check.workflowName
						}
						onClose={() => selection[1](null)}
						onJobChange={(jobId) =>
							selection[1]((current) =>
								current === null ? null : { ...current, actionsJobId: jobId },
							)
						}
					/>
				)}
		</OpenCiCheck>
	);
}
