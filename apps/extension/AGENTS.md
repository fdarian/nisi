# @repo/extension

MV3 Chrome extension. Recognizes a GitHub pull request page arrived at directly — a link from
Slack, a typed or pasted URL, a bookmark — and hands it to the nisi desktop app via a
`nisi://open?url=<encoded github url>` deep link (`apps/desktop/src/lib/deep-link.ts` owns that
grammar; this extension only forwards the GitHub URL verbatim, trailing segments and fragment
included). Clicking around inside GitHub itself never triggers a hand-off.

No build step: hand-written `manifest.json`, plain ESM `.js` files typechecked by `tsc --noEmit`
with `allowJs`/`checkJs` and `@types/chrome` (JSDoc types, not `.ts`). No `#/*` alias — nothing
here resolves it without a bundler, so imports stay relative (`./direct-arrival.js`).

- `direct-arrival.js` — `isDirectArrival`, the hand-off decision. Pure (no `chrome.*` calls), so
  it's `bun test`-able without a browser (`direct-arrival.test.ts`); `background.js` is its only
  caller.
- `background.js` — wires that decision to `chrome.webNavigation.onCommitted`, and keeps each
  tab's last-committed URL fresh through GitHub's Turbo (pjax) navigations via
  `onHistoryStateUpdated`, since those never fire `onCommitted`. Performs the hand-off with
  `chrome.tabs.update` to the deep link, then optionally `chrome.tabs.remove`.
- `options.html`/`options.js` — the post-hand-off tab preference (stay open, default; or close)
  and the deep-link scheme (`nisi` for the production app, `nisi-dev` for a dev build), both in
  `chrome.storage.sync` and read fresh on every hand-off.
- `manifest.json` pins a `"key"` so the extension ID is stable across loads — needed to address
  `chrome-extension://<id>/options.html` directly (e.g. from an automated verification script)
  without first discovering the ID.

## Gotchas

- `permissions` is only `["webNavigation", "storage"]` — no `"tabs"`. `chrome.tabs.get/update/remove`
  need no permission to call; `"tabs"` (or a matching host permission) only controls whether a
  returned `Tab`'s `url`/`title` fields are populated. `host_permissions: ["https://github.com/*"]`
  already covers that for the one case this extension reads it (an opener tab on github.com), and
  doubles as the `webNavigation` event filter — MV3 host-filters that API, so events for other
  origins never reach `background.js` at all.
- Verifying this against a real browser needs Chrome specifically, launched with
  `--executable-path` pointed at a Chrome-for-Testing build (cached under
  `~/.cache/puppeteer/chrome/`) — branded Chrome Stable ≥137 silently ignores `--load-extension`.
  `agent-browser --engine chrome --headed --executable-path <that binary>` is the combination that
  actually loads it (this machine's default `agent-browser` engine is lightpanda, which refuses
  extensions outright).
- An absence assertion (e.g. "the tab stayed open") is only evidence once the same probe has been
  shown to detect presence — stub `isDirectArrival` to `() => true`, rerun the negative case, and
  confirm it flips before trusting the unstubbed result.
