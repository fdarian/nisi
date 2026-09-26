#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "statusCheckRollup,headRefOid" ]; then
	printf '%s\n' '{"headRefOid":"abc123","statusCheckRollup":[]}'
elif [ "$1" = "api" ] && [ "$2" = 'repos/acme/widgets/actions/runs?status=action_required&per_page=100' ]; then
	if [ "$NISI_TEST_TRUNCATED" = "1" ]; then
		printf '%s\n' '{"total_count":101,"workflow_runs":[]}'
	else
		printf '%s\n' '{"total_count":2,"workflow_runs":[{"id":101,"name":"CI","html_url":"https://github.com/acme/widgets/actions/runs/101","head_sha":"abc123"},{"id":202,"name":"Other","html_url":"https://github.com/acme/widgets/actions/runs/202","head_sha":"other"}]}'
	fi
elif [ "$1" = "api" ] && [ "$2" = 'repos/acme/widgets/actions/runs?head_sha=abc123&status=action_required' ]; then
	printf '%s\n' '{"workflow_runs":[{"id":101,"name":"CI","html_url":"https://github.com/acme/widgets/actions/runs/101"}]}'
elif [ "$1" = "api" ] && [ "$2" = "-X" ] && [ "$3" = "POST" ]; then
	case "$4" in
	repos/acme/widgets/actions/runs/101/approve) ;;
	repos/acme/widgets/actions/runs/102/approve)
		printf '%s\n' 'gh: Resource not accessible by integration (HTTP 403)' >&2
		exit 1
		;;
	*) exit 2 ;;
	esac
else
	exit 2
fi
