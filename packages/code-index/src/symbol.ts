/**
 * Parses the SCIP symbol string grammar (`scip.proto`'s `<symbol>`
 * production, reproduced below) well enough to classify local vs. global,
 * derive a display name, and build a collision-free lookup key —
 * `SymbolInformation.displayName` is always empty from scip-typescript, so
 * the descriptor chain in the symbol string itself is the only source for a
 * name. Ported from the grammar (and scip's own Go reference parser,
 * `bindings/go/scip/symbol_parser.go`) rather than imported — there is no
 * TypeScript parser in `@scip-code/scip`, which only generates the protobuf
 * types.
 *
 * ```
 * <symbol>               ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
 * <package>              ::= <manager> ' ' <package-name> ' ' <version>
 * <scheme>/<manager>/<package-name>/<version> ::= any UTF-8, escape spaces with double space
 * <descriptor>           ::= <namespace> | <type> | <term> | <method> | <type-parameter> | <parameter> | <meta> | <macro>
 * <namespace>            ::= <name> '/'
 * <type>                 ::= <name> '#'
 * <term>                 ::= <name> '.'
 * <meta>                 ::= <name> ':'
 * <macro>                ::= <name> '!'
 * <method>               ::= <name> '(' (<method-disambiguator>)? ').'
 * <type-parameter>       ::= '[' <name> ']'
 * <parameter>            ::= '(' <name> ')'
 * <name>                 ::= <simple-identifier> | '`' <escaped-identifier> '`'
 * <simple-identifier>    ::= ('_' | '+' | '-' | '$' | letter | digit)+
 * <local-id>             ::= <simple-identifier>
 * ```
 */

export type DescriptorSuffix =
	| "namespace"
	| "type"
	| "term"
	| "method"
	| "typeParameter"
	| "parameter"
	| "meta"
	| "macro";

export type Descriptor = {
	readonly name: string;
	readonly suffix: DescriptorSuffix;
	/** Only ever non-empty for `suffix: "method"` — the `(<method-disambiguator>)` between the parens, distinguishing overloads. */
	readonly disambiguator: string;
};

export type ParsedSymbol =
	| { readonly kind: "local"; readonly localId: string }
	| {
			readonly kind: "global";
			readonly scheme: string;
			readonly packageManager: string;
			readonly packageName: string;
			readonly packageVersion: string;
			readonly descriptors: ReadonlyArray<Descriptor>;
	  };

/** A collision-free lookup key: a `local` symbol is only unique within its own document (see `symbolKeyOf`), so a bare `symbol` string is ambiguous on its own. */
export type SymbolKey = string & { readonly __brand: "SymbolKey" };

/** Per the SCIP spec, a symbol is local iff its string starts with the literal `local ` prefix — everything else is global. */
export const isLocalSymbol = (symbol: string): boolean =>
	symbol.startsWith("local ");

const isSimpleIdentifierChar = (ch: string): boolean =>
	ch === "_" ||
	ch === "+" ||
	ch === "-" ||
	ch === "$" ||
	(ch >= "a" && ch <= "z") ||
	(ch >= "A" && ch <= "Z") ||
	(ch >= "0" && ch <= "9");

type Cursor = { readonly value: string; readonly next: number };

/**
 * Reads one `<name>` — either a backtick-escaped identifier (doubled
 * backtick is a literal backtick) or a run of simple-identifier characters.
 * Mirrors `symbol_parser.go`'s `acceptIdentifier`/`acceptBacktickEscapedIdentifier`.
 */
const readName = (symbol: string, pos: number): Cursor => {
	if (symbol[pos] !== "`") {
		let i = pos;
		while (i < symbol.length && isSimpleIdentifierChar(symbol[i] ?? "")) {
			i += 1;
		}
		if (i === pos) {
			throw new Error(
				`expected an identifier at position ${pos} in symbol: ${symbol}`,
			);
		}
		return { value: symbol.slice(pos, i), next: i };
	}

	let i = pos + 1;
	let value = "";
	let anchor = i;
	while (i < symbol.length) {
		if (symbol[i] !== "`") {
			i += 1;
			continue;
		}
		if (symbol[i + 1] === "`") {
			value += symbol.slice(anchor, i + 1);
			i += 2;
			anchor = i;
			continue;
		}
		value += symbol.slice(anchor, i);
		return { value, next: i + 1 };
	}
	throw new Error(
		`unterminated backtick-escaped identifier at position ${pos} in symbol: ${symbol}`,
	);
};

