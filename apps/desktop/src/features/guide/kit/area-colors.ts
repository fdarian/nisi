/** What an Area (and the Sequence steps that name it) looks like. Assigned in document order, so the author never picks one. Class names are spelled out in full so Tailwind sees them. */
export type AreaColor = {
	dot: string;
	/** A Sequence step or tick belonging to the area. */
	step: string;
};

const PALETTE: readonly AreaColor[] = [
	{
		dot: "bg-violet-500",
		step: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300",
	},
	{
		dot: "bg-cyan-500",
		step: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
	},
	{
		dot: "bg-amber-500",
		step: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	},
	{
		dot: "bg-emerald-500",
		step: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	},
	{
		dot: "bg-rose-500",
		step: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
	},
	{
		dot: "bg-indigo-500",
		step: "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
	},
	{
		dot: "bg-lime-500",
		step: "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300",
	},
	{
		dot: "bg-fuchsia-500",
		step: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
	},
];

const NEUTRAL: AreaColor = {
	dot: "bg-muted-foreground",
	step: "border-border bg-muted text-muted-foreground",
};

/** Colors cycle after eight areas; an id that isn't an Area (yet) is neutral. */
export function colorForArea(
	areaOrder: readonly string[],
	id: string | undefined,
): AreaColor {
	if (id === undefined) return NEUTRAL;
	const index = areaOrder.indexOf(id);
	if (index === -1) return NEUTRAL;
	return PALETTE[index % PALETTE.length] as AreaColor;
}
