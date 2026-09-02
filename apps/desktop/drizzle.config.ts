import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./sidecar/harness/db/schema.ts",
	out: "./drizzle",
	dialect: "sqlite",
});
