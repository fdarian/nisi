#!/usr/bin/env bash
# A fake `gh` for `search-pull-requests.test.ts`, pointed at via `NISI_GH_BIN`
# (see `@repo/bin-resolver`'s `resolveBin`). Real `gh search prs` needs
# network + auth, and its auth/rate-limit failure paths can't be safely
# triggered live at all (see `pull-request.ts`'s `searchPullRequests` doc) —
# this stub inspects the argv `searchPullRequests` actually built and returns
# a canned response (or a specific failure) per test case, keyed off which
# flags/terms are present rather than fixed positions, since the exact
# argument order differs across `searchPullRequests`' branches.
set -euo pipefail

if [[ "$1" != "search" || "$2" != "prs" ]]; then
	echo "unexpected gh invocation: $*" >&2
	exit 1
fi
shift 2
joined=" $* "

has() { [[ "$joined" == *" $1 "* ]]; }

# Trigger markers: a plain search term (no qualifier syntax), so it flows
# through `searchPullRequests`' normal tokenize/union path exactly like a
# real keyword would, rather than needing a separate code path in the stub.
if has "TRIGGER_AUTH_FAIL"; then
	echo "To get started with GitHub CLI, please run:  gh auth login" >&2
	exit 4
fi

if has "TRIGGER_RATE_LIMIT"; then
	echo "API rate limit exceeded for user ID 99999999." >&2
	exit 1
fi

if has "TRIGGER_UNREACHABLE"; then
	echo "dial tcp: lookup api.github.com: no such host" >&2
	exit 1
fi

if has "repo:acme/widgets"; then
	if has "--author" || has "--review-requested"; then
		echo "test-fixture bug: qualifier passthrough must not add --author/--review-requested scoping: $joined" >&2
		exit 1
	fi
	if has "is:merged"; then
		if has "--state"; then
			echo "test-fixture bug: an explicit state qualifier must suppress the default --state open: $joined" >&2
			exit 1
		fi
	elif ! has "--state" || ! has "open"; then
		echo "test-fixture bug: a query with no state qualifier must still default to --state open: $joined" >&2
		exit 1
	fi
	echo '[{"number":50,"title":"Passthrough result","repository":{"nameWithOwner":"acme/widgets"},"author":{"login":"someoneelse"},"updatedAt":"2026-01-01T00:00:00Z","url":"https://github.com/acme/widgets/pull/50","isDraft":false}]'
	exit 0
fi

if has "--review-requested"; then
	echo '[{"number":20,"title":"Review requested PR","repository":{"nameWithOwner":"acme/widgets"},"author":{"login":"bob"},"updatedAt":"2026-01-02T00:00:00Z","url":"https://github.com/acme/widgets/pull/20","isDraft":false},{"number":30,"title":"Shared PR (via review-requested)","repository":{"nameWithOwner":"acme/widgets"},"author":{"login":"carol"},"updatedAt":"2026-01-05T00:00:00Z","url":"https://github.com/acme/widgets/pull/30","isDraft":false}]'
	exit 0
fi

if has "--author"; then
	echo '[{"number":10,"title":"My authored PR","repository":{"nameWithOwner":"acme/widgets"},"author":{"login":"me"},"updatedAt":"2026-01-03T00:00:00Z","url":"https://github.com/acme/widgets/pull/10","isDraft":false},{"number":30,"title":"Shared PR (via author)","repository":{"nameWithOwner":"acme/widgets"},"author":{"login":"me"},"updatedAt":"2026-01-04T00:00:00Z","url":"https://github.com/acme/widgets/pull/30","isDraft":true}]'
	exit 0
fi

echo "unexpected gh search prs invocation: $joined" >&2
exit 1
