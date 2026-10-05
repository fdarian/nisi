Vendored crates.io `tauri-runtime-cef` 3.0.0-alpha.4 (MIT OR Apache-2.0), from
https://github.com/tauri-apps/tauri/tree/d05973d48957343599889030400ec1a79e7d0363/crates/tauri-runtime-cef.

Only source change: before building the macOS event loop, disable Winit's launch
activation when `NISI_MEASUREMENT_INSTANCE=1`. The pinned runtime's Tauri
`set_activate_ignoring_other_apps` implementation is a no-op, so the app cannot
disable this through the public API. Production and ordinary dev keep upstream
behavior. Remove this override when the runtime supports the public setting.
