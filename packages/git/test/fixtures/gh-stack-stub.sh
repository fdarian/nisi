#!/usr/bin/env bash
# A fake `gh` for pull-request-stack.test.ts, selected by NISI_GH_BIN.
set -euo pipefail

if [[ "$1" != "api" || "$2" != "graphql" ]]; then
	echo "unexpected gh invocation: $*" >&2
	exit 1
fi

if [[ "$*" == *"number=43"* ]]; then
	echo '{"data":{"repository":{"pullRequest":{"stackEntry":null,"stack":null}}}}'
	exit 0
fi

if [[ "$*" == *"number=42"* ]]; then
	echo '{"data":{"repository":{"pullRequest":{"stackEntry":{"position":2},"stack":{"number":7,"size":2,"baseRefName":"main","entries":{"nodes":[{"position":2,"pullRequest":{"number":42,"title":"Second layer","state":"OPEN","isDraft":false,"headRefName":"stack/two","baseRefName":"stack/one"}},{"position":1,"pullRequest":{"number":41,"title":"First layer","state":"MERGED","isDraft":false,"headRefName":"stack/one","baseRefName":"main"}}]}}}}}}'
	exit 0
fi

echo "unexpected stack PR number: $*" >&2
exit 1
