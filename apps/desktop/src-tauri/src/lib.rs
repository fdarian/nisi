use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID};
use tauri::{Emitter, Manager, Runtime};
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

/** Id of the Window menu's ⌘W item, and the event it emits to the frontend. */
const CLOSE_TAB_MENU_ID: &str = "close-tab";
const CLOSE_TAB_EVENT: &str = "menu://close-tab";

/**
 * Tauri's default macOS menu (`Menu::default`) puts a predefined "Close"
 * item on ⌘W, and AppKit offers a keystroke to the main menu's key
 * equivalents *before* the key window's responder chain — so the webview
 * never sees ⌘W and a frontend listener for it can never fire. This swaps
 * the whole Window submenu for one whose ⌘W is a plain "Close Tab" item that
 * does nothing but emit `CLOSE_TAB_EVENT`, leaving the actual decision —
 * close the active tab, or close the window when it's the last one — to
 * `src/hooks/use-tab-shortcuts.ts`, alongside the rest of the tab
 * keybindings.
 *
 * Rebuilding the submenu wholesale rather than deleting just the predefined
 * item is deliberate: the top-level submenu has a public, stable id
 * (`WINDOW_SUBMENU_ID`) to find it by, while a predefined item's id is
 * generated at construction and could only be matched by its label.
 */
fn menu_with_close_tab<R: Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;
    let position = menu
        .items()?
        .iter()
        .position(|item| item.id() == WINDOW_SUBMENU_ID)
        .ok_or_else(|| {
            tauri::Error::Setup(
                Box::<dyn std::error::Error>::from(
                    "Tauri's default menu no longer has a Window submenu to put Close Tab in",
                )
                .into(),
            )
        })?;

    let window_menu = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(
                handle,
                CLOSE_TAB_MENU_ID,
                "Close Tab",
                true,
                Some("CmdOrCtrl+W"),
            )?,
        ],
    )?;

    menu.remove_at(position)?;
    menu.insert(&window_menu, position)?;
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .menu(menu_with_close_tab)
        .on_menu_event(|app, event| {
            if event.id() == CLOSE_TAB_MENU_ID {
                if let Err(e) = app.emit(CLOSE_TAB_EVENT, ()) {
                    eprintln!("failed to forward the Close Tab menu event: {e}");
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
        .invoke_handler(tauri::generate_handler![get_backend]);

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
