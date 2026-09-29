#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "api" || "$2" != "graphql" ]]; then
  echo "unexpected gh invocation: $*" >&2
  exit 1
fi
joined=" $* "
has() { [[ "$joined" == *"$1"* ]]; }
if has "TRIGGER_AUTH_FAIL"; then echo "gh auth login" >&2; exit 4; fi
if has "TRIGGER_BAD_CREDENTIALS"; then echo "Bad credentials (HTTP 401)" >&2; exit 1; fi
if has "TRIGGER_RATE_LIMIT"; then echo "API rate limit exceeded" >&2; exit 1; fi
if has "TRIGGER_UNREACHABLE"; then echo "no such host" >&2; exit 1; fi
if has "TRIGGER_DECODE"; then echo '{"data":{"search":{"nodes":[{"number":"wrong"}]}}}'; exit 0; fi
if ! has "is:pr" || ! has "sort:updated-desc" || ! has "n=30"; then echo "missing qualifiers: $joined" >&2; exit 1; fi
pr() {
  printf '{"number":%s,"title":"%s","repository":{"nameWithOwner":"acme/widgets"},"author":{"login":"%s"},"updatedAt":"2026-01-0%sT00:00:00Z","url":"https://github.com/acme/widgets/pull/%s","isDraft":%s,"state":"OPEN","mergeable":"%s","mergeStateStatus":"%s","commits":{"nodes":[{"commit":{"statusCheckRollup":%s}}]}}' "$1" "$2" "$3" "$4" "$1" "$5" "$6" "$7" "$8"
}
printf '{"data":{"search":{"nodes":['
if has "repo:acme/widgets"; then
  if has "author:@me" || has "review-requested:@me"; then echo 'unexpected scope' >&2; exit 1; fi
  if has "is:merged" && has "is:open"; then echo 'unexpected open qualifier' >&2; exit 1; fi
  pr 50 'Passthrough result' someoneelse 1 false MERGEABLE CLEAN null
elif has "review-requested:@me"; then
  pr 20 'Review requested PR' bob 2 false UNKNOWN UNKNOWN null
  printf ','
  pr 30 'Shared PR' carol 5 false CONFLICTING DIRTY '{"state":"FAILURE"}'
else
  if ! has "author:@me" || ! has "is:open"; then echo 'missing default scope' >&2; exit 1; fi
  pr 10 'My authored PR' me 3 false MERGEABLE CLEAN '{"state":"PENDING"}'
  printf ','
  pr 30 'Shared PR' me 4 true UNKNOWN DRAFT null
fi
printf ']}}}\n'
