export type TokenInteractionLeaseRegistry = {
	acquire: () => () => void;
	hasLease: () => boolean;
};

export function createTokenInteractionLeaseRegistry(): TokenInteractionLeaseRegistry {
	const leases = new Set<symbol>();

	return {
		acquire: () => {
			const lease = Symbol("token-interaction");
			leases.add(lease);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				leases.delete(lease);
			};
		},
		hasLease: () => leases.size > 0,
	};
}
