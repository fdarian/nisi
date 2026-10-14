import type { GuideSymbol } from "@repo/sidecar-api";

export type SourceFile = { path: string; content: string };

type Language = "ts" | "rust" | "go" | "python";

const LANGUAGE_BY_EXTENSION: Record<string, Language> = {
	ts: "ts",
	tsx: "ts",
	mts: "ts",
	cts: "ts",
	js: "ts",
	jsx: "ts",
	mjs: "ts",
	cjs: "ts",
	rs: "rust",
	go: "go",
	py: "python",
};

/** Whether `scanDeclarations` knows how to read `path`; callers skip reading files it would ignore. */
export function isScannable(path: string): boolean {
	return languageOf(path) !== undefined;
}

function languageOf(path: string): Language | undefined {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? undefined : LANGUAGE_BY_EXTENSION[path.slice(dot + 1)];
}

const IDENT = "([A-Za-z_$][\\w$]*)";

/** `d` so a match reports where the name sits in the line, for the exact-token highlight. */
const declaration = (source: string) => new RegExp(source, "d");

/**
 * Column-0 declarations only: an indented `const result` inside a function
 * body is a local nobody names in prose, and linking it would be wrong as often
 * as right. A class member or method is reached through its class
 * (`Foo.bar` resolves to `Foo`).
 */
const DECLARATIONS: Record<Language, RegExp[]> = {
	ts: [
		declaration(
			`^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const\\s+enum|enum|interface|type|namespace|const|let|var)\\s+${IDENT}`,
		),
	],
	rust: [
		declaration(
			`^(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:const\\s+)?(?:fn|struct|enum|trait|type|static|mod|union)\\s+${IDENT}`,
		),
	],
	go: [
		declaration(`^func\\s+(?:\\([^)]*\\)\\s*)?${IDENT}`),
		declaration(`^(?:type|const|var)\\s+${IDENT}`),
	],
	python: [
		declaration(`^(?:async\\s+)?def\\s+${IDENT}`),
		declaration(`^class\\s+${IDENT}`),
		declaration(`^${IDENT}\\s*(?::[^=]+)?=(?!=)`),
	],
};

function declarationsIn(
	file: SourceFile,
	language: Language,
): Omit<GuideSymbol, "path">[] {
	const found: Omit<GuideSymbol, "path">[] = [];
	const patterns = DECLARATIONS[language];
	file.content.split("\n").forEach((text, index) => {
		for (const pattern of patterns) {
			const span = pattern.exec(text)?.indices?.[1];
			if (span !== undefined) {
				found.push({
					name: text.slice(span[0], span[1]),
					line: index + 1,
					charStart: span[0],
					charEnd: span[1],
				});
				return;
			}
		}
	});
	return found;
}

/**
 * Every name declared exactly once across `files`, with where. A name
 * declared twice (in one file or two) is dropped: a link that might open the
 * wrong declaration is worse than none.
 */
export function scanDeclarations(files: readonly SourceFile[]): GuideSymbol[] {
	const seen = new Map<string, GuideSymbol | null>();
	for (const file of files) {
		const language = languageOf(file.path);
		if (language === undefined) continue;
		for (const declaration of declarationsIn(file, language)) {
			seen.set(
				declaration.name,
				seen.has(declaration.name) ? null : { ...declaration, path: file.path },
			);
		}
	}
	return [...seen.values()].filter((symbol) => symbol !== null);
}

/** The changed files worth reading for declarations: present at head, text, in a language `scanDeclarations` knows. */
export function scannablePaths(
	files: ReadonlyArray<{
		path: string;
		status: string;
		binary: boolean;
		category: string;
	}>,
): string[] {
	return files
		.filter(
			(file) =>
				file.status !== "deleted" &&
				!file.binary &&
				file.category !== "generated" &&
				isScannable(file.path),
		)
		.map((file) => file.path);
}

type CachedSymbols = { diffKey: string; symbols: GuideSymbol[] };
const cache = new Map<string, CachedSymbols>();

/** Identifies the diff a symbol scan was made over: each changed file's fingerprint covers its head content, so the key moves exactly when a scan could differ. */
export function diffKey(
	files: ReadonlyArray<{ path: string; fingerprint: string }>,
): string {
	return files
		.map((file) => `${file.path}\0${file.fingerprint}`)
		.sort()
		.join("\n");
}

export function cachedSymbols(
	sessionId: string,
	key: string,
): GuideSymbol[] | undefined {
	const hit = cache.get(sessionId);
	return hit !== undefined && hit.diffKey === key ? hit.symbols : undefined;
}

export function cacheSymbols(
	sessionId: string,
	key: string,
	symbols: GuideSymbol[],
): void {
	cache.set(sessionId, { diffKey: key, symbols });
}
