import { Schema } from "effect";

export class SettingsStoreError extends Schema.TaggedErrorClass<SettingsStoreError>()(
	"SettingsStoreError",
	{ cause: Schema.Defect() },
) {}
