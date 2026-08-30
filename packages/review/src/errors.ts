import { Schema } from "effect";

export class ReviewStoreError extends Schema.TaggedError<ReviewStoreError>()(
	"ReviewStoreError",
	{ cause: Schema.Defect() },
) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
	"SessionNotFound",
	{ sessionId: Schema.String },
) {}
