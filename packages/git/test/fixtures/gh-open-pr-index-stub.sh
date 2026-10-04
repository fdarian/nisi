#!/bin/sh
printf '%s\n' "$*" >>"$NISI_TEST_LOG"
if [ "$NISI_TEST_EXIT" != 0 ]; then
	printf '%s\n' 'HTTP 401: Bad credentials' >&2
	exit "$NISI_TEST_EXIT"
fi
case "$*" in
*after=next*) cat "$NISI_TEST_SECOND" ;;
*) cat "$NISI_TEST_FIRST" ;;
esac
