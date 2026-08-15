mod editors;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use editors::{list_available_editors, open_in_editor};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager, Runtime, TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;
use tokio::sync::OnceCell;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SidecarJson {
    port: u16,
    token: String,
}

/** Resolved sidecar connection details, handed to the frontend via `get_backend`. */
#[derive(Debug, Clone, Serialize)]
pub struct BackendState {
    pub port: u16,
    pub token: String,
}

/** Wrapper for the sidecar child process so it can be killed on app exit. */
pub struct SidecarChild(Mutex<Option<CommandChild>>);

/** Where `sidecar.json` is expected to appear — resolved once in `.setup()`. */
struct SidecarJsonPath(PathBuf);

/**
 * Lazily-resolved `BackendState`, shared across every `get_backend` call.
 * `OnceCell::get_or_try_init` de-dupes concurrent callers onto a single wait
 * and — importantly — only caches success: a timed-out attempt leaves the
 * cell empty, so a later call can retry instead of being stuck with a
 * permanently cached error.
 */
struct BackendCell(OnceCell<BackendState>);

/**
 * `POST /api/health/check`, bearer-authed the same way the frontend and CLI
 * are (see `packages/sidecar-api`'s `makeSidecarClient`) — the wire format
 * (`{"json":{}}` in, `{"json":{"status":"ok"}}` out, oRPC's `RPCHandler`
 * convention) is small enough to reproduce here rather than pulling the
 * whole oRPC client stack into Rust. A short timeout, since this is always a
 * loopback call: a live sidecar answers near-instantly, and a dead one
 * fails even faster (connection refused doesn't wait around).
 */
async fn is_backend_alive(port: u16, token: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1000))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .post(format!("http://127.0.0.1:{port}/api/health/check"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "json": {} }))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

/**
 * Awaits a `sidecar.json` whose recorded sidecar actually answers, up to
 * ~8 s (16 × 500 ms), using the async runtime's timer rather than
 * `thread::sleep`. This must never block Tauri's main thread: the frontend
 * fires its one-shot `invoke('get_backend')` as soon as the webview mounts,
 * and a blocking wait in `.setup()` used to park the main thread right when
 * that call needed servicing, wedging the UI on a fresh data dir with no
 * recovery (no retry/timeout on the frontend side either). Moving the wait
 * into this async command means `.setup()` returns immediately and the
 * invoke always gets serviced, success or timeout.
 *
 * The file alone was never enough to trust — `get_backend` caches whatever
 * this returns into a `OnceCell` for the app's whole lifetime, so believing
 * a `sidecar.json` left behind by a sidecar that has since died (a `SIGKILL`
 * skips its cleanup — see `apps/desktop/sidecar/sidecar-lock.ts`) would wedge
 * every `get_backend` call for the rest of the session on a port nothing is
 * listening on. A dead recorded owner is treated the same as "file not
 * there yet" and retried, since a fresh sidecar may be about to republish it
 * (see the same file's `acquireSidecarLock`/`publishSidecarJson`).
 */
