#!/usr/bin/env bash
# A fake `gh` for pull-request-stack-merge.test.ts, selected by NISI_GH_BIN.
set -euo pipefail

if [[ "$1" == "pr" ]]; then
	if [[ -n "${MATCH_HEAD_COMMIT:-}" ]]; then
		[[ "$*" == "pr merge 42 --squash --match-head-commit ${MATCH_HEAD_COMMIT}" ]]
	else
		[[ "$*" == "pr merge 42 --squash" ]]
	fi
	exit 0
fi

if [[ "$1" == "api" && "$2" == "--method" && "$3" == "PUT" && "$4" == "repos/acme/widgets/pulls/42/merge-async" ]]; then
	if [[ -n "${MATCH_HEAD_COMMIT:-}" ]]; then
		[[ " $* " == *" -f sha=${MATCH_HEAD_COMMIT} "* ]]
	fi
	echo '{"status":"pending","details":{"message":"Merge request enqueued.","uuid":"stack-merge-test"}}'
	exit 0
fi

if [[ "$1" == "api" && "$2" == "repos/acme/widgets/pulls/42/merge-async/stack-merge-test" ]]; then
	case "${STACK_MERGE_OUTCOME:?}" in
	merged)
		echo '{"status":"merged","details":{"message":"Pull request was merged.","sha":"abc123"}}'
		exit 0
		;;
	failed)
		echo '{"status":"failed","details":{"message":"Stack layer #41 is not mergeable."}}'
		exit 0
		;;
	esac
fi

echo "unexpected gh invocation: $*" >&2
exit 1
