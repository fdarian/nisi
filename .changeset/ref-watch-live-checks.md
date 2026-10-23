---

## "@repo/desktop": patch

The sidecar no longer re-reads every watched session's git state every 2 seconds: it now reacts to changes in the repo's HEAD and branch refs, and only polls when uncommitted changes are included or the repo can't be watched.
