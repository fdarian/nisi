# Kit components

Import any of these from `@nisi/guide`. Kit components also resolve without an import, but import them anyway so the file reads correctly.

| Component | Use |
| --- | --- |
| `Areas` + `Area { id, title, subtitle?, paths }` | The Overview's cards, stacked one per row. `paths` entries are globs over repo-relative paths (`apps/desktop/sidecar/**`; `*` stays in a folder, `**` crosses them, `{a,b}` alternates) or plain paths, each claiming every hunk of the files it matches, or `path:lines` (`"src/middleware.ts:10-40"`) claiming only that file's hunks that overlap the range. Use `path:lines` when two Areas share a file, so each lists only its own hunks. Children are markdown bullets. nisi computes the card's "N files +A −D" from the claimed hunks, and clicking it lists them: a file the Area claims whole is one row, a file it claims in part is one row per hunk (`middleware.ts:12-38`), each a button that opens the diff beside the guide. Tests, stories, docs, images and generated files (lockfiles, snapshots, `@generated`) are left out. Colors are assigned in order; you don't pick them. `id`s must be unique. |
| `Sequence { title, lanes }` + `Before` / `After` + `Step` / `Wait` / `Event` | A swimlane of what ran when. See `sequence.md`. |
| `Shot { src, alt, caption? }` + `Pin { x, y, ring?, side? }` | One screenshot with numbered pins. See `screenshots.md`. |
| `Tour` + `Frame { title, src? }` | A flow, one frame at a time with a filmstrip and arrow keys. Frames take `Pin`s; a frame without `src` renders its children instead. |
| `BeforeAfter { before, after }` | Side by side. Each side is an image src or any node. |
| `Note { label }` | A decision or caveat. The label is its heading; the body is muted. Put `Ref`s in the body. |
| `Ref { path, lines? }` | Shows the file's basename (`lines` like `"12-30"`); the full path is on hover. Clicking opens the file's diff beside the guide, scrolled to `lines`. `nisi guide validate` rejects a path outside the diff, or lines that touch no changed hunk. |
| `Checks` + `Skipped { title }` | Every run recorded by `nisi guide check`; see `checks.md`. |
| `NeedsYou` + `Item { id, title }` | A tickable list. `title` is an action for the reviewer; the children are a one-line how or why. Ticks are remembered per `id`, so keep ids stable when you rewrite the guide. |

## Writing the children

- Put markdown bullets inside `Area` (and prose inside `Note`) on their own lines, indented with a tab or two spaces. A line of text on the same line as the tag is treated as inline content instead.
- Use backticks for identifiers. A backticked repo path that is in the diff turns into a `Ref` on its own; one outside the diff stays plain code.

## Custom components

Use the kit first. Write a custom component only when nothing above can show what you mean (a real UI state rendered from the PR's code, say).

- Put it in a `.tsx` file next to `guide.mdx` and `import` it. It may import from the repo's own source and from `@nisi/guide`.
- Custom components only present. Check results, diff stats and review status come from the kit, which reads recorded data; never fake them in a custom component.
- Imports resolve to `react`, `@nisi/guide`, relative files and images. No npm packages, no `fetch`.
- Edits to repo source that a custom component imports don't trigger a rebuild; touch the `.tsx` file next to the guide to refresh.
- A build error or a throwing component shows inline in the tab with its message; fix it and save.
