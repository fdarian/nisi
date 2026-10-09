import type { GuideSymbol } from "@repo/sidecar-api";

export function symbolMap(
	symbols: readonly GuideSymbol[],
): ReadonlyMap<string, GuideSymbol> {
	return new Map(symbols.map((symbol) => [symbol.name, symbol]));
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The declaration a backticked span names, when the whole span is a declared
 * identifier: `useThing`, `useThing()`, or `Thing.method` where `Thing` is the
 * declared name (the link goes to `Thing`'s declaration). Anything else —
 * `a + b`, `foo(bar)`, an undeclared or ambiguous name — stays plain code.
 */
export function symbolFromCode(
	text: string,
	symbols: ReadonlyMap<string, GuideSymbol>,
): GuideSymbol | null {
	const bare = text.endsWith("()") ? text.slice(0, -2) : text;
	const parts = bare.split(".");
	if (!parts.every((part) => IDENTIFIER.test(part))) return null;
	return symbols.get(parts[0] as string) ?? null;
}
