/**
 * The `@nisi/guide` module: what a guide's `import { … } from "@nisi/guide"`
 * resolves to (see `../evaluate.ts`). Adding an export here is adding to the
 * authoring API, so mirror it in `packages/cli/skills/guide/references/components.md`.
 * The "On this page" list and the side pane are the app's, not the kit's
 * (`../guide-view.tsx`); there is no title, since the app already shows the PR's.
 */
export { Area, Areas } from "./areas";
export { BeforeAfter } from "./before-after";
export { Checks, Skipped } from "./checks";
export { Item, NeedsYou } from "./needs-you";
export { Note } from "./note";
export { Pin } from "./pinned-image";
export { Ref } from "./ref";
export { After, Before, Event, Sequence, Step, Wait } from "./sequence";
export { Shot } from "./shot";
export { Frame, Tour } from "./tour";
