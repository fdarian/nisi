import type {
	CodeIndexLspStatus,
	CodeIndexLspStatusName,
} from "@repo/sidecar-api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { toastManager } from "#/components/ui/toast";
import type { SidecarQueryUtils } from "#/infra/backend-context";

export type CodeIndexLspControlState = {
	readonly status: CodeIndexLspStatusName;
	readonly error: string | null;
	readonly toggle: () => void;
	readonly isPending: boolean;
};

export const codeIndexLspStatusForControl = (
	status: CodeIndexLspStatus | undefined,
): CodeIndexLspStatusName => {
	return status?.status ?? "off";
};

export function useCodeIndexLspControl(
	orpc: SidecarQueryUtils,
	sessionId: string,
	setEnabled: (enabled: boolean) => void,
): CodeIndexLspControlState {
	const input = { sessionId };
	const statusQuery = useQuery({
		...orpc.codeIndex.lspStatus.queryOptions({ input }),
		retry: false,
	});
	useEffect(() => {
		const currentStatus = statusQuery.data?.status;
		if (currentStatus === undefined) return;
		setEnabled(currentStatus !== "off");
	}, [setEnabled, statusQuery.data?.status]);
	const startMutation = useMutation({
		...orpc.codeIndex.startLsp.mutationOptions(),
		onError: (error) => {
			setEnabled(false);
			toastManager.add({
				title: "Couldn't start LSP",
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
	});
	const stopMutation = useMutation({
		...orpc.codeIndex.stopLsp.mutationOptions(),
		onError: (error) => {
			setEnabled(true);
			toastManager.add({
				title: "Couldn't stop LSP",
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
	});
	const status = codeIndexLspStatusForControl(statusQuery.data);
	const toggle = useCallback(() => {
		if (startMutation.isPending || stopMutation.isPending) return;
		if (status === "off") {
			setEnabled(true);
			startMutation.mutate({ sessionId });
			return;
		}
		setEnabled(false);
		stopMutation.mutate({ sessionId });
	}, [sessionId, setEnabled, startMutation, status, stopMutation]);

	return {
		status,
		error: statusQuery.data?.error ?? null,
		toggle,
		isPending: startMutation.isPending || stopMutation.isPending,
	};
}
