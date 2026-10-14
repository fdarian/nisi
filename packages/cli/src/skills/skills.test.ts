import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { embeddedSkills } from "./embedded.ts";
import {
	descriptionOf,
	formatSkillTable,
	fullSkill,
	listSkills,
	referenceOf,
	skillFor,
} from "./skills.ts";

const skillsDir = join(import.meta.dir, "../../skills");
const repoRoot = join(import.meta.dir, "../../../..");
const invoke = (args: string[]) =>
	Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../index.ts"), ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);

test("every file under skills/ is embedded, and nothing else is", () => {
	expect(readdirSync(skillsDir).sort()).toEqual(
		Object.keys(embeddedSkills).sort(),
	);
	for (const name of Object.keys(embeddedSkills)) {
		const skill = skillFor(name);
		const dir = join(skillsDir, name);
		expect(readdirSync(dir).sort()).toEqual([
			"SKILL.md",
			"STUB.md",
			"references",
		]);
		expect(skill.skill).toBe(readFileSync(join(dir, "SKILL.md"), "utf8"));
		expect(skill.stub).toBe(readFileSync(join(dir, "STUB.md"), "utf8"));
		const references = readdirSync(join(dir, "references")).sort();
		expect(Object.keys(skill.references).sort()).toEqual(references);
		for (const file of references) {
			expect(skill.references[file]).toBe(
				readFileSync(join(dir, "references", file), "utf8"),
			);
		}
	}
});

test("the repo's own stub is the shipped stub", () => {
	expect(
		readFileSync(join(repoRoot, ".claude/skills/nisi-guide/SKILL.md"), "utf8"),
	).toBe(skillFor("guide").stub);
});

test("SKILL.md names the skill it is filed under, with a description matching the stub's", () => {
	for (const [name, skill] of Object.entries(embeddedSkills)) {
		expect(skill.skill).toContain(`\nname: ${name}\n`);
		expect(descriptionOf(name, skill.skill)).toBe(
			descriptionOf(name, skill.stub),
		);
	}
});

test("every reference SKILL.md points at exists", () => {
	for (const [name, skill] of Object.entries(embeddedSkills)) {
		const mentioned = [
			...skill.skill.matchAll(/skills get \w+ --ref ([\w.-]+)/g),
		];
		expect(mentioned.length).toBeGreaterThan(0);
		for (const match of mentioned) {
			expect(referenceOf(name, String(match[1]))).toBeTruthy();
		}
	}
});

test("--full puts a banner before each reference", () => {
	const full = fullSkill("guide");
	expect(full.startsWith(skillFor("guide").skill)).toBe(true);
	for (const file of Object.keys(skillFor("guide").references ?? {})) {
		expect(full).toContain(`\n--- references/${file} ---\n`);
	}
});

test("references resolve with or without the references/ prefix, and not by prototype name", () => {
	expect(referenceOf("guide", "checks.md")).toBe(
		referenceOf("guide", "references/checks.md"),
	);
	expect(() => referenceOf("guide", "constructor")).toThrow();
});

test("list table starts every row with the skill name", () => {
	for (const line of formatSkillTable(listSkills()).split("\n")) {
		expect(line.startsWith("guide")).toBe(true);
	}
});

test("CLI: list, get, get --ref, get --full, stub, path, unknown name", () => {
	const text = (args: string[]) => invoke(args).stdout.toString();
	expect(text(["skills"])).toBe(`${formatSkillTable(listSkills())}\n`);
	expect(text(["skills", "list"])).toBe(text(["skills"]));
	expect(JSON.parse(text(["skills", "list", "--json"]))).toEqual(listSkills());
	expect(text(["skills", "get", "guide"])).toBe(skillFor("guide").skill);
	expect(text(["skills", "get", "guide", "--ref", "checks.md"])).toBe(
		referenceOf("guide", "checks.md"),
	);
	expect(text(["skills", "get", "guide", "--full"])).toBe(fullSkill("guide"));
	expect(text(["skills", "stub", "guide"])).toBe(skillFor("guide").stub);
	expect(text(["skills", "path", "guide"])).toContain("(embedded in nisi ");

	for (const args of [
		["skills", "get", "nope"],
		["skills", "get", "guide", "--ref", "nope.md"],
		["skills", "stub", "nope"],
		["skills", "path", "nope"],
	]) {
		const result = invoke(args);
		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toContain("Available:");
	}
});
