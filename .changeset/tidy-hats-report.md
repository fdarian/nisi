---
"@repo/desktop": patch
---

`nisi` no longer brings the wrong app forward when pointed at a dev sandbox via `NISI_DATA_DIR` — the app that actually opened the session now focuses itself instead of the CLI guessing which one to activate.
