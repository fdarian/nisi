import { expect, test } from "bun:test";
import { createWorkloadSteps } from "./measurement-workload.ts";

test("a step is replayed until acknowledged, then reports its outcome", () => {
	const steps = createWorkloadSteps();
	expect(steps.status("a")).toBeUndefined();
	steps.run("a", "scroll-files-changed");
	steps.run("a", "scroll-files-changed");
	expect(steps.list()).toHaveLength(1);
	expect(steps.list()[0]?.step).toBe("scroll-files-changed");
	expect(steps.status("a")).toEqual({ status: "pending" });
	steps.ack("a", true, undefined);
	expect(steps.list()).toHaveLength(0);
	expect(steps.status("a")).toEqual({ status: "ok" });
});

test("a failed acknowledgement carries its error and a finished id is not re-run", () => {
	const steps = createWorkloadSteps();
	steps.run("b", "close-other-tabs");
	steps.ack("b", false, "no tab");
	expect(steps.status("b")).toEqual({ status: "failed", error: "no tab" });
	steps.run("b", "close-other-tabs");
	expect(steps.list()).toHaveLength(0);
});
