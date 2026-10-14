import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import packageJson from "../../package.json" with { type: "json" };
import {
	formatSkillTable,
	fullSkill,
	listSkills,
	referenceOf,
	skillFor,
} from "./skills.ts";

const embeddedNote = `(embedded in nisi ${packageJson.version})`;

const writeRaw = (text: string) =>
	Effect.sync(() => process.stdout.write(text));

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("Print name and description as JSON."),
	Flag.withDefault(false),
);

const nameArgument = Argument.string("name").pipe(
	Argument.withDescription("A skill name from `nisi skills list`."),
);

export const skillsCommand = <E>(fail: Effect.Effect<never, E>) => {
	/** An unknown skill or reference exits 1 with the message on stderr. */
	const orFail = <A>(produce: () => A) =>
		Effect.try(produce).pipe(
			Effect.catch((cause) =>
				Console.error(
					cause.cause instanceof Error
						? cause.cause.message
						: String(cause.cause),
				).pipe(Effect.andThen(fail)),
			),
		);

	const printList = (json: boolean) =>
		Effect.gen(function* () {
			const skills = listSkills();
			yield* Console.log(
				json ? JSON.stringify(skills, null, 2) : formatSkillTable(skills),
			);
		});

	const list = Command.make("list", { json: jsonFlag }, (options) =>
		printList(options.json),
	).pipe(Command.withDescription("List the skills embedded in this nisi."));

	const get = Command.make(
		"get",
		{
			name: nameArgument,
			ref: Flag.string("ref").pipe(
				Flag.withDescription(
					"Print one reference file (e.g. screenshots.md) instead of SKILL.md.",
				),
				Flag.optional,
			),
			full: Flag.boolean("full").pipe(
				Flag.withDescription(
					"Print SKILL.md followed by every reference, each after a `--- references/<file> ---` banner.",
				),
				Flag.withDefault(false),
			),
		},
		(options) =>
			Effect.gen(function* () {
				if (options.ref._tag === "Some" && options.full) {
					yield* Console.error("--ref and --full can't be combined.");
					return yield* fail;
				}
				const text = yield* orFail(() => {
					if (options.ref._tag === "Some") {
						return referenceOf(options.name, options.ref.value);
					}
					return options.full
						? fullSkill(options.name)
						: skillFor(options.name).skill;
				});
				yield* writeRaw(text);
			}),
	).pipe(
		Command.withDescription(
			"Print a skill's SKILL.md, frontmatter included. The text is embedded in this binary, so it always matches the nisi version you run.",
		),
	);

	const skillPath = Command.make(
		"path",
		{ name: Argument.string("name").pipe(Argument.optional) },
		(options) =>
			Effect.gen(function* () {
				if (options.name._tag === "None") {
					for (const skill of listSkills()) {
						yield* Console.log(`${skill.name} ${embeddedNote}`);
					}
					return;
				}
				const name = options.name.value;
				yield* orFail(() => skillFor(name));
				yield* Console.log(`${name} ${embeddedNote}`);
			}),
	).pipe(
		Command.withDescription(
			"Say where a skill's content lives. Skills are embedded in the binary, so there is no path on disk.",
		),
	);

	const stub = Command.make("stub", { name: nameArgument }, (options) =>
		Effect.gen(function* () {
			const text = yield* orFail(() => skillFor(options.name).stub);
			yield* writeRaw(text);
		}),
	).pipe(
		Command.withDescription(
			"Print the short SKILL.md stub that points an agent at `nisi skills get <name>`. Save it as <repo>/.claude/skills/nisi-<name>/SKILL.md or in ~/.claude/skills.",
		),
	);

	return Command.make("skills", { json: jsonFlag }, (options) =>
		printList(options.json),
	).pipe(
		Command.withDescription(
			"Skills for coding agents, embedded in this nisi so they match its version. `nisi skills get guide` prints the one for writing a reviewer's guide.",
		),
		Command.withSubcommands([list, get, skillPath, stub]),
	);
};
