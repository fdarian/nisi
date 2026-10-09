/**
 * The `@nisi/guide` module: what a guide's `import { … } from "@nisi/guide"`
 * resolves to (see `../evaluate.ts`). Adding an export here is adding to the
 * authoring API, so mirror it in `.claude/skills/nisi-guide/SKILL.md`.
 * The page title, the "On this page" list and the side pane are the app's, not
 * the kit's (`../guide-view.tsx`).
 */
export { BeforeAfter } from "./before-after";
export { Checks, Skipped } from "./checks";
export { Item, NeedsYou } from "./needs-you";
export { Note } from "./note";
export { Pin } from "./pinned-image";
export { Ref } from "./ref";
export { Shot } from "./shot";
export { Frame, Tour } from "./tour";
