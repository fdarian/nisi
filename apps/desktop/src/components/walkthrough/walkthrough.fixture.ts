/**
 * Fixture data for `walkthrough.stories.tsx` — a small, self-contained PR
 * (an "optimistic complete toggle" feature on a fictional todo app, not
 * anything from this repo) realistic enough that the reference pane has real
 * multi-hunk diffs to render and the narrative has real prose to read, not
 * lorem-ipsum stubs. Built against the frontend's own mirror types
 * (`#/lib/walkthrough-data`, `#/lib/pr-data`) — the same types
 * `WalkthroughView`'s props actually carry — not the Effect schemas in
 * `packages/walkthrough`/`packages/sidecar-api`.
 *
 * Every `WalkthroughLocation` below is hand-counted against the *head*
 * (post-change) line numbers in the matching `*_PATCH` string — get one
 * wrong and the reference pane either renders the wrong lines or (if a
 * location falls outside every hunk) an empty/error item. Cross-check
 * against the patch string's own line numbers before changing either.
 */
import type { FileChange, FileContent, Session } from "#/lib/pr-data";
import type { StoredWalkthrough, UncoveredFile } from "#/lib/walkthrough-data";

export const TODOS_PATH = "src/lib/todos.ts";
export const TODO_ITEM_PATH = "src/components/todo-item.tsx";
export const TODO_LIST_PATH = "src/components/todo-list.tsx";

export const FIXTURE_SESSION: Session = {
	id: "storybook-session",
	repoRoot: "/Users/dev/projects/todo-app",
	target: {
		kind: "pr",
		number: 42,
		title: "Add optimistic complete toggle with debounced persistence",
		baseRef: "main",
		headRef: "feature/optimistic-toggle",
		owner: "acme",
		repo: "todo-app",
	},
};

/**
 * Every patch below is built from an explicit array of lines, one per diff
 * line, rather than a hand-typed template literal — a *blank context line*
 * in a real unified diff is a single space character, not an empty line
 * (`@pierre/diffs`' `parsePatchHunks` treats a truly empty line as
 * malformed and silently skips it, which shifts every following line's
 * computed head/old/new number by one). Spelling each blank line out as
 * `" "`/`"+"` explicitly, instead of leaving it invisible inside a template
 * literal, is what keeps that mistake from creeping back in.
 */
function patch(lines: readonly string[]): string {
	return `${lines.join("\n")}\n`;
}

/**
 * Adds `pendingSince` to `Todo`, makes `toggle` optimistic, and introduces a
 * debounced `flushPending` — head lines 1-19 are the type/store shape
 * change, 20-55 are the store body (toggle/flushPending/schedulePersist/
 * persistTodos).
 */
const TODOS_PATCH = patch([
	"diff --git a/src/lib/todos.ts b/src/lib/todos.ts",
	"index 3f1a9c2..7c88e14 100644",
	"--- a/src/lib/todos.ts",
	"+++ b/src/lib/todos.ts",
	"@@ -1,14 +1,19 @@",
	' import { create } from "zustand";',
	" ",
	" export type Todo = {",
	" \tid: string;",
	" \ttitle: string;",
	" \tcompleted: boolean;",
	"+\tpendingSince: number | null;",
	" };",
	" ",
	" type TodoStore = {",
	" \ttodos: Todo[];",
	"-\ttoggle: (id: string) => void;",
	"+\ttoggle: (id: string) => Promise<void>;",
	"+\tflushPending: () => Promise<void>;",
	" };",
	" ",
	"-export const useTodoStore = create<TodoStore>((set) => ({",
	"+const PERSIST_DEBOUNCE_MS = 400;",
	"+let persistTimer: ReturnType<typeof setTimeout> | null = null;",
	"+",
	"+export const useTodoStore = create<TodoStore>((set, get) => ({",
	"@@ -15,9 +20,36 @@",
	" \ttodos: [],",
	"-\ttoggle: (id) => {",
	"+\ttoggle: async (id) => {",
	" \t\tset((state) => ({",
	" \t\t\ttodos: state.todos.map((todo) =>",
	"-\t\t\t\ttodo.id === id ? { ...todo, completed: !todo.completed } : todo,",
	"+\t\t\t\ttodo.id === id",
	"+\t\t\t\t\t? { ...todo, completed: !todo.completed, pendingSince: Date.now() }",
	"+\t\t\t\t\t: todo,",
	" \t\t\t),",
	" \t\t}));",
	"+\t\tschedulePersist(get, set);",
	" \t},",
	"+\tflushPending: async () => {",
	"+\t\tif (persistTimer) clearTimeout(persistTimer);",
	"+\t\tawait persistTodos(get().todos);",
	"+\t\tset((state) => ({",
	"+\t\t\ttodos: state.todos.map((todo) => ({ ...todo, pendingSince: null })),",
	"+\t\t}));",
	"+\t},",
	" }));",
	"+",
	"+function schedulePersist(",
	"+\tget: () => TodoStore,",
	"+\tset: (partial: Partial<TodoStore>) => void,",
	"+) {",
	"+\tif (persistTimer) clearTimeout(persistTimer);",
	"+\tpersistTimer = setTimeout(() => {",
	"+\t\tvoid get().flushPending();",
	"+\t}, PERSIST_DEBOUNCE_MS);",
	"+}",
	"+",
	"+async function persistTodos(todos: Todo[]): Promise<void> {",
	'+\tawait fetch("/api/todos", {',
	'+\t\tmethod: "PUT",',
	"+\t\tbody: JSON.stringify(todos),",
	"+\t});",
	"+}",
]);

