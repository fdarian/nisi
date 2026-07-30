---
type: Convention
title: Harness models for test generations
description: Name the cheapest capable model when a verification run has to generate a walkthrough.
tags: [walkthrough, harness, testing, cost]
status: stable
generated: { by: human:farreldarian, at: 2026-07-29T12:07:08Z }
---

Walkthrough generation runs a real coding agent against a real repo for several turns — the
coverage validator alone retries up to 4 times before giving up. A run whose only purpose is to
confirm that a spinner appears or a bridge boots should not bill a frontier model.

| Harness | Model to use |
|---|---|
| `opencode` | `deepseek v4 flash free` |
| `pi` | `deepseek v4 flash free` |
| `claude-code` | `haiku` |

This governs **testing only**. It says nothing about what a real user-facing generation should
default to.

# How to apply

Adapters pick their own default when none is given, so a subagent asked to "generate a walkthrough
and check X" will silently use whatever that default is. Name the model in the handoff prompt, and
report which model a run used alongside its result — otherwise the cost of a verification run is
invisible.

Note that a cheap model raises the odds of hitting the coverage-validation retry ceiling on a large
diff. That failure is about the model, not the code under test; re-read it as "this model couldn't
converge", not "the fix didn't work".
