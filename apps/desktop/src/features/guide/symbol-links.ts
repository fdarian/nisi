import type { GuideSymbol } from "@repo/sidecar-api";

export function symbolMap(
	symbols: readonly GuideSymbol[],
): ReadonlyMap<string, GuideSymbol> {
	return new Map(symbols.map((symbol) => [symbol.name, symbol]));
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A span ending in one of these is a filename (`cli.ts`), and `cli` being declared somewhere must not link it. */
const FILE_EXTENSIONS = new Set([
	"ts",
	"tsx",
	"mts",
	"cts",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"jsonc",
	"json5",
	"md",
	"mdx",
	"yaml",
	"yml",
	"toml",
	"rs",
	"go",
	"py",
	"rb",
	"java",
	"kt",
	"swift",
	"c",
	"h",
	"cpp",
	"css",
	"scss",
	"html",
	"sh",
	"zsh",
	"sql",
	"lock",
	"txt",
	"env",
	"svg",
	"png",
]);

/**
 * The declaration a backticked span names, when the whole span is a declared
 * identifier: `useThing`, `useThing()`, or `Thing.method` where `Thing` is the
 * declared name (the link goes to `Thing`'s declaration). Anything else —
 * `a + b`, `foo(bar)`, an undeclared or ambiguous name, or anything that
 * reads as a filename (`cli.ts`, `src/cli`) — stays plain code. A call
 * (`res.json()`) is never a filename, so its trailing member can match an extension.
 */
export function symbolFromCode(
	text: string,
	symbols: ReadonlyMap<string, GuideSymbol>,
): GuideSymbol | null {
	const isCall = text.endsWith("()");
	const bare = isCall ? text.slice(0, -2) : text;
	const parts = bare.split(".");
	if (
		!isCall &&
		parts.length > 1 &&
		FILE_EXTENSIONS.has(parts[parts.length - 1] as string)
	) {
		return null;
	}
	if (!parts.every((part) => IDENTIFIER.test(part))) return null;
	return symbols.get(parts[0] as string) ?? null;
}
