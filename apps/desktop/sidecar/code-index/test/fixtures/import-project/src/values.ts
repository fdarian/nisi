/** A string that's specifically a greeting — the fixture's type-only import target. */
export type Greeting = string;

/** Builds a greeting for `name` — the fixture's value import target. */
export function greet(name: string): string {
	return `Hello, ${name}!`;
}