/**
 * Reads one of the four space-terminated header fields (`scheme`, `manager`,
 * `package-name`, `version`) — a doubled space is an escaped literal space,
 * a single space ends the field. Mirrors `symbol_parser.go`'s
 * `acceptSpaceEscapedIdentifier`. The `.` placeholder for an empty package
 * field (`scip.proto`'s `Use the placeholder '.' to indicate an empty
 * value`) is normalized to `""` — never applied to `scheme`, which has no
 * such placeholder in the grammar.
 */
const readSpaceField = (symbol: string, pos: number): Cursor => {
	let i = pos;
	let value = "";
	let anchor = pos;
	while (i < symbol.length) {
		if (symbol[i] !== " ") {
			i += 1;
			continue;
		}
		i += 1;
		if (i >= symbol.length) break;
		if (symbol[i] === " ") {
			value += symbol.slice(anchor, i);
			i += 1;
			anchor = i;
			continue;
		}
		value += symbol.slice(anchor, i - 1);
		return { value, next: i };
	}
	throw new Error(
		`unterminated field starting at position ${pos} in symbol: ${symbol}`,
	);
};

type DescriptorCursor = {
	readonly descriptor: Descriptor;
	readonly next: number;
};

/** Reads one `<descriptor>`. Mirrors `symbol_parser.go`'s `parseDescriptor`. */
const readDescriptor = (symbol: string, pos: number): DescriptorCursor => {
	const opener = symbol[pos];
	if (opener === "(") {
		const name = readName(symbol, pos + 1);
		if (symbol[name.next] !== ")") {
			throw new Error(
				`expected ')' closing a parameter descriptor at position ${name.next} in symbol: ${symbol}`,
			);
		}
		return {
			descriptor: { name: name.value, suffix: "parameter", disambiguator: "" },
			next: name.next + 1,
		};
	}
	if (opener === "[") {
		const name = readName(symbol, pos + 1);
		if (symbol[name.next] !== "]") {
			throw new Error(
				`expected ']' closing a type-parameter descriptor at position ${name.next} in symbol: ${symbol}`,
			);
		}
		return {
			descriptor: {
				name: name.value,
				suffix: "typeParameter",
				disambiguator: "",
			},
			next: name.next + 1,
		};
	}

	const name = readName(symbol, pos);
	const suffixChar = symbol[name.next];
	switch (suffixChar) {
		case "/":
			return {
				descriptor: {
					name: name.value,
					suffix: "namespace",
					disambiguator: "",
				},
				next: name.next + 1,
			};
		case ".":
			return {
				descriptor: { name: name.value, suffix: "term", disambiguator: "" },
				next: name.next + 1,
			};
		case "#":
			return {
				descriptor: { name: name.value, suffix: "type", disambiguator: "" },
				next: name.next + 1,
			};
		case ":":
			return {
				descriptor: { name: name.value, suffix: "meta", disambiguator: "" },
				next: name.next + 1,
			};
		case "!":
			return {
				descriptor: { name: name.value, suffix: "macro", disambiguator: "" },
				next: name.next + 1,
			};
		case "(": {
			let i = name.next + 1;
			let disambiguator = "";
			if (symbol[i] !== ")") {
				const disambiguatorName = readName(symbol, i);
				disambiguator = disambiguatorName.value;
				i = disambiguatorName.next;
			}
			if (symbol[i] !== ")") {
				throw new Error(
					`expected ')' closing a method descriptor at position ${i} in symbol: ${symbol}`,
				);
			}
			i += 1;
			if (symbol[i] !== ".") {
				throw new Error(
					`expected '.' after a method descriptor's ')' at position ${i} in symbol: ${symbol}`,
				);
			}
			return {
				descriptor: { name: name.value, suffix: "method", disambiguator },
				next: i + 1,
			};
		}
		default:
			throw new Error(
				`unrecognized descriptor suffix ${JSON.stringify(suffixChar)} at position ${name.next} in symbol: ${symbol}`,
			);
	}
};

