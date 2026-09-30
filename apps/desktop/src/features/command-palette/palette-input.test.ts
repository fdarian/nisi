import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Command, CommandInput } from "#/components/ui/command";

test("command input's leading content follows its search icon and precedes the input", () => {
	const markup = renderToStaticMarkup(
		createElement(
			Command,
			{},
			createElement(CommandInput, {
				placeholder: "Open pull requests…",
				startContent: createElement("span", {}, "Repository chip"),
			}),
		),
	);
	const icon = markup.indexOf("lucide-search");
	const chip = markup.indexOf("Repository chip");
	const input = markup.indexOf("<input");
	expect(icon).toBeGreaterThanOrEqual(0);
	expect(chip).toBeGreaterThan(icon);
	expect(input).toBeGreaterThan(chip);
	expect(markup).not.toContain("startContent=");
});

test("command input without leading content retains its autocomplete icon addon", () => {
	const markup = renderToStaticMarkup(
		createElement(
			Command,
			{},
			createElement(CommandInput, { placeholder: "Filter repository..." }),
		),
	);
	expect(markup).toContain('data-slot="autocomplete-start-addon"');
	expect(markup).toContain("lucide-search");
});
