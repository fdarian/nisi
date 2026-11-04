#!/usr/bin/env bash
# A fake `gh` for `pull-request-mergeability.test.ts`, selected by NISI_GH_BIN.
# Answers only when the PR is addressed with `--repo acme/widgets`; a bare
# `gh pr view <n>` would resolve against the checkout's `gh repo set-default`.
set -euo pipefail

if [[ "$*" == "pr view 42 --repo acme/widgets --json state,mergeable,mergeStateStatus,isDraft,headRefOid,baseRefOid,baseRefName" ]]; then
	echo '{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,"headRefOid":"abc123","baseRefOid":"def456","baseRefName":"main"}'
	exit 0
fi

echo "Could not resolve to a PullRequest (unexpected gh invocation: $*)" >&2
exit 1
