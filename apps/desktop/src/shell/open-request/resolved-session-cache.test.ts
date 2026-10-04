import { expect, test } from "bun:test";
import type { Session } from "@repo/sidecar-api";
import { isCancelledError, QueryClient } from "@tanstack/react-query";
import { seedResolvedSession } from "./resolved-session-cache";

const session: Session = {
	id: "new-session",
	repoRoot: "/repo",
	target: {
		kind: "pr",
		number: 83,
		title: "New PR",
		owner: "fdarian",
		repo: "ff",
		baseRef: "main",
		headRef: "feature",
	},
};

test("resolved payload seeds a new session immediately and corrects it without duplication", () => {
	const client = new QueryClient();
	const key = ["sessions", "list"];
	seedResolvedSession(client, key, session);
	expect(client.getQueryData(key)).toEqual([session]);
	const corrected: Session = {
		...session,
		target: { ...session.target, baseRef: "release" },
	};
	seedResolvedSession(client, key, corrected);
	expect(client.getQueryData(key)).toEqual([corrected]);
	client.clear();
});

test("an in-flight older list cannot overwrite the resolved session", async () => {
	const client = new QueryClient();
	const key = ["sessions", "list"];
	const old = { ...session, id: "old-session" };
	client.setQueryData(key, [old]);
	const pending = Promise.withResolvers<Session[]>();
	const fetching = client
		.fetchQuery({ queryKey: key, queryFn: () => pending.promise })
		.catch((error) => {
			expect(isCancelledError(error)).toBe(true);
		});
	seedResolvedSession(client, key, session);
	pending.resolve([old]);
	await fetching;
	expect(client.getQueryData(key)).toEqual([old, session]);
	client.clear();
});
