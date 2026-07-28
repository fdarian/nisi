import { Schema } from "effect";

/** Any failure opening the shared connection or running a query — domain packages wrap this in their own tagged error rather than leaking it across the store boundary. */
export class DbError extends Schema.TaggedErrorClass<DbError>()("DbError", {
	cause: Schema.Defect(),
}) {}

export class MigrationApplyError extends Schema.TaggedErrorClass<MigrationApplyError>()(
	"MigrationApplyError",
	{ cause: Schema.Defect() },
) {}
