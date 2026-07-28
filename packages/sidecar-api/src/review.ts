import { oc } from "@orpc/contract";
import { Schema } from "effect";

export const reviewContract = {
	/**
	 * Writes the file's content snapshot immediately, even though Phase 1 does
	 * nothing with it yet — Phase 2's reconciliation is then purely additive,
	 * not a migration. See PLAN.md's Phase 1 note.
	 */
	setViewed: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				path: Schema.String,
				viewed: Schema.Boolean,
			}),
		)
		.output(Schema.Void)
		.errors({ NOT_FOUND: {} }),
};
