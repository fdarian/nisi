import { describe, expect, test } from "bun:test";
import { createTokenInteractionLeaseRegistry } from "#/components/diff-pane/token-interaction-leases";

describe("token interaction leases", () => {
	test("keeps token metadata enabled while any interactive view remains", () => {
		const leases = createTokenInteractionLeaseRegistry();
		const releaseFirst = leases.acquire();
		const releaseSecond = leases.acquire();

		expect(leases.hasLease()).toBe(true);
		releaseFirst();
		expect(leases.hasLease()).toBe(true);
		releaseFirst();
		expect(leases.hasLease()).toBe(true);
		releaseSecond();
		expect(leases.hasLease()).toBe(false);
	});
});