async fn wait_for_sidecar_json(path: &Path) -> Result<BackendState, String> {
    for _ in 0..16 {
        if path.exists() {
            let raw = tokio::fs::read_to_string(path)
                .await
                .map_err(|e| format!("failed to read sidecar.json: {e}"))?;
            // `sidecar.json` is published via a temp file + `rename()` in the
            // same directory (see `publishSidecarJson`) — rename is atomic on
            // one filesystem, so a reader here can only ever observe the old
            // content or the new content, never a partial write in between.
            // A parse failure is therefore a genuine error (corruption, an
            // incompatible format from some other source), not a transient
            // race to retry past — surfaced immediately instead of spending
            // the rest of the 8 s budget masking it as "not found."
            let parsed: SidecarJson = serde_json::from_str(&raw)
                .map_err(|e| format!("sidecar.json exists but failed to parse: {e}"))?;
            if is_backend_alive(parsed.port, &parsed.token).await {
                return Ok(BackendState {
                    port: parsed.port,
                    token: parsed.token,
                });
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!(
        "sidecar.json not found (or its sidecar never answered) after 8 s at {}",
        path.display()
    ))
}

#[tauri::command]
async fn get_backend(
    cell: tauri::State<'_, BackendCell>,
    sidecar_json_path: tauri::State<'_, SidecarJsonPath>,
) -> Result<BackendState, String> {
    cell.0
        .get_or_try_init(|| wait_for_sidecar_json(&sidecar_json_path.0))
        .await
        .map(|state| state.clone())
}

/** Id of the File menu's ⌘W item, and the event it emits to the frontend. */
const CLOSE_TAB_MENU_ID: &str = "close-tab";
const CLOSE_TAB_EVENT: &str = "menu://close-tab";
/** Id of the File menu's ⌘⇧W item — closes the focused window, handled entirely in Rust. */
const CLOSE_WINDOW_MENU_ID: &str = "close-window";
/**
 * Id of the app menu's "About nisi" item. Custom rather than
 * `PredefinedMenuItem::about` — see `build_about_window`'s doc comment for
 * why the native panel can't show what this app needs (a linked commit
 * sha). Handled entirely in Rust: creates/focuses `ABOUT_WINDOW_LABEL`
 * directly, no frontend round trip.
 */
const ABOUT_MENU_ID: &str = "about";
/** Label of the on-demand About window `build_about_window` creates, and the frontend route (`/about`) it loads. */
const ABOUT_WINDOW_LABEL: &str = "about";

/**
 * Builds the macOS menu bar from scratch rather than patching
 * `Menu::default`'s output. `Menu::default` (see
 * `tauri-2.11.5/src/menu/menu.rs:142-241`) turns out to seed *two*
 * `PredefinedMenuItem::close_window` items on macOS — one in the Window
 * submenu (the one this function used to swap out) and an untouched second
 * one in its own File submenu. muda hardcodes that predefined item to ⌘W on
 * macOS (`muda-0.19.3/src/items/predefined.rs:330-333`), and AppKit gives
 * the main menu first refusal on key equivalents before the key window's
 * responder chain — so File ▸ Close silently kept ⌘W and closed the whole
 * window, while the custom Close Tab item built into Window never fired.
 * Patching a menu you don't fully control the contents of is the bug class;
 * building the whole tree explicitly here means every close item is
 * accounted for, and no predefined `close_window` survives anywhere in it.
 *
 * File holds two custom items instead — `MenuItem::with_id`, not
 * `PredefinedMenuItem::close_window`, since only the former can take an
 * accelerator override:
 * - "Close Tab" (⌘W) closes the About window directly when it's focused;
 *   otherwise it emits `CLOSE_TAB_EVENT` and the frontend decides what that
 *   means (close the active tab, or the window when it's the last one — see
 *   `src/hooks/use-tab-shortcuts.ts`).
 * - "Close Window" (⌘⇧W) always closes whichever window is focused — the
 *   About window (`build_about_window`) when it's the one in front, the
 *   main window otherwise — no frontend round trip.
 *
 * The Window submenu (still at the stable `WINDOW_SUBMENU_ID`) keeps only
 * minimize/maximize — both ways to close now live in File.
 */
fn build_macos_menu<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = handle.package_info();

    let app_menu = Submenu::with_items(
        handle,
        pkg_info.name.clone(),
        true,
        &[
            // Custom, not `PredefinedMenuItem::about` — muda hands AppKit's
            // native about panel an unattributed `NSAttributedString`, which
            // physically cannot render a hyperlink, and this app needs the
            // build commit shown as one. Opens `build_about_window` via
            // `on_menu_event` below instead.
            &MenuItem::with_id(handle, ABOUT_MENU_ID, "About nisi", true, None::<&str>)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(
                handle,
                CLOSE_TAB_MENU_ID,
                "Close Tab",
                true,
                Some("CmdOrCtrl+W"),
            )?,
            &MenuItem::with_id(
                handle,
                CLOSE_WINDOW_MENU_ID,
                "Close Window",
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;

    let window_menu = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(handle, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        handle,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/**
 * Creates the About window on demand (`on_menu_event`'s `ABOUT_MENU_ID`
 * arm) — a custom replacement for the native macOS About panel, which hands
 * AppKit's `AboutMetadata.credits` an unattributed `NSAttributedString`
 * that physically cannot render a hyperlink, and this app needs the build
 * commit shown as one (see `apps/desktop/src/routes/about.tsx`).
 *
 * Styled to read as a native panel rather than an app window: fixed
 * ~310x415, matching Ghostty's own About window (`resizable`/`maximizable`/
 * `minimizable` all `false`, which also greys out the corresponding traffic
 * lights), and a transparent macOS
 * titlebar overlay so the traffic lights float over the content with no
 * title strip. The background itself is a plain opaque one, from the
 * frontend's own theme tokens (`about-page.tsx`) — no window vibrancy/blur:
 * the panel this is modeled on doesn't use it either, and a translucent
 * background here would only be checkable by actually running the packaged
 * app on macOS, which isn't something either of us can currently do.
 *
 * Built hidden (`.visible(false)`) and shown from `on_page_load` once the
 * page actually finishes loading (`PageLoadEvent::Finished` — which, unlike
 * the DOM's own `load`, waits on every sub-resource including the icon
 * image), so it never flashes an unstyled, wrongly-themed, or partially
 * loaded first frame. Entirely in Rust, deliberately: a frontend-driven
 * `show()` (a `requestAnimationFrame` after mount, as this used to work)
 * races against the `on_menu_event` "already exists" branch below, which
 * also shows/focuses the window — and loses half the time, since both are
 * plausible depending on exactly when the page's JS gets a chance to run.
 * That race is what made the first click on "About nisi" do nothing; only
 * the second click worked, by hitting the already-exists branch instead.
 */
fn build_about_window<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<()> {
    WebviewWindowBuilder::new(handle, ABOUT_WINDOW_LABEL, WebviewUrl::App("/about".into()))
        .title("About nisi")
        .inner_size(310.0, 450.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .center()
        .visible(false)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Err(e) = window.show() {
                    eprintln!("failed to show the About window: {e}");
                }
            }
        })
        .build()?;
    Ok(())
}

/**
 * The currently focused webview window, if any. Iterates `webview_windows()`
 * and checks `is_focused()` rather than the crate's own `get_focused_window`,
 * which needs the `unstable` Cargo feature — explicitly allowed to break
 * across Tauri minor releases — for what's otherwise a one-window-in-N
 * lookup with a stable equivalent. A window whose focus state can't be read
 * is logged and skipped rather than silently treated as "not focused", so a
 * lookup failure on one window doesn't hide the one that actually is.
 */
fn find_focused_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    app.webview_windows()
        .into_iter()
        .find_map(|(label, window)| match window.is_focused() {
            Ok(true) => Some(window),
            Ok(false) => None,
            Err(e) => {
                eprintln!("failed to read focus state for window '{label}': {e}");
                None
            }
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .menu(build_macos_menu)
        .on_menu_event(|app, event| {
            if event.id() == CLOSE_TAB_MENU_ID {
                // The About window has no tabs — ⌘W while it's focused must
                // close the window itself rather than emitting an event only
                // the main window's `use-tab-shortcuts.ts` listens for
                // (which used to leave the About window's ⌘W a dead end).
                // Anything else focused (or nothing) keeps today's behavior.
                match find_focused_window(app) {
                    Some(window) if window.label() == ABOUT_WINDOW_LABEL => {
                        if let Err(e) = window.close() {
                            eprintln!("failed to close the About window: {e}");
                        }
                    }
                    _ => {
                        if let Err(e) = app.emit(CLOSE_TAB_EVENT, ()) {
                            eprintln!("failed to forward the Close Tab menu event: {e}");
                        }
                    }
                }
            } else if event.id() == CLOSE_WINDOW_MENU_ID {
                // The focused window, not hardcoded to "main" — now that the
                // About window (`ABOUT_WINDOW_LABEL`) exists, ⌘⇧W while it's
                // focused must close it, not the main window sitting behind
                // it.
                if let Some(window) = find_focused_window(app) {
                    if let Err(e) = window.close() {
                        eprintln!("failed to close window: {e}");
                    }
                } else {
                    eprintln!("Close Window menu event fired but no window is focused");
                }
            } else if event.id() == ABOUT_MENU_ID {
                if let Some(window) = app.get_webview_window(ABOUT_WINDOW_LABEL) {
                    if let Err(e) = window.show() {
                        eprintln!("failed to show the About window: {e}");
                    }
                    if let Err(e) = window.set_focus() {
                        eprintln!("failed to focus the About window: {e}");
                    }
                } else if let Err(e) = build_about_window(app) {
                    eprintln!("failed to create the About window: {e}");
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // NISI_DATA_DIR overrides the app data dir — useful for tests or ad-hoc
            // isolation. Absent in prod (and in the plain `scripts/dev.ts` orchestrator),
            // where the parent process never sets it, so app_data_dir() is the fallback.
            let app_data_dir = match std::env::var("NISI_DATA_DIR") {
                Ok(dir) => PathBuf::from(dir),
                Err(_) => app
                    .path()
                    .app_data_dir()
                    .map_err(|e| format!("could not resolve app data dir: {e}"))?,
            };

            let sidecar_json_path = app_data_dir.join("sidecar.json");

            // Prod: spawn the compiled sidecar binary now. This is fire-and-forget —
            // spawning is fast and must not block `.setup()`. `get_backend` (an async
            // command, run off the main thread) is what actually awaits sidecar.json.
            //
            // Dev: nothing to spawn here — the sidecar is started alongside vite by
            // `bun scripts/dev.ts`.
            #[cfg(not(debug_assertions))]
            {
                let data_dir_str = app_data_dir
                    .to_str()
                    .ok_or("app data dir path is not valid UTF-8")?
                    .to_string();

                let spawn_result = app
                    .shell()
                    .sidecar("sidecar")
                    .map_err(|e| format!("failed to create sidecar command: {e}"))?
                    .env("NISI_DATA_DIR", &data_dir_str)
                    .spawn()
                    .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

                app.manage(SidecarChild(Mutex::new(Some(spawn_result.1))));
            }

            app.manage(SidecarJsonPath(sidecar_json_path));
            app.manage(BackendCell(OnceCell::new()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_backend,
            list_available_editors,
            open_in_editor
        ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarChild>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nisi-lib-test-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /**
     * A minimal fake sidecar answering only what `is_backend_alive` needs —
     * a bearer-authed `POST /api/health/check` — enough to exercise
     * liveness-based recovery without booting the real Bun sidecar. Runs on
     * its own OS thread so it's a real TCP listener, not a mocked client.
     */
    fn spawn_fake_sidecar(expected_token: &'static str) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let authorized = request.contains(&format!("Bearer {expected_token}"));
                if authorized {
                    let body = br#"{"json":{"status":"ok"}}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.write_all(body);
                } else {
                    let _ = stream.write_all(
                        b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
                let _ = stream.flush();
            }
        });
        port
    }

    /** A `sidecar.json` already on disk, whose recorded sidecar is alive, should resolve fast. */
    #[tokio::test]
    async fn resolves_immediately_when_file_already_present_and_alive() {
        let dir = temp_dir("fresh");
        let path = dir.join("sidecar.json");
        let port = spawn_fake_sidecar("tok-fresh");
        std::fs::write(&path, format!(r#"{{"port":{port},"token":"tok-fresh"}}"#)).unwrap();

        let start = std::time::Instant::now();
        let result = wait_for_sidecar_json(&path).await.unwrap();
        let elapsed = start.elapsed();

        assert_eq!(result.port, port);
        assert_eq!(result.token, "tok-fresh");
        assert!(elapsed < Duration::from_millis(500), "took {elapsed:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * A file that appears only after the wait has started should still
     * resolve — and, critically, a concurrent task must keep making progress
     * the whole time. If `wait_for_sidecar_json` ever regresses back to
     * `thread::sleep` (blocking the whole runtime thread instead of yielding
     * via `tokio::time::sleep`), the ticker task starves and this fails —
     * this is the exact bug this fix addresses (the main thread getting
     * parked mid-poll, wedging the one-shot `invoke('get_backend')`).
     */
    #[tokio::test]
    async fn resolves_once_file_appears_later_without_blocking_the_runtime() {
        let dir = temp_dir("delayed");
        let path = dir.join("sidecar.json");
        let port = spawn_fake_sidecar("tok-delayed");

        let ticks = Arc::new(AtomicU32::new(0));
        let ticks_clone = ticks.clone();
        let ticker = tokio::spawn(async move {
            for _ in 0..30 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                ticks_clone.fetch_add(1, Ordering::SeqCst);
            }
        });

        let write_path = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1200));
            std::fs::write(
                &write_path,
                format!(r#"{{"port":{port},"token":"tok-delayed"}}"#),
            )
            .unwrap();
        });

        let start = std::time::Instant::now();
        let result = wait_for_sidecar_json(&path).await.unwrap();
        let elapsed = start.elapsed();

        assert_eq!(result.port, port);
        assert!(
            elapsed >= Duration::from_millis(1000),
            "resolved suspiciously early: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_millis(3000),
            "resolved too late: {elapsed:?}"
        );
        let tick_count = ticks.load(Ordering::SeqCst);
        assert!(
            tick_count >= 15,
            "runtime looks blocked — ticker only advanced {tick_count} times during the wait"
        );

        ticker.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * `sidecar.json` is published via a temp file + `rename()` (see
     * `publishSidecarJson`), which is atomic on one filesystem — a reader
     * can only ever observe the old content or the new content, never a
     * partial write. So a malformed file is no longer a transient mid-write
     * race worth retrying past; it's surfaced immediately.
     */
    #[tokio::test]
    async fn fails_fast_on_a_malformed_file_instead_of_retrying_for_8s() {
        let dir = temp_dir("malformed");
        let path = dir.join("sidecar.json");
        std::fs::write(&path, "not valid json").unwrap();

        let start = std::time::Instant::now();
        let result = wait_for_sidecar_json(&path).await;
        let elapsed = start.elapsed();

        assert!(result.is_err(), "expected a parse failure, got {result:?}");
        assert!(
            elapsed < Duration::from_millis(500),
            "should fail fast, not retry for up to 8s: took {elapsed:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * A `sidecar.json` whose recorded port doesn't answer (e.g. left behind
     * by a `SIGKILL`'d sidecar — see `apps/desktop/sidecar/sidecar-lock.ts`)
     * must not be trusted just because the file parses. This is what
     * `get_backend`'s `OnceCell` caching depends on: a wrong answer here
     * would wedge every `get_backend` call for the app's whole lifetime.
     */
    #[tokio::test]
    async fn keeps_polling_past_a_dead_recorded_owner_until_a_live_one_is_published() {
        let dir = temp_dir("dead-owner");
        let path = dir.join("sidecar.json");
        // Port 1 is privileged (binding needs root) but connecting doesn't —
        // nothing answers there, a deterministic "dead" port with no
        // bind-then-close timing race.
        std::fs::write(&path, r#"{"port":1,"token":"dead-token"}"#).unwrap();

        let write_path = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(700));
            let port = spawn_fake_sidecar("tok-live");
            std::fs::write(
                &write_path,
                format!(r#"{{"port":{port},"token":"tok-live"}}"#),
            )
            .unwrap();
        });

        let start = std::time::Instant::now();
        let result = wait_for_sidecar_json(&path).await.unwrap();
        let elapsed = start.elapsed();

        assert_eq!(result.token, "tok-live");
        assert!(
            elapsed >= Duration::from_millis(500),
            "resolved suspiciously early — did it trust the dead owner? {elapsed:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
