#!/usr/bin/env bash
# A fake `gh` for `review-target-by-number.test.ts`, pointed at via `NISI_GH_BIN`
# (see `@repo/bin-resolver`'s `resolveBin`). Real `gh` needs network + auth, which
# the by-number resolution path's differentiating behavior (a specific PR number
# threaded into `gh pr view <n>`, and a hard failure when that number doesn't
# resolve) can be exercised without.
set -euo pipefail

if [[ "$1" == "repo" && "$2" == "view" ]]; then
	echo '{"owner":{"login":"acme"},"name":"widgets","defaultBranchRef":{"name":"main"}}'
	exit 0
fi

if [[ "$1" == "pr" && "$2" == "view" ]]; then
	# By-number: `["pr","view","<n>","--json",...]` — third arg is the number.
	if [[ "$3" == "42" ]]; then
		echo '{"number":42,"title":"Add widgets","baseRefName":"main","headRefName":"feature-42"}'
		exit 0
	fi
	# Branch-based: `["pr","view","--json",...]` — no number, third arg is `--json`.
	if [[ "$3" == "--json" ]]; then
		echo '{"number":7,"title":"Branch PR","baseRefName":"main","headRefName":"feature-7"}'
		exit 0
	fi
	echo "GraphQL: Could not resolve to a PullRequest with the number of $3." >&2
	exit 1
fi

echo "unexpected gh invocation: $*" >&2
exit 1
