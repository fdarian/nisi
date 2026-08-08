#!/usr/bin/env bash
# A fake `gh` for `mark-pull-request-ready.test.ts`, pointed at via
# `NISI_GH_BIN` (see `@repo/bin-resolver`'s `resolveBin`). Exercises
# `markPullRequestReady`'s classification (success, not-found, auth failure,
# generic failure) without real `gh`/network/auth. The PR number itself
# selects which outcome the stub returns.
set -euo pipefail

if [[ "$1" == "pr" && "$2" == "ready" ]]; then
	case "$3" in
	42)
		exit 0
		;;
	999)
		echo "GraphQL: Could not resolve to a PullRequest with the number of 999." >&2
		exit 1
		;;
	4004)
		echo "gh: not authenticated" >&2
		exit 4
		;;
	500)
		echo "gh: pull request is closed and cannot be marked as ready" >&2
		exit 1
		;;
	esac
fi

echo "unexpected gh invocation: $*" >&2
exit 1
