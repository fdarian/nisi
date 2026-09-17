import { greet } from "./greeter.ts";

export function run(): string {
	return greet("world");
}

export function runAgain(): string {
	return greet("again");
}
