Vendored crates.io `tauri-runtime-cef` 3.0.0-alpha.4 (MIT OR Apache-2.0), from
https://github.com/tauri-apps/tauri/tree/d05973d48957343599889030400ec1a79e7d0363/crates/tauri-runtime-cef.

Only source change: add the `Cef::activate_ignoring_other_apps(bool)` builder
option, wired to Winit's macOS event-loop builder (with a configuration unit test).
The default preserves upstream launch activation. The public runtime
`set_activate_ignoring_other_apps` setter is a no-op, and Winit only accepts this
flag at event-loop build time. Remove this vendored override once upstream
supports launch activation configuration.

## When to re-evaluate

Re-evaluate on every `tauri-runtime-cef` / `tauri` version bump. The
`[patch.crates-io]` entry only supplies 3.0.0-alpha.4: after a bump selects a new
runtime version, Cargo warns that the patch is unused. If upstream lacks the
builder option, any `.activate_ignoring_other_apps(...)` call on `Cef` stops
compiling, so a consumer's bump cannot silently drop the behavior.

- Check whether upstream lets an app disable macOS launch activation through a
  CEF builder option or a working `set_activate_ignoring_other_apps`. If so,
  delete `patches/tauri-runtime-cef/` and its `[patch.crates-io]` entry in
  `apps/desktop/src-tauri/Cargo.toml`, and switch to the upstream API.
- Otherwise, re-vendor the new version and port this one change.
