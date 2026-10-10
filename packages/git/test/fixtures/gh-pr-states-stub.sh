#!/usr/bin/env bash
# A fake `gh` for `pull-request-states.test.ts`, pointed at via `NISI_GH_BIN`.
# The `--repo` owner/name selects which outcome the stub returns.
set -euo pipefail

if [[ "$1" == "pr" && "$2" == "list" && "$3" == "--repo" ]]; then
	for flag in "--state all" "--limit " "--json number,state"; do
		if [[ "$*" != *"$flag"* ]]; then
			echo "missing flag: $flag in $*" >&2
			exit 1
		fi
	done
	case "$4" in
	acme/widgets)
		echo '[{"number":9,"state":"OPEN"},{"number":8,"state":"MERGED"},{"number":7,"state":"CLOSED"}]'
		exit 0
		;;
	acme/auth)
		echo "gh: not authenticated" >&2
		exit 4
		;;
	acme/limited)
		echo "API rate limit exceeded" >&2
		exit 1
		;;
	acme/offline)
		echo "no such host" >&2
		exit 1
		;;
	acme/garbled)
		echo '[{"number":"nine"}]'
		exit 0
		;;
	esac
fi

echo "unexpected gh invocation: $*" >&2
exit 1
