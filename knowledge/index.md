---
okf_version: "0.2"
---

# nisi knowledge

Project knowledge with no single line of code to hang off. Everything here is real but occasional —
worth finding when you need it, not worth loading into every session.

Where things live, so nothing gets written twice:

- `AGENTS.md` (root, and one per workspace) — rules for working *here*, loaded every turn. Keep slim.
- Inline comments — anything that explains one specific line. Most hard-won findings belong here,
  and in this repo most of them already are.
- This bundle — what fits none of the above: measurements, protocol, and open decisions.

Adding to this bundle? Invoke the `writing-knowledge` skill; it carries the format spec and, more
importantly, the rules for deciding whether a thing belongs here at all.

# Working on nisi

* [Harness models for test generations](harness-test-models.md) - name a cheap model when a verification run has to generate a walkthrough
* [Verifying a frontend change](verifying-frontend-changes.md) - Shadow DOM makes a broken assertion look like a clean pass; run the control first

# Architecture

* [What breaks only in the compiled binary](compiled-binary-differences.md) - the four ways `bun build --compile` differs from `bun run`, and when you must test against it
* [Why the walkthrough runs on HarnessAgent](why-harness-agent-not-direct-sdks.md) - driving the four CLIs directly is the obvious approach and the wrong one
* [The @ai-sdk/harness-pi model resolver patch](harness-pi-model-resolver-patch.md) - why it exists, the proxy-entry trap that broke two fixes, and how to tell whether upstream has actually fixed it (the version number can't)
* [Reverted lines are invisible after review](reverted-lines-invisible-after-review.md) - content that existed only in a review snapshot has no row in the base → head diff, so nothing renders it

# Performance

* [Files Changed performance budget](frontend-performance-budget.md) - the numbers to hold at ~221 changed files, and what regressing them looks like
* [Deferred frontend perf work](deferred-frontend-perf-work.md) - two known wins not taken yet, and the risk attached to each
