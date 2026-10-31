import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	GuideValidationNotice,
	validatedAtOtherCommit,
} from "./guide-validation-notice";

const HEAD = "b".repeat(40);
const OLDER = "a".repeat(40);

const render = (validatedSha: string | null) =>
	renderToStaticMarkup(
		createElement(GuideValidationNotice, { validatedSha, headSha: HEAD }),
	);

test("a guide that was never validated gets no notice", () => {
	expect(validatedAtOtherCommit(null, HEAD)).toBe(false);
	expect(render(null)).toBe("");
});

test("a guide validated at the head gets no notice", () => {
	expect(validatedAtOtherCommit(HEAD, HEAD)).toBe(false);
	expect(render(HEAD)).toBe("");
});

test("a guide validated at another commit names both short shas", () => {
	expect(validatedAtOtherCommit(OLDER, HEAD)).toBe(true);
	const text = render(OLDER).replace(/<[^>]+>/g, "");
	expect(text).toBe(
		"This guide was validated at aaaaaaa. The branch has moved to bbbbbbb since.",
	);
});
