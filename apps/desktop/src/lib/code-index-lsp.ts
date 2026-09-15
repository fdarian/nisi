import type {
	CodeIndexLspStatus,
	CodeIndexLspStatusName,
} from "@repo/sidecar-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toastManager } from "#/components/ui/toast";
import type { SidecarQueryUtils } from "#/lib/backend-context";

export type CodeIndexLspControlState = {
	readonly status: CodeIndexLspStatusName;
	readonly error: string | null;
	readonly toggle: () => void;
	readonly isPending: boolean;
};

export const codeIndexLspStatusForControl = (
	status: CodeIndexLspStatus | undefined,
	starting: boolean,
): CodeIndexLspStatusName => {
	if (starting) return "starting";
	return status?.status ?? "off";
};

export function useCodeIndexLspControl(
	orpc: SidecarQueryUtils,
	sessionId: string,
	setEnabled: (enabled: boolean) => void,
): CodeIndexLspControlState {
	const queryClient = useQueryClient();
	const input = { sessionId };
	const statusQuery = useQuery({
		...orpc.codeIndex.lspStatus.queryOptions({ input }),
		refetchInterval: (query) =>
			query.state.data?.status === "starting" ? 250 : false,
		retry: false,
	});
	const statusKey = orpc.codeIndex.lspStatus.queryKey({ input });
	const startMutation = useMutation({
		...orpc.codeIndex.startLsp.mutationOptions(),
		onError: (error) => {
			setEnabled(false);
			void queryClient.invalidateQueries({ queryKey: statusKey });
			toastManager.add({
				title: "Couldn't start LSP",
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
		onSuccess: (status) => {
			queryClient.setQueryData(statusKey, status);
		},
	});
	const stopMutation = useMutation({
		...orpc.codeIndex.stopLsp.mutationOptions(),
		onError: (error) => {
			void queryClient.invalidateQueries({ queryKey: statusKey });
			toastManager.add({
				title: "Couldn't stop LSP",
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
		onSuccess: (status) => {
			queryClient.setQueryData(statusKey, status);
		},
	});
	const starting = startMutation.isPending;
	const status = codeIndexLspStatusForControl(statusQuery.data, starting);
	const toggle = useCallback(() => {
		if (stopMutation.isPending) return;
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
