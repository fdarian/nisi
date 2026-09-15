import type { Greeting } from "./values.ts";
import { greet } from "./values.ts";

export function run(name: string): Greeting {
	return greet(name);
}

export function runAgain(name: string): Greeting {
	return greet(name);
}
