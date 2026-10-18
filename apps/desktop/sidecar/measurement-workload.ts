import type { WorkloadStep, WorkloadStepStatus } from "@repo/sidecar-api";
import { emit } from "./events.ts";

type WorkloadEvent = {
	type: "measurement-workload";
	id: string;
	step: WorkloadStep;
	seq: number;
};

/**
 * Scripted frontend interactions requested by `measure-launch --soak`. Like injected
 * deep links, a request is replayed to every new event subscriber until the frontend
 * acknowledges it; the outcome is kept so the requester can read it afterwards.
 */
export function createWorkloadSteps() {
	const pending = new Map<string, WorkloadEvent>();
	const results = new Map<string, WorkloadStepStatus>();
	return {
		run: (id: string, step: WorkloadStep) => {
			if (pending.has(id) || results.has(id)) return;
			if (pending.size >= 100)
				throw new Error("Too many unacknowledged measurement workload steps");
			const event = emit({ type: "measurement-workload", id, step });
			pending.set(id, { ...event, type: "measurement-workload", id, step });
		},
		list: () => [...pending.values()],
		ack: (id: string, ok: boolean, error: string | undefined) => {
			pending.delete(id);
			if (ok) results.set(id, { status: "ok" });
			else
				results.set(id, {
					status: "failed",
					error: error ?? "frontend reported failure without a message",
				});
		},
		status: (id: string): WorkloadStepStatus | undefined =>
			results.get(id) ?? (pending.has(id) ? { status: "pending" } : undefined),
	};
}

export const workloadSteps = createWorkloadSteps();
