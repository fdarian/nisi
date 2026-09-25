#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "statusCheckRollup,headRefOid" ]; then
	printf '%s\n' '{"headRefOid":"abc123","statusCheckRollup":[]}'
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
