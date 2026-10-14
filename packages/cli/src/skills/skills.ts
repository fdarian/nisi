import { embeddedSkills } from "./embedded.ts";

export type SkillSummary = { name: string; description: string };

export class SkillNotFound extends Error {
	constructor(name: string) {
		super(
			`No skill named "${name}". Available: ${Object.keys(embeddedSkills).join(", ")}. Run \`nisi skills list\`.`,
		);
	}
}

export class ReferenceNotFound extends Error {
	constructor(skill: string, reference: string) {
		super(
			`Skill "${skill}" has no reference "${reference}". Available: ${Object.keys(embeddedSkills[skill]?.references ?? {}).join(", ")}.`,
		);
	}
}

export const skillFor = (name: string) => {
	const skill = Object.hasOwn(embeddedSkills, name)
		? embeddedSkills[name]
		: undefined;
	if (skill === undefined) throw new SkillNotFound(name);
	return skill;
};

export const descriptionOf = (name: string, skillMarkdown: string) => {
	const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillMarkdown);
	const line = frontmatter?.[1]
		?.split("\n")
		.find((entry) => entry.startsWith("description:"));
	if (line === undefined) {
		throw new Error(`skills/${name}/SKILL.md has no frontmatter description`);
	}
	return line.slice("description:".length).trim();
};

export const listSkills = (): SkillSummary[] =>
	Object.keys(embeddedSkills)
		.sort()
		.map((name) => ({
			name,
			description: descriptionOf(name, skillFor(name).skill),
		}));

export const formatSkillTable = (skills: ReadonlyArray<SkillSummary>) => {
	const width = Math.max(...skills.map((skill) => skill.name.length));
	return skills
		.map((skill) => `${skill.name.padEnd(width)}  ${skill.description}`)
		.join("\n");
};

/** `checks.md` and `references/checks.md` both name the same file. */
export const referenceOf = (name: string, reference: string) => {
	const file = reference.replace(/^references\//, "");
	const references = skillFor(name).references;
	const content = Object.hasOwn(references, file)
		? references[file]
		: undefined;
	if (content === undefined) throw new ReferenceNotFound(name, reference);
	return content;
};

export const fullSkill = (name: string) => {
	const skill = skillFor(name);
	const sections = Object.keys(skill.references)
		.sort()
		.map((file) => `--- references/${file} ---\n${skill.references[file]}`);
	return [skill.skill, ...sections].join("\n");
};