/** Adds the pending/complete/spinner three-way icon swap to the checkbox — head lines 1-39. */
const TODO_ITEM_PATCH = patch([
	"diff --git a/src/components/todo-item.tsx b/src/components/todo-item.tsx",
	"index 8a3f2b1..c91d4a7 100644",
	"--- a/src/components/todo-item.tsx",
	"+++ b/src/components/todo-item.tsx",
	"@@ -1,31 +1,39 @@",
	'-import { CheckIcon } from "lucide-react";',
	'+import { CheckIcon, LoaderIcon } from "lucide-react";',
	' import { useTodoStore } from "#/lib/todos";',
	" ",
	" type TodoItemProps = {",
	" \tid: string;",
	" \ttitle: string;",
	" \tcompleted: boolean;",
	"+\tpendingSince: number | null;",
	" };",
	" ",
	" export function TodoItem({",
	" \tid,",
	" \ttitle,",
	" \tcompleted,",
	"+\tpendingSince,",
	" }: TodoItemProps): React.ReactElement {",
	" \tconst toggle = useTodoStore((state) => state.toggle);",
	"+\tconst isPending = pendingSince !== null;",
	" ",
	" \treturn (",
	' \t\t<li className="flex items-center gap-2 px-3 py-2">',
	" \t\t\t<button",
	" \t\t\t\taria-pressed={completed}",
	' \t\t\t\tclassName="flex size-5 items-center justify-center rounded border"',
	"+\t\t\t\tdisabled={isPending}",
	" \t\t\t\tonClick={() => toggle(id)}",
	" \t\t\t>",
	'-\t\t\t\t{completed && <CheckIcon className="size-3" />}',
	"+\t\t\t\t{isPending ? (",
	'+\t\t\t\t\t<LoaderIcon className="size-3 animate-spin" />',
	"+\t\t\t\t) : (",
	'+\t\t\t\t\tcompleted && <CheckIcon className="size-3" />',
	"+\t\t\t\t)}",
	" \t\t\t</button>",
	' \t\t\t<span className={completed ? "text-muted-foreground line-through" : ""}>',
	" \t\t\t\t{title}",
	" \t\t\t</span>",
	" \t\t</li>",
	" \t);",
	" }",
]);