const readDescriptors = (
	symbol: string,
	startPos: number,
): ReadonlyArray<Descriptor> => {
	const descriptors: Array<Descriptor> = [];
	let pos = startPos;
	while (pos < symbol.length) {
		const result = readDescriptor(symbol, pos);
		descriptors.push(result.descriptor);
		pos = result.next;
	}
	if (descriptors.length === 0) {
		throw new Error(`global symbol has no descriptors: ${symbol}`);
	}
	return descriptors;
};

const normalizePlaceholder = (value: string): string =>
	value === "." ? "" : value;

/**
 * Parses a full SCIP symbol string into its local/global structure. Throws
 * on malformed input — scip-typescript is the only producer this package
 * decodes, so a symbol string that doesn't match the grammar is an
 * indexer-side invariant violation, not a recoverable user input; callers
 * decoding untrusted bytes (`decode.ts`) lift the throw into `ScipDecodeError`.
 */
export const parseSymbol = (symbol: string): ParsedSymbol => {
	if (symbol.length === 0) throw new Error("empty symbol");
	if (isLocalSymbol(symbol)) {
		const localId = symbol.slice("local ".length);
		return { kind: "local", localId };
	}

	const scheme = readSpaceField(symbol, 0);
	const manager = readSpaceField(symbol, scheme.next);
	const name = readSpaceField(symbol, manager.next);
	const version = readSpaceField(symbol, name.next);
	const descriptors = readDescriptors(symbol, version.next);

	return {
		kind: "global",
		scheme: scheme.value,
		packageManager: normalizePlaceholder(manager.value),
		packageName: normalizePlaceholder(name.value),
		packageVersion: normalizePlaceholder(version.value),
		descriptors,
	};
};

/**
 * The name to show a human for this symbol — the last descriptor's name for
 * a global symbol (e.g. `myMethod` out of `.../MyClass#myMethod().`), or the
 * raw local id for a local one. A local symbol's id is scip-typescript's own
 * per-document counter (`"0"`, `"1"`, ...), not the source variable's name —
 * the symbol string carries nothing better for locals; a caller wanting the
 * real name reads it from the source line itself.
 */
export const deriveDisplayName = (parsed: ParsedSymbol): string => {
	if (parsed.kind === "local") return parsed.localId;
	const last = parsed.descriptors[parsed.descriptors.length - 1];
	if (last === undefined) {
		throw new Error("global symbol unexpectedly has no descriptors");
	}
	return last.name;
};

/** `\0` can't appear in a file path or a SCIP symbol string, so joining with it as a delimiter can't produce a collision the way a human-readable separator could. */
const KEY_DELIMITER = "\0";

/**
 * The map key every occurrence/definition/reference/documentation lookup in
 * this package uses. A `local` symbol is only unique **within the document
 * it appears in** (SCIP spec — `local 5` in two different files are
 * unrelated symbols), so its key folds in `documentPath`; a global symbol's
 * key is the symbol string alone, since it's already workspace-unique.
 * `documentPath` is ignored for a global symbol — passing `""` there is
 * always safe (e.g. for `Index.externalSymbols`, which carry no document).
 */
export const symbolKeyOf = (documentPath: string, symbol: string): SymbolKey =>
	(isLocalSymbol(symbol)
		? ["local", documentPath, symbol].join(KEY_DELIMITER)
		: ["global", symbol].join(KEY_DELIMITER)) as SymbolKey;

/**
 * Whether `key` (a value `symbolKeyOf` produced) was built from a local
 * symbol — the composite-key equivalent of `isLocalSymbol`, for a caller
 * that only ever sees the opaque key (e.g. the sidecar's `references`
 * handler, which needs to know whether `displayNameOf`'s answer for this
 * key is real source text or just scip-typescript's per-document counter —
 * see `deriveDisplayName`'s doc comment).
 */
export const isLocalSymbolKey = (key: SymbolKey): boolean =>
	key.startsWith(`local${KEY_DELIMITER}`);
