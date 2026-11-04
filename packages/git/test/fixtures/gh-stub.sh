#!/usr/bin/env bash
# A fake `gh` for `review-target-by-number.test.ts`, pointed at via `NISI_GH_BIN`
# (see `@repo/bin-resolver`'s `resolveBin`). Real `gh` needs network + auth, which
# the by-number resolution path's differentiating behavior can be exercised without:
# the PR and repository are addressed with `--repo`/a repo argument, never left to
# the cwd. A bare `gh repo view` plays a fork checkout whose `gh repo set-default`
# points at upstream, so a resolver that falls back to it returns the wrong repo.
set -euo pipefail

if [[ "$1" == "repo" && "$2" == "view" ]]; then
	# By-name: `["repo","view","<owner>/<repo>","--json",...]`.
	if [[ "$3" == "acme/widgets" ]]; then
		echo '{"owner":{"login":"acme"},"name":"widgets","defaultBranchRef":{"name":"main"}}'
		exit 0
	fi
	# Cwd-resolved: `["repo","view","--json",...]`.
	if [[ "$3" == "--json" ]]; then
		echo '{"owner":{"login":"upstream"},"name":"gadgets","defaultBranchRef":{"name":"trunk"}}'
		exit 0
	fi
	echo "GraphQL: Could not resolve to a Repository with the name '$3'." >&2
	exit 1
fi

if [[ "$1" == "pr" && "$2" == "view" ]]; then
	# By-number: `["pr","view","<n>","--repo","acme/widgets","--json",...]`.
	if [[ "$3" != "--json" ]]; then
		if [[ "${4:-}" != "--repo" || "${5:-}" != "acme/widgets" ]]; then
			echo "Could not resolve to a PullRequest with the number of $3 (missing --repo acme/widgets)." >&2
			exit 1
		fi
		if [[ "$3" == "42" ]]; then
			echo '{"number":42,"title":"Add widgets","baseRefName":"main","headRefName":"feature-42","isCrossRepository":false,"author":{"login":"fdarian"},"state":"OPEN","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseRefOid":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
			exit 0
		fi
		echo "GraphQL: Could not resolve to a PullRequest with the number of $3." >&2
		exit 1
	fi
	# Branch-based: `["pr","view","--json",...]` — no number, third arg is `--json`.
	echo '{"number":7,"title":"Branch PR","baseRefName":"main","headRefName":"feature-7","isCrossRepository":false,"author":null,"state":"OPEN","headRefOid":"cccccccccccccccccccccccccccccccccccccccc","baseRefOid":"dddddddddddddddddddddddddddddddddddddddd"}'
	exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
