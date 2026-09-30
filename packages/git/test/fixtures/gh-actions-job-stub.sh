#!/bin/sh
if [ "$1" != "api" ]; then
	echo "expected gh api" >&2
	exit 1
fi
allow_escapes=false
endpoint="$2"
if [ "$2" = "--allow-escape-sequences" ]; then
	allow_escapes=true
	endpoint="$3"
fi
if [ "$2" = "--paginate" ]; then
	endpoint="$4"
fi
if [ "$2" = "-X" ]; then
	if [ "$3" = "POST" ] && [ "$4" = "repos/acme/widgets/actions/jobs/1/rerun" ]; then exit 0; fi
	echo "gh: Resource not accessible (HTTP 403)" >&2
	exit 1
fi
case "$endpoint" in
repos/acme/widgets/actions/jobs/1)
	echo '{"id":1,"name":"test","status":"completed","conclusion":"failure","html_url":"https://github.com/acme/widgets/actions/runs/2/job/1","started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:10Z","steps":[{"number":1,"name":"build","status":"completed","conclusion":"failure","started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:10Z"}]}'
	;;
repos/acme/widgets/actions/jobs/2)
	echo 'not-json'
	;;
repos/acme/widgets/actions/jobs/403)
	echo '{"id":403,"name":"test","status":"completed","conclusion":"failure","html_url":"https://github.com/acme/widgets/actions/runs/2/job/403","started_at":null,"completed_at":null,"steps":[]}'
	;;
repos/acme/widgets/actions/runs/2/jobs?filter=latest\&per_page=100)
	echo '[{"jobs":[{"id":5,"name":"lint"},{"id":1,"name":"test"},{"id":9,"name":"test"}]}]'
	;;
repos/acme/widgets/actions/jobs/1/logs)
	if [ "$allow_escapes" != "true" ]; then
		echo 'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway' >&2
		exit 1
	fi
	printf '2026-01-01T00:00:01.1234567Z \033[36;1mpnpm install\033[0m\r\n2026-01-01T00:00:02.1234567Z ##[error]exit 1\r\n'
	;;
repos/acme/widgets/actions/jobs/404/logs)
	echo 'gh: Not Found (HTTP 404)' >&2
	exit 1
	;;
repos/acme/widgets/actions/jobs/410/logs)
	echo 'gh: Gone (HTTP 410)' >&2
	exit 1
	;;
repos/acme/widgets/actions/jobs/403/logs)
	echo 'gh: Resource not accessible (HTTP 403)' >&2
	exit 1
	;;
repos/acme/widgets/actions/jobs/401/logs)
	echo 'To get started with GitHub CLI, please run: gh auth login' >&2
	exit 4
	;;
repos/acme/widgets/actions/jobs/429/logs)
	echo 'gh: API rate limit exceeded (HTTP 403)' >&2
	exit 1
	;;
*)
	echo 'unexpected endpoint' >&2
	exit 1
	;;
esac
