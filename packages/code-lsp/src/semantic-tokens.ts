import type { LspRange } from "./protocol.ts";

/**
 * `textDocument/semanticTokens/full`'s negotiated legend — the index into
 * `tokenTypes`/the bit position into `tokenModifiers` is all a token's raw
 * ints carry, so decoding is meaningless without the exact legend the
 * server answered `initialize` with (this package's AGENTS.md, gotcha 2: an
 * `initialize` that doesn't declare `tokenTypes`/`tokenModifiers` gets an
 * *empty* legend back, not the server's full one).
 */
export type SemanticTokensLegend = {
	readonly tokenTypes: ReadonlyArray<string>;
	readonly tokenModifiers: ReadonlyArray<string>;
};

export type SemanticToken = {
	readonly range: LspRange;
	readonly tokenType: string;
	readonly tokenModifiers: ReadonlyArray<string>;
};

/**
 * Decodes the LSP semantic-tokens delta encoding: flat groups of 5 ints
 * `[deltaLine, deltaStartChar, length, tokenTypeIndex, tokenModifiersBitset]`,
 * each token's line/char relative to the *previous token's start* — relative
 * to the previous line's start-char when `deltaLine === 0` (same line, so
 * `deltaStartChar` is an offset from the previous token), otherwise an
 * absolute char on the new line. Throws on a malformed `data` length or an
 * out-of-range legend index — both mean either this decoder or the
 * negotiated legend disagrees with what the server actually sent, a defect
 * in this client rather than something a caller can act on; `client.ts` is
 * the only caller and wraps it in `Effect.try`.
 */
export const decodeSemanticTokens = (
	data: ReadonlyArray<number>,
	legend: SemanticTokensLegend,
): ReadonlyArray<SemanticToken> => {
	if (data.length % 5 !== 0) {
		throw new Error(
			`semantic tokens data length ${data.length} is not a multiple of 5`,
		);
	}

	const tokens: SemanticToken[] = [];
	let line = 0;
	let char = 0;

	for (let i = 0; i < data.length; i += 5) {
		const deltaLine = data[i] as number;
		const deltaStartChar = data[i + 1] as number;
		const length = data[i + 2] as number;
		const tokenTypeIndex = data[i + 3] as number;
		const tokenModifiersBitset = data[i + 4] as number;

		line += deltaLine;
		char = deltaLine === 0 ? char + deltaStartChar : deltaStartChar;

		const tokenType = legend.tokenTypes[tokenTypeIndex];
		if (tokenType === undefined) {
			throw new Error(
				`semantic token type index ${tokenTypeIndex} out of range for a ${legend.tokenTypes.length}-entry legend`,
			);
		}
		const tokenModifiers = legend.tokenModifiers.filter(
			(_modifier, bitIndex) => (tokenModifiersBitset & (1 << bitIndex)) !== 0,
		);

		tokens.push({
			range: {
				start: { line, character: char },
				end: { line, character: char + length },
			},
			tokenType,
			tokenModifiers,
		});
	}

	return tokens;
};
