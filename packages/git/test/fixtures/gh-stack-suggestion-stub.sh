#!/usr/bin/env bash
# A fake `gh` for stack-suggestion.test.ts, selected by NISI_GH_BIN.
set -euo pipefail

if [[ "$1" != "api" || "$2" != "graphql" ]]; then
	echo "unexpected gh invocation: $*" >&2
	exit 1
fi

echo '{"data":{"repository":{"pullRequests":{"nodes":[{"number":2,"title":"Second","isDraft":false,"headRefName":"b","baseRefName":"a","isCrossRepository":false,"stack":null},{"number":1,"title":"First","isDraft":true,"headRefName":"a","baseRefName":"main","isCrossRepository":false,"stack":null},{"number":5,"title":"Unrelated","isDraft":false,"headRefName":"z","baseRefName":"main","isCrossRepository":false,"stack":null}]}}}}'
