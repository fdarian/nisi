#!/usr/bin/env bash
# A fake `gh` for repoint-origin.test.ts, selected by NISI_GH_BIN. Answers
# `gh repo view <STUB_FROM> --json nameWithOwner` with STUB_TO, like GitHub
# resolving a renamed repository's old name; every other lookup is "not found".
set -euo pipefail

if [[ "$1 $2" == "repo view" && "$4 $5" == "--json nameWithOwner" && "$3" == "${STUB_FROM:?}" ]]; then
	echo "{\"nameWithOwner\":\"${STUB_TO:?}\"}"
	exit 0
fi

echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2
exit 1
