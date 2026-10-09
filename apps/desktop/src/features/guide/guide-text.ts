/**
 * Linearises the guide's server-rendered HTML into what a reader would take
 * from it, as plain text: headings as `##`, bullets, `[Passed]` for an icon's
 * label, `[x]` for a ticked box, pin captions numbered, and every computed
 * value (area stats, check status) as the page draws it. A cheap way to see
 * what a guide says without opening an image.
 *
 * Kit components steer it with `data-text`: `skip` leaves an element out,
 * `block` forces a line break around it, `inline` suppresses one, and `ref`,
 * `step`, `wait`, `event` and `lane` mark the pieces of a Ref and a Sequence.
 */

const VOID = new Set(["img", "input", "br", "hr", "meta", "link"]);
const BLOCK = new Set([
	"p",
	"div",
	"section",
	"figure",
	"figcaption",
	"ul",
	"ol",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"pre",
	"nav",
	"aside",
	"details",
	"summary",
	"table",
	"tr",
	"blockquote",
]);
const SPACED_BEFORE = new Set(["h1", "h2", "h3", "figure", "section", "table"]);
const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decode(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(whole, entity: string) => {
			if (entity.startsWith("#x")) {
				return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
			}
			if (entity.startsWith("#")) {
				return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
			}
			return ENTITIES[entity.toLowerCase()] ?? whole;
		},
	);
}

function attributes(source: string): Record<string, string> {
	const found: Record<string, string> = {};
	for (const match of source.matchAll(
		/([a-zA-Z_:][\w:.-]*)(?:="([^"]*)"|='([^']*)')?/g,
	)) {
		found[match[1] as string] = decode(match[2] ?? match[3] ?? "");
	}
	return found;
}

type Open = {
	tag: string;
	skip: boolean;
	suffix: string;
	block: boolean;
	list?: { ordered: boolean; count: number };
	pre: boolean;
};

export function htmlToText(html: string): string {
	const lines: string[] = [];
	let line = "";
	let boundary = false;
	let skipping = 0;
	let inPre = 0;
	const stack: Open[] = [];
	const lists: { ordered: boolean; count: number }[] = [];

	const flush = (spaceBefore = false) => {
		if (line.trim() !== "") lines.push(line.trimEnd());
		line = "";
		boundary = false;
		if (spaceBefore && lines.length > 0 && lines[lines.length - 1] !== "") {
			lines.push("");
		}
	};
	const emit = (text: string) => {
		if (text === "") return;
		const first = text[0] as string;
		const glued =
			line === "" ||
			/\s$/.test(line) ||
			/^[\s.,;:)\]!?]/.test(first) ||
			// A possessive hugs the element before it: "`a.ts`'s".
			/^['\u2019]s(?![\w])/.test(text) ||
			/[([⟨]$/.test(line);
		line += boundary && !glued ? ` ${text}` : text;
		boundary = false;
	};

	const token = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)|<!--.*?-->/g;
	for (const match of html.matchAll(token)) {
		const closing = match[1] === "/";
		const tag = (match[2] ?? "").toLowerCase();
		if (match[5] !== undefined) {
			if (skipping > 0) continue;
			if (inPre > 0) {
				line += decode(match[5]);
				continue;
			}
			const text = decode(match[5]).replace(/\s+/g, " ");
			if (text.trim() === "") {
				boundary = true;
				continue;
			}
			if (/^\s/.test(text)) boundary = true;
			emit(text.trim());
			if (/\s$/.test(text)) boundary = true;
			continue;
		}
		if (tag === "") continue;

		if (closing) {
			if (VOID.has(tag)) continue;
			const open = stack.pop();
			if (open === undefined) continue;
			if (open.skip) skipping -= 1;
			if (open.pre) inPre -= 1;
			if (open.suffix !== "" && skipping === 0) {
				line += open.suffix;
			}
			if (open.list) lists.pop();
			if (skipping === 0) {
				if (open.block) flush();
				else boundary = true;
			}
			continue;
		}

		const attrs = attributes(match[3] ?? "");
		const hint = attrs["data-text"];
		const selfClosing = match[4] === "/" || VOID.has(tag);

		if (skipping > 0) {
			if (!selfClosing) {
				stack.push({ tag, skip: true, suffix: "", block: false, pre: false });
				skipping += 1;
			}
			continue;
		}

		if (tag === "img") {
			const alt = attrs.alt ?? "";
			if (alt !== "") {
				flush();
				emit(`[image: ${alt}]`);
				flush();
			}
			continue;
		}
		if (selfClosing) continue;

		let skip = false;
		let suffix = "";
		const block =
			hint === "block" ||
			(hint !== "inline" && BLOCK.has(tag) && hint === undefined);

		if (hint === "skip" || tag === "script" || tag === "style") {
			skip = true;
		} else if (tag === "svg") {
			skip = true;
			const label = attrs["aria-label"];
			if (label !== undefined) emit(`[${label}]`);
		} else if (attrs.role === "checkbox") {
			skip = true;
			emit(attrs["aria-checked"] === "true" ? "[x]" : "[ ]");
		} else if (hint === "wait" || hint === "event") {
			skip = true;
			emit(`[${hint}]`);
		} else if (hint === "step") {
			emit("[");
			suffix = "]";
		} else if (hint === "ref") {
			emit("⟨");
			suffix = "⟩";
		} else if (tag === "code" && inPre === 0) {
			emit("`");
			suffix = "`";
			boundary = false;
		} else if (hint === "lane") {
			flush();
			suffix = ":";
		}

		if (block && !skip) flush(SPACED_BEFORE.has(tag));
		let list: Open["list"];
		if (tag === "ul" || tag === "ol") {
			list = { ordered: tag === "ol", count: 0 };
			lists.push(list);
		}
		if (/^h[1-6]$/.test(tag) && !skip) {
			emit(`${"#".repeat(Number(tag[1]))} `);
			boundary = false;
		}
		if (tag === "li" && !skip) {
			const parent = lists[lists.length - 1];
			const indent = "  ".repeat(Math.max(0, lists.length - 1));
			if (parent === undefined) {
				emit(`${indent}- `);
			} else {
				parent.count += 1;
				emit(`${indent}${parent.ordered ? `${parent.count}.` : "-"} `);
			}
			boundary = false;
		}
		if (tag === "pre") inPre += 1;
		if (skip) skipping += 1;
		stack.push({
			tag,
			skip,
			suffix,
			block: block && !skip,
			list,
			pre: tag === "pre",
		});
		if (suffix === "`" || suffix === "⟩" || suffix === "]") boundary = false;
	}
	flush();
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}
