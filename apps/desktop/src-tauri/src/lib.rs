use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;
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
 * Awaits `sidecar.json` up to ~8 s (16 × 500 ms) using the async runtime's
 * timer rather than `thread::sleep`. This must never block Tauri's main
 * thread: the frontend fires its one-shot `invoke('get_backend')` as soon as
 * the webview mounts, and a blocking wait in `.setup()` used to park the main
 * thread right when that call needed servicing, wedging the UI on a fresh
 * data dir with no recovery (no retry/timeout on the frontend side either).
 * Moving the wait into this async command means `.setup()` returns
 * immediately and the invoke always gets serviced, success or timeout.
 */
async fn wait_for_sidecar_json(path: &Path) -> Result<BackendState, String> {
    for _ in 0..16 {
        if path.exists() {
            let raw = tokio::fs::read_to_string(path)
                .await
                .map_err(|e| format!("failed to read sidecar.json: {e}"))?;
            match serde_json::from_str::<SidecarJson>(&raw) {
                Ok(parsed) => {
                    return Ok(BackendState {
                        port: parsed.port,
                        token: parsed.token,
                    });
                }
                Err(_) => {
                    // File exists but parse failed — likely a mid-write partial
                    // write. Treat as transient and retry.
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!(
        "sidecar.json not found after 8 s at {}",
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
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

    /** A `sidecar.json` already on disk before the wait starts should resolve fast. */
    #[tokio::test]
    async fn resolves_immediately_when_file_already_present() {
        let dir = temp_dir("fresh");
        let path = dir.join("sidecar.json");
        std::fs::write(&path, r#"{"port":12345,"token":"tok-fresh"}"#).unwrap();

        let start = std::time::Instant::now();
        let result = wait_for_sidecar_json(&path).await.unwrap();
        let elapsed = start.elapsed();

        assert_eq!(result.port, 12345);
        assert_eq!(result.token, "tok-fresh");
        assert!(elapsed < Duration::from_millis(200), "took {elapsed:?}");

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
            std::fs::write(&write_path, r#"{"port":54321,"token":"tok-delayed"}"#).unwrap();
        });

        let start = std::time::Instant::now();
        let result = wait_for_sidecar_json(&path).await.unwrap();
        let elapsed = start.elapsed();

        assert_eq!(result.port, 54321);
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

    /** A malformed/partial `sidecar.json` (mid-write) is retried, not treated as fatal. */
    #[tokio::test]
    async fn retries_past_a_malformed_file() {
        let dir = temp_dir("malformed");
        let path = dir.join("sidecar.json");
        std::fs::write(&path, "not valid json").unwrap();

        let write_path = path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            std::fs::write(&write_path, r#"{"port":9999,"token":"tok-recovered"}"#).unwrap();
        });

        let result = wait_for_sidecar_json(&path).await.unwrap();
        assert_eq!(result.port, 9999);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