/** Wires an unmount-flush into `TodoList` so a fast tab switch doesn't drop a still-pending save — head lines 1-22. */
const TODO_LIST_PATCH = patch([
	"diff --git a/src/components/todo-list.tsx b/src/components/todo-list.tsx",
	"index 5e2c9a4..1f6d3b8 100644",
	"--- a/src/components/todo-list.tsx",
	"+++ b/src/components/todo-list.tsx",
	"@@ -1,14 +1,22 @@",
	'+import { useEffect } from "react";',
	' import { TodoItem } from "#/components/todo-item";',
	' import { useTodoStore } from "#/lib/todos";',
	" ",
	" export function TodoList(): React.ReactElement {",
	" \tconst todos = useTodoStore((state) => state.todos);",
	"+\tconst flushPending = useTodoStore((state) => state.flushPending);",
	"+",
	"+\tuseEffect(() => {",
	"+\t\treturn () => {",
	"+\t\t\tvoid flushPending();",
	"+\t\t};",
	"+\t}, [flushPending]);",
	" ",
	" \treturn (",
	' \t\t<ul className="flex flex-col divide-y">',
	" \t\t\t{todos.map((todo) => (",
	" \t\t\t\t<TodoItem key={todo.id} {...todo} />",
	" \t\t\t))}",
	" \t\t</ul>",
	" \t);",
	" }",
]);

const TODOS_FINGERPRINT = "a1b2c3d";
const TODO_ITEM_FINGERPRINT = "d4e5f6a";
const TODO_LIST_FINGERPRINT = "9c8b7a6";

export const FIXTURE_FILES: readonly FileChange[] = [
	{
		path: TODOS_PATH,
		status: "modified",
		category: "implementation",
		additions: 34,
		deletions: 7,
		fingerprint: TODOS_FINGERPRINT,
		binary: false,
		review: null,
	},
	{
		path: TODO_ITEM_PATH,
		status: "modified",
		category: "implementation",
		additions: 12,
		deletions: 4,
		fingerprint: TODO_ITEM_FINGERPRINT,
		binary: false,
		review: null,
	},
	{
		path: TODO_LIST_PATH,
		status: "modified",
		category: "implementation",
		additions: 8,
		deletions: 0,
		fingerprint: TODO_LIST_FINGERPRINT,
		binary: false,
		review: null,
	},
];

/**
 * Same PR, but as it'd look if the worktree moved since the walkthrough was
 * generated: `todo-item.tsx` edited again (new fingerprint), `todo-list.tsx`
 * gone entirely (a location in `flush-on-unmount` below will render as "not
 * part of the current diff" — a real state, not a fixture bug), and a
 * brand-new file nothing references yet. Exercises all three
 * `OutdatedBanner` badges (`Edited`/`Deleted`/`New`) at once.
 */
export const FIXTURE_FILES_WITH_DRIFT: readonly FileChange[] = [
	FIXTURE_FILES[0] as FileChange,
	{
		...(FIXTURE_FILES[1] as FileChange),
		fingerprint: "f00ba12",
		additions: 15,
		deletions: 5,
	},
	{
		path: "src/components/todo-filter.tsx",
		status: "added",
		category: "implementation",
		additions: 22,
		deletions: 0,
		fingerprint: "new0001",
		binary: false,
		review: null,
	},
];

export const FIXTURE_FILE_CONTENTS: Readonly<Record<string, FileContent>> = {
	[TODOS_PATH]: { patch: TODOS_PATCH, truncated: false, review: null },
	[TODO_ITEM_PATH]: { patch: TODO_ITEM_PATCH, truncated: false, review: null },
	[TODO_LIST_PATH]: { patch: TODO_LIST_PATCH, truncated: false, review: null },
};

