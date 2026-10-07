import { expect, test } from "bun:test";
import type { OpenRequest, Session } from "@repo/sidecar-api";
import { derivePendingOpenTab } from "./pending-open-tab";

const deepLink = { owner: "risedle", repo: "mockingbird", number: 157 };

const session: Session = {
	id: "pr-157",
	repoRoot: "/repo",
	target: {
		kind: "pr",
		number: 157,
		title: "Add integrations",
		owner: "risedle",
		repo: "mockingbird",
		baseRef: "main",
		headRef: "feature",
	},
};

function request(status: OpenRequest["status"]): OpenRequest {
	return { id: "req-1", cwd: "/work/tree", target: { kind: "auto" }, status };
}

function derive(
	input: Partial<Parameters<typeof derivePendingOpenTab>[0]> = {},
) {
	return derivePendingOpenTab({
		request: null,
		dismissRequest: () => {},
		deepLink: null,
		sessions: [],
		...input,
	});
}

test("idle shows no placeholder", () => {
	expect(derive()).toBeNull();
});

test("a pending CLI request keeps the Opening… label", () => {
	expect(derive({ request: request({ kind: "pending" }) })).toEqual({
		id: "req-1",
		label: "Opening…",
		status: "opening",
	});
});

test("a resolved CLI request hands over to the real tab", () => {
	expect(derive({ request: request({ kind: "opened", session }) })).toBeNull();
});

test("a failed CLI request shows its failure and dismisses by request id", () => {
	const dismissed: string[] = [];
	const tab = derive({
		request: request({ kind: "failed", message: "not a git repository" }),
		dismissRequest: (id) => dismissed.push(id),
	});
	expect(tab?.status).toBe("failed");
	expect(tab?.label).toBe("Open failed");
	expect(tab?.failure?.title).toBe("Couldn’t open /work/tree");
	expect(tab?.failure?.message).toBe("not a git repository");
	tab?.failure?.dismiss();
	expect(dismissed).toEqual(["req-1"]);
});

test("an in-flight deep link is labelled with the PR before it resolves", () => {
	expect(derive({ deepLink })).toEqual({
		id: "risedle/mockingbird#157",
		label: "#157 risedle/mockingbird",
		status: "opening",
		pullRequest: deepLink,
	});
});

test("a CLI placeholder knows nothing about the PR, so the skeleton shows bars", () => {
	expect(
		derive({ request: request({ kind: "pending" }) })?.pullRequest,
	).toBeUndefined();
});

test("a CLI request wins the placeholder without leaking the deep link's PR", () => {
	expect(
		derive({ request: request({ kind: "pending" }), deepLink })?.pullRequest,
	).toBeUndefined();
});

test("a deep link for an already-open PR shows no placeholder", () => {
	expect(derive({ deepLink, sessions: [session] })).toBeNull();
});

test("the placeholder drops in the commit where the session is seeded", () => {
	expect(derive({ deepLink, sessions: [] })?.status).toBe("opening");
	expect(derive({ deepLink, sessions: [session] })).toBeNull();
});

test("an error or cancelled picker clears the deep link and drops the placeholder", () => {
	expect(derive({ deepLink: null })).toBeNull();
});

test("a different PR's session does not hide the placeholder", () => {
	const other: Session = {
		...session,
		id: "pr-12",
		target: { ...session.target, number: 12 },
	};
	expect(derive({ deepLink, sessions: [other] })?.id).toBe(
		"risedle/mockingbird#157",
	);
});

test("an opening deep link wins over a failed CLI request", () => {
	const tab = derive({
		request: request({ kind: "failed", message: "boom" }),
		deepLink,
	});
	expect(tab?.status).toBe("opening");
});

test("a pending CLI request wins over an opening deep link", () => {
	expect(derive({ request: request({ kind: "pending" }), deepLink })?.id).toBe(
		"req-1",
	);
});

test("a failed CLI request shows once the deep link has handed over", () => {
	const tab = derive({
		request: request({ kind: "failed", message: "boom" }),
		deepLink,
		sessions: [session],
	});
	expect(tab?.status).toBe("failed");
});
