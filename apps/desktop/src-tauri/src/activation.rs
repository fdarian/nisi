use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use tauri::Manager;

use crate::{wait_for_sidecar_json, BackendState};

#[derive(Deserialize)]
struct ActivationMessage {
    id: String,
}

pub fn activate_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    if !focus_main_window(std::env::var("NISI_MEASUREMENT_INSTANCE").ok().as_deref()) {
        window.unminimize()?;
        #[cfg(target_os = "macos")]
        {
            let native_window = window.ns_window()? as usize;
            // Tauri show() makes the window key; orderBack reveals it without raising or activating the app.
            app.run_on_main_thread_blocking(move || {
                let native_window = unsafe { &*(native_window as *const objc2_app_kit::NSWindow) };
                native_window.orderBack(None);
            })?;
        }
        #[cfg(not(target_os = "macos"))]
        window.show()?;
        return Ok(());
    }
    window.show()?;
    window.unminimize()?;
    // Tauri's macOS dispatcher reaches tao's set_focus, which calls both
    // makeKeyAndOrderFront and NSApplication.activateIgnoringOtherApps.
    window.set_focus()
}

fn focus_main_window(measurement_instance: Option<&str>) -> bool {
    measurement_instance != Some("1")
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_measurement_instances_skip_focus() {
        assert!(super::focus_main_window(None));
        assert!(super::focus_main_window(Some("0")));
        assert!(super::focus_main_window(Some("true")));
        assert!(!super::focus_main_window(Some("1")));
    }
}

enum Connection {
    Stream(reqwest::Response),
    Claimed,
}

async fn connect(
    client: &reqwest::Client,
    backend: &BackendState,
    owner_id: &str,
) -> Result<Connection, String> {
    let origin = format!("http://127.0.0.1:{}", backend.port);
    let response = client
        .get(format!("{origin}/native/activation"))
        .bearer_auth(&backend.token)
        .header("x-nisi-activation-owner", owner_id)
        .send()
        .await
        .map_err(|error| format!("activation stream connection failed: {error}"))?;

    if response.status().is_success() {
        return Ok(Connection::Stream(response));
    }
    if response.status() != reqwest::StatusCode::FORBIDDEN {
        return Err(format!(
            "activation stream returned {} (check sidecar credentials)",
            response.status()
        ));
    }

    let claim = client
        .post(format!("{origin}/native/activation/claim"))
        .bearer_auth(&backend.token)
        .header("x-nisi-activation-owner", owner_id)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|error| format!("activation ownership claim failed: {error}"))?;
    if claim.status().is_success() {
        return Ok(Connection::Claimed);
    }
    Err(format!(
        "activation owner mismatch: sidecar refused takeover with {} (another app may still own its activation stream)",
        claim.status()
    ))
}

async fn handle_message(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    backend: &BackendState,
    owner_id: &str,
    line: &[u8],
) -> Result<(), String> {
    let message: ActivationMessage = serde_json::from_slice(line)
        .map_err(|error| format!("invalid activation message: {error}"))?;
    activate_main_window(app)
        .map_err(|error| format!("failed to activate main window: {error}"))?;

    let response = client
        .post(format!(
            "http://127.0.0.1:{}/native/activation/ack",
            backend.port
        ))
        .query(&[("id", &message.id)])
        .bearer_auth(&backend.token)
        .header("x-nisi-activation-owner", owner_id)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|error| format!("failed to acknowledge activation: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "activation acknowledgement returned {}",
            response.status()
        ));
    }
    Ok(())
}

async fn read_lines(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    backend: &BackendState,
    owner_id: &str,
    mut response: reqwest::Response,
    retry_ms: &mut u64,
) -> Result<(), String> {
    let mut buffer = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| format!("activation stream disconnected: {error}"))?
            .ok_or("activation stream closed")?;
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            if line.iter().all(|byte| byte.is_ascii_whitespace()) {
                continue;
            }
            handle_message(app, client, backend, owner_id, &line).await?;
            *retry_ms = 500;
        }
    }
}

pub async fn watch(app: tauri::AppHandle, handshake_path: PathBuf, owner_id: String) {
    let client = reqwest::Client::new();
    let mut retry_ms = 500u64;
    loop {
        let result = match wait_for_sidecar_json(&handshake_path).await {
            Ok(backend) => match connect(&client, &backend, &owner_id).await {
                Ok(Connection::Stream(response)) => {
                    read_lines(&app, &client, &backend, &owner_id, response, &mut retry_ms).await
                }
                Ok(Connection::Claimed) => continue,
                Err(error) => Err(error),
            },
            Err(error) => Err(format!("activation bridge waiting for sidecar: {error}")),
        };
        if let Err(error) = result {
            eprintln!("{error}; retrying in {retry_ms} ms");
        }
        tokio::time::sleep(Duration::from_millis(retry_ms)).await;
        retry_ms = (retry_ms * 2).min(30_000);
    }
}
