# @repo/extension

MV3 Chrome extension. Recognizes a GitHub pull request page arrived at directly — a link from
Slack, a typed or pasted URL, a bookmark — and hands it to the nisi desktop app via a
`nisi://open?url=<encoded github url>` deep link (`apps/desktop/src/lib/deep-link.ts` owns that
grammar; this extension only forwards the GitHub URL verbatim, trailing segments and fragment
included). Clicking around inside GitHub itself never triggers a hand-off. The hand-off lands on
the extension's own interstitial page rather than firing the deep link straight from
`background.ts` — see `interstitial.ts`'s docblock for why.

Everything the extension ships lives under `src/` — `manifest.json`, both `.html` pages, and the
`.ts` sources — and `bun run build` (`scripts/build.ts`, plain `Bun.build`, unminified, sourcemaps
on) mirrors it into `dist/`, pinning entry filenames unhashed since `manifest.json` and the two
`.html` pages reference them literally. `dist/` is the load-unpacked target — point Chrome (or
`--load-extension`) at `apps/extension/dist`, not the package root, and re-run the build after
every source change; there's no watch mode. `Bun.build` strips types without checking them, so
`bun run check:type` (`tsc --noEmit` with `@types/chrome`) is a separate step. No `#/*` alias:
five flat files, so relative imports (`./direct-arrival.js`) stay shorter than an alias would be.

- `direct-arrival.ts` — `isDirectArrival`, the hand-off decision. Pure (no `chrome.*` calls), so
  it's `bun test`-able without a browser (`direct-arrival.test.ts`); `background.ts` is its only
  caller.
- `bounce-back.ts` — `isBounceBackFromInterstitial`, the one case that overrides
  `isDirectArrival`: the interstitial's own "Open on GitHub" link landing back on the exact PR URL
  it was carrying. Same shape as `direct-arrival.ts` — pure, `bun test`-able
  (`bounce-back.test.ts`), `background.ts`'s only caller — and deliberately a separate predicate
  rather than folded into `isDirectArrival`, since the two don't share logic beyond both reading
  `previousUrl`.
- `background.ts` — wires both decisions to `chrome.webNavigation.onCommitted` (a bounce-back
  short-circuits before `isDirectArrival` even runs), and keeps each tab's last-committed URL
  fresh through GitHub's Turbo (pjax) navigations via `onHistoryStateUpdated`, since those never
  fire `onCommitted`. Hands off by navigating the tab to `interstitial.html?url=<encoded github
  url>`. `direct-arrival.ts` and `bounce-back.ts` are imports of this file, not build entries, so
  they end up inlined into `dist/background.js` rather than emitted as their own files.
- `interstitial.html`/`interstitial.ts` — fires the `nisi://` deep link, with a retry button and
  a link back to the PR on GitHub. Stays on screen through the first hand-off ever, since Chrome
  gives no reliable way to confirm the deep link actually launched nisi (see the docblock); a
  button there lets the user assert that it did, which is what flips `autoCloseAfterHandoff` in
  `chrome.storage.sync` for good. Once that flag is set, every later hand-off fires the deep link
  and closes the tab immediately, no detection involved.
- `options.html`/`options.ts` — a single checkbox mirroring `autoCloseAfterHandoff`, so it's
  reversible without clearing extension data. `manifest.json` pins a `"key"` so the extension ID
  is stable across loads, which lets both this and `interstitial.html` be addressed directly at
  `chrome-extension://<id>/...` (e.g. from an automated verification script) without first
  discovering the ID.

## Gotchas

- `permissions` is only `["webNavigation", "storage"]` — no `"tabs"`. `chrome.tabs.get/update/remove`
  need no permission to call; `"tabs"` (or a matching host permission) only controls whether a
  returned `Tab`'s `url`/`title` fields are populated. `host_permissions: ["https://github.com/*"]`
  already covers that for the one case this extension reads it (an opener tab on github.com), and
  doubles as the `webNavigation` event filter — MV3 host-filters that API, so events for other
  origins never reach `background.ts` at all.
- Chrome exposes no reliable way, from extension/page JS, to tell "the external-protocol
  confirmation dialog is pending" apart from "the app already launched silently" — `interstitial.ts`
  has the full investigation (what was tried, what Chromium source says, why each candidate signal
  is confounded). `autoCloseAfterHandoff` sidesteps that by asking the user to confirm success
  once instead of detecting it; don't reach for a timer or a focus/blur heuristic here instead —
  that's the exact failure mode the interstitial exists to avoid.
- `chrome.tabs.update`/`window.location` navigations to an unregistered scheme are, per Chrome's
  `ExternalProtocolHandler`, attributed to the *initiating* origin for its "always allow" memory —
  both a `chrome.tabs.update` call from the service worker and a same-origin `window.location`
  assignment from an extension page attribute to `chrome-extension://<id>`, not to whatever the
  tab happened to be showing before.
- Verifying this against a real browser needs Chrome specifically, launched with
  `--executable-path` pointed at a Chrome-for-Testing build (cached under
  `~/.cache/puppeteer/chrome/`) — branded Chrome Stable ≥137 silently ignores `--load-extension`.
  `agent-browser --engine chrome --headed --executable-path <that binary> --load-extension
  apps/extension/dist` is the combination that actually loads it (run `bun run build` first —
  `--load-extension` needs `dist/`, not the package root; this machine's default `agent-browser`
  engine is lightpanda, which refuses extensions outright). The confirmation dialog itself is
  invisible to CDP (`Page.javascriptDialogOpening` never fires for it — it's native browser
  chrome, not a JS dialog); use an OS-side side effect (e.g. a protocol handler that appends to a
  log file) as the discriminator instead, and run unattended — a human clicking the dialog by hand
  invalidates the result.
- An absence assertion (e.g. "the tab stayed open") is only evidence once the same probe has been
  shown to detect presence — stub `isDirectArrival` to `() => true`, rerun the negative case, and
  confirm it flips before trusting the unstubbed result.
