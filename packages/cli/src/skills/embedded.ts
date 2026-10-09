import guideChecks from "../../skills/guide/references/checks.md" with {
	type: "text",
};
import guideComponents from "../../skills/guide/references/components.md" with {
	type: "text",
};
import guidePreview from "../../skills/guide/references/preview.md" with {
	type: "text",
};
import guideScreenshots from "../../skills/guide/references/screenshots.md" with {
	type: "text",
};
import guideSequence from "../../skills/guide/references/sequence.md" with {
	type: "text",
};
import guideSkill from "../../skills/guide/SKILL.md" with { type: "text" };
import guideStub from "../../skills/guide/STUB.md" with { type: "text" };

export type EmbeddedSkill = {
	/** The whole SKILL.md, frontmatter included. */
	skill: string;
	/** What gets dropped into a repo's `.claude/skills/` so an agent finds the skill. */
	stub: string;
	/** Keyed by file name under `references/`. */
	references: Readonly<Record<string, string>>;
};

/**
 * Imported as text so `bun build --compile` bakes the files into the binary.
 * A file added under `skills/<name>/` is not picked up until it is listed here;
 * `skills.test.ts` fails when this and the directory disagree.
 */
export const embeddedSkills: Readonly<Record<string, EmbeddedSkill>> = {
	guide: {
		skill: guideSkill,
		stub: guideStub,
		references: {
			"checks.md": guideChecks,
			"components.md": guideComponents,
			"preview.md": guidePreview,
			"screenshots.md": guideScreenshots,
			"sequence.md": guideSequence,
		},
	},
};
