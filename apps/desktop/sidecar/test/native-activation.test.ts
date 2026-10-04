import { expect, spyOn, test } from "bun:test";
import { createNativeActivationHandler } from "../native-activation.ts";
import {
	acknowledgeActivation,
	acknowledgeOpenRequest,
	createOpenRequest,
} from "../open-requests.ts";

function activationRequest(path: string, owner: string, method = "GET") {
	return new Request(`http://127.0.0.1/native/activation${path}`, {
		method,
		headers: {
			authorization: "Bearer token",
			"x-nisi-activation-owner": owner,
		},
	});
}

test("only a disconnected owner's authenticated stream can be claimed", async () => {
	let now = 1_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const request = createOpenRequest("/repo", { kind: "auto" });
	const handle = createNativeActivationHandler("token", "old-owner");
	try {
		const unauthorized = await handle(
			new Request("http://127.0.0.1/native/activation"),
		);
		expect(unauthorized?.status).toBe(401);
		expect((await handle(activationRequest("", "new-owner")))?.status).toBe(
			403,
		);
		const response = await handle(activationRequest("", "old-owner"));
		expect(response?.status).toBe(200);
		const reader = response?.body?.getReader();
		if (reader === undefined) throw new Error("activation stream has no body");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain(request.id);
		now += 11_000;
		expect(
			(await handle(activationRequest("/claim", "new-owner", "POST")))?.status,
		).toBe(409);
		await reader.cancel();
		expect(
			(await handle(activationRequest("/claim", "new-owner", "POST")))?.status,
		).toBe(409);
		now += 2_001;
		expect(
			(await handle(activationRequest("/claim", "new-owner", "POST")))?.status,
		).toBe(204);
		expect((await handle(activationRequest("", "old-owner")))?.status).toBe(
			403,
		);
		const claimed = await handle(activationRequest("", "new-owner"));
		expect(claimed?.status).toBe(200);
		await claimed?.body?.cancel();
		expect(
			(
				await handle(
					activationRequest(`/ack?id=${request.id}`, "old-owner", "POST"),
				)
			)?.status,
		).toBe(403);
		expect(
			(
				await handle(
					activationRequest(`/ack?id=${request.id}`, "new-owner", "POST"),
				)
			)?.status,
		).toBe(204);
	} finally {
		clock.mockRestore();
		acknowledgeActivation(request.id);
		acknowledgeOpenRequest(request.id);
	}
});
