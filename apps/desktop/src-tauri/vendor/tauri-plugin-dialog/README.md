# tauri-plugin-dialog compatibility patch

Desktop build subset of crates.io `tauri-plugin-dialog` 3.0.0-alpha.2
(Apache-2.0 OR MIT), archive SHA-256:
`b2e3971a4682128c4350c93778df86ef5d7b815ba9a1b6e17ddc9c68a3dd423b`.
Only `src/desktop.rs` is changed: import `tauri::Manager` for
`run_on_main_thread`, which is a trait method in Tauri 3 alpha.3+.
Remove the Cargo patch when a compatible plugin release is published.
