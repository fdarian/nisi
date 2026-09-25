import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createMockOrpc } from "../../../../.storybook/mock-orpc";
import {
	type PullRequestMergeStatus,
	type PullRequestMergeStatusParams,
	waitForMergedStatus,
} from "./pr-data";

const PR: PullRequestMergeStatusParams = {
	repoRoot: "/work/widgets",
	owner: "acme",
	repo: "widgets",
	number: 42,
};

const OPEN: PullRequestMergeStatus = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isDraft: false,
	allowedMethods: ["squash"],
	defaultMethod: "squash",
};

describe("waitForMergedStatus", () => {
	test("waits for this PR's live status, not another PR or the regular query", async () => {
		const client = new QueryClient();
		const orpc = createMockOrpc();
		const key = orpc.pullRequests.mergeStatus.liveKey({ input: PR });
		client.setQueryData(key, OPEN);

		let settled = false;
		const wait = waitForMergedStatus(client, orpc, PR, 1000).then(() => {
			settled = true;
		});
		client.setQueryData(
			orpc.pullRequests.mergeStatus.liveKey({
				input: { ...PR, number: 43 },
			}),
			{ ...OPEN, state: "MERGED" },
		);
		client.setQueryData(orpc.pullRequests.mergeStatus.queryKey({ input: PR }), {
			...OPEN,
			state: "MERGED",
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		client.setQueryData(key, { ...OPEN, state: "MERGED" });
		await wait;
		expect(settled).toBe(true);
	});

	test("resolves when status is already merged", async () => {
		const client = new QueryClient();
		const orpc = createMockOrpc();
		client.setQueryData(orpc.pullRequests.mergeStatus.liveKey({ input: PR }), {
			...OPEN,
			state: "MERGED",
		});
		await waitForMergedStatus(client, orpc, PR, 1000);
	});

	test("resolves without changing status after a timeout", async () => {
		const client = new QueryClient();
		const orpc = createMockOrpc();
		client.setQueryData(
			orpc.pullRequests.mergeStatus.liveKey({ input: PR }),
			OPEN,
		);
		await waitForMergedStatus(client, orpc, PR, 10);
		expect(
			client.getQueryData<PullRequestMergeStatus>(
				orpc.pullRequests.mergeStatus.liveKey({ input: PR }),
			)?.state,
		).toBe("OPEN");
	});
});
