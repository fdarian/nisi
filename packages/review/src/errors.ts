import { Schema } from "effect";

export class ReviewStoreError extends Schema.TaggedErrorClass<ReviewStoreError>()(
	"ReviewStoreError",
	{ cause: Schema.Defect() },
) {}

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()(
	"SessionNotFound",
	{ sessionId: Schema.String },
) {}