export const FIXTURE_WALKTHROUGH: StoredWalkthrough = {
	sessionId: FIXTURE_SESSION.id,
	harness: "claude-code",
	model: "claude-opus-4-5",
	generatedAt: Date.parse("2026-07-28T14:32:00Z"),
	fingerprints: {
		[TODOS_PATH]: TODOS_FINGERPRINT,
		[TODO_ITEM_PATH]: TODO_ITEM_FINGERPRINT,
		[TODO_LIST_PATH]: TODO_LIST_FINGERPRINT,
	},
	walkthrough: {
		version: 1,
		sections: [
			{
				title: "Overview",
				body: `This PR makes completing a todo feel instant. Clicking the checkbox now [flips the item optimistically and queues a debounced save](ref:toggle-mutation) instead of blocking on the network, and [an unmount guard flushes anything still pending](ref:flush-on-unmount) so a fast tab switch never drops a write.

The checkbox itself also needed a third visual state — not just checked/unchecked but **pending** — so people can tell a click registered before the network round-trip resolves.`,
			},
			{
				title: "Optimistic updates",
				body: `[\`toggle()\`](ref:toggle-mutation) flips \`completed\` and stamps \`pendingSince\` in the same \`set()\` call, then hands off to a [debounce scheduler](ref:debounce-scheduler) rather than persisting immediately — rapid clicks on the same item collapse into one write instead of one per click.

- \`pendingSince\` is \`null\` until a toggle is in flight, and cleared once \`flushPending\` resolves.
- The store never waits on the server response to update \`completed\` — it already knows what the user asked for.`,
			},
			{
				title: "Debounced persistence",
				body: `[\`schedulePersist\`](ref:debounce-scheduler) resets a single shared timer on every call — a burst of toggles across several todos still resolves to one \`PUT /api/todos\` once things settle, not one per item.

Unmounting \`TodoList\` — closing the tab, navigating away — calls [\`flushPending\` directly](ref:flush-on-unmount) instead of waiting out the debounce, so nothing pending gets lost to a component teardown racing the timer.`,
			},
			{
				title: "UI feedback",
				body: `[The checkbox swaps its icon based on \`pendingSince\`](ref:checkbox-ui): a spinner while a save is in flight, the check mark once it lands, nothing while unchecked. The button also disables itself for that window — a second click mid-flush would otherwise race the first.`,
			},
		],
		references: [
			{
				id: "toggle-mutation",
				label: "Optimistic toggle mutation",
				locations: [
					{ path: TODOS_PATH, startLine: 21, endLine: 30 },
					{ path: TODO_ITEM_PATH, startLine: 17, endLine: 18 },
					{ path: TODO_ITEM_PATH, startLine: 25, endLine: 32 },
				],
			},
			{
				id: "debounce-scheduler",
				label: "Debounce scheduler internals",
				locations: [
					{ path: TODOS_PATH, startLine: 40, endLine: 48 },
					{ path: TODOS_PATH, startLine: 50, endLine: 55 },
				],
			},
			{
				id: "checkbox-ui",
				label: "Checkbox pending/complete states",
				locations: [{ path: TODO_ITEM_PATH, startLine: 22, endLine: 33 }],
			},
			{
				id: "flush-on-unmount",
				label: "Flush pending edits on unmount",
				locations: [
					{ path: TODO_LIST_PATH, startLine: 7, endLine: 13 },
					{ path: TODOS_PATH, startLine: 31, endLine: 37 },
					{ path: TODO_ITEM_PATH, startLine: 4, endLine: 9 },
				],
			},
		],
	},
};

/**
 * The real gaps between `FIXTURE_WALKTHROUGH.walkthrough.references`'
 * `locations` and each patch's own added-line ranges, hand-counted the same
 * way the locations above are: the `pendingSince`/`flushPending` type-shape
 * edits on `TODOS_PATH` (head lines 7, 12-13, and 16-19 — the added lines
 * inside the first hunk's 1-19 window that no block claims),
 * `TODO_ITEM_PATH`'s import line (1) and `pendingSince` prop destructure
 * (15), and `TODO_LIST_PATH`'s `useEffect` import (1) — every one a
 * signature/import tweak the walkthrough judged not worth narrating on its
 * own, not something it missed.
 */
export const FIXTURE_UNCOVERED_FILES: readonly UncoveredFile[] = [
	{
		path: TODOS_PATH,
		ranges: [
			{ start: 7, end: 7 },
			{ start: 12, end: 13 },
			{ start: 16, end: 19 },
		],
	},
	{
		path: TODO_ITEM_PATH,
		ranges: [
			{ start: 1, end: 1 },
			{ start: 15, end: 15 },
		],
	},
	{ path: TODO_LIST_PATH, ranges: [{ start: 1, end: 1 }] },
];

/** Same walkthrough, but as if every changed line were claimed by some reference block. */
export const FIXTURE_WALKTHROUGH_FULLY_COVERED: StoredWalkthrough = {
	...FIXTURE_WALKTHROUGH,
	uncoveredFiles: [],
};

/** Same walkthrough, with `FIXTURE_UNCOVERED_FILES`' real gaps attached. */
export const FIXTURE_WALKTHROUGH_WITH_GAPS: StoredWalkthrough = {
	...FIXTURE_WALKTHROUGH,
	uncoveredFiles: FIXTURE_UNCOVERED_FILES,
};
