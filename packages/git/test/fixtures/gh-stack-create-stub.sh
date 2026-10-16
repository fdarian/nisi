#!/usr/bin/env bash
# A fake `gh` for pull-request-stack-create.test.ts, selected by NISI_GH_BIN.
set -euo pipefail

expected="api --method POST repos/acme/widgets/stacks -H Accept: application/vnd.github+json -H X-GitHub-Api-Version: 2026-03-10 -F pull_requests[]=41 -F pull_requests[]=42 -F pull_requests[]=43"
if [[ "$*" != "$expected" ]]; then
	echo "unexpected gh invocation: $*" >&2
	exit 1
fi

case "${STACK_CREATE_OUTCOME:?}" in
created)
	echo '{"id":7}'
	exit 0
	;;
unauthenticated)
	echo "gh: To use GitHub CLI, run: gh auth login" >&2
	exit 4
	;;
rate-limited)
	echo "gh: API rate limit exceeded (HTTP 403)" >&2
	exit 1
	;;
not-enabled)
	echo "gh: Not Found (HTTP 404)" >&2
	exit 1
	;;
esac

echo "unknown outcome: ${STACK_CREATE_OUTCOME}" >&2
exit 1
