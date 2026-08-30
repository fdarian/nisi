import { Schema } from "effect";

export class SettingsStoreError extends Schema.TaggedError<SettingsStoreError>()(
	"SettingsStoreError",
	{ cause: Schema.Defect() },
) {}
