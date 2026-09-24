import { expect, test } from "bun:test";
import { createChatStore, isSandboxStatus } from "./chat-store";

test("a thread moves from setting up to ready and clears on close", () => {
	const store = createChatStore();
	store.getState().openNewThread("session", "thread");
	for (const phase of ["setting-up", "ready"] as const) {
		const chunk = {
			type: "data-sandbox-status",
			data: { phase },
			transient: true,
		};
		expect(isSandboxStatus(chunk)).toBe(true);
		if (!isSandboxStatus(chunk))
			throw new Error("invalid sandbox status chunk");
		store.getState().setSandboxPhase("session", "thread", chunk.data.phase);
		expect(
			store.getState().sessions.get("session")?.threads[0]?.sandboxPhase,
		).toBe(phase);
	}
	store.getState().closeThread("session", "thread");
	expect(store.getState().sessions.get("session")?.threads).toEqual([]);
});
