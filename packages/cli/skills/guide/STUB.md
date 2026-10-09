---
name: nisi-guide
description: Write the reviewer's guide for the changes you just made, as a live page in nisi's Guide tab, instead of recapping them in chat. Use after finishing a change a human will review, when asked for a guide, overview or walkthrough of your work, or when editing an existing .nisi/guide/guide.mdx.
---

# nisi guide

Run `nisi skills get guide` and follow what it prints. The full instructions ship inside the `nisi`
CLI, so they always match its version; this file never changes.

- Working on nisi itself, without an installed `nisi`: `bun packages/cli/src/index.ts skills get guide`.
- References: `nisi skills get guide --ref <file>`, or `--full` for everything.
