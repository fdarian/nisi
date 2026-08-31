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

* [What breaks only in the compiled binary](compiled-binary-differences.md) - the five ways the packaged sidecar differs from `bun run`, and when you must test against it
* [Why the walkthrough runs on HarnessAgent](why-harness-agent-not-direct-sdks.md) - driving the four CLIs directly is the obvious approach and the wrong one
* [Content invisible in the base → head diff can't be shown, even reviewed](reverted-lines-invisible-after-review.md) - a line added then reverted away lives only in a review snapshot, never in base or head, so no diff between real file states can render it

# Performance

* [Files Changed performance budget](frontend-performance-budget.md) - the numbers to hold at ~221 changed files, and what regressing them looks like
* [Deferred frontend perf work](deferred-frontend-perf-work.md) - known wins not taken yet, and one open symptom not yet bisected
* [The @pierre/diffs CodeView teardown leak patch](codeview-teardown-leak-patch.md) - why `cleanAllRenderedItems()` now sweeps every item instead of just the last virtualization window, and the residual leak still open
* [The @pierre/diffs CodeView stale pendingScrollTarget patch](codeview-stale-pending-scroll-target-patch.md) - clicking a file then immediately ticking its own Reviewed checkbox collapsed scrollTop to 0 instead of compensating, because the scroll-anchor guard never lifts for a target that got removed mid-flight
