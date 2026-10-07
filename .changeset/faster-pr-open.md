---
"@repo/desktop": minor
---

Opening a pull request while nisi is already running is now about 4–6× faster, from the `nisi` command or a `nisi://` link.

| Opening a PR nisi hasn't shown yet | Before | After |
|---|---|---|
| `nisi` in the PR's worktree | 2.2–2.5s | 0.5–0.7s |
| `nisi://open?url=…`, worktree already exists | 3.0–3.7s | 0.5–0.65s |
| A PR created moments ago | 2.2–2.5s | 1.2–1.3s |

Times are until the first diff is on screen, measured on open vercel/ai and openai/codex pull requests.
