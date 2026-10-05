Vendored crates.io `tauri-runtime-cef` 3.0.0-alpha.4 (MIT OR Apache-2.0), from
https://github.com/tauri-apps/tauri/tree/d05973d48957343599889030400ec1a79e7d0363/crates/tauri-runtime-cef.

Only source change: add the `Cef::activate_ignoring_other_apps(bool)` builder
option, wired to Winit's macOS event-loop builder (with a configuration unit test).
The default preserves upstream launch activation. The public runtime
`set_activate_ignoring_other_apps` setter is a no-op, and Winit only accepts this
flag at event-loop build time. Remove this vendored override once upstream
supports launch activation configuration.
