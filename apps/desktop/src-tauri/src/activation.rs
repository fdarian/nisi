use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, Runtime};

use crate::wait_for_sidecar_json;

#[derive(Deserialize)]
struct ActivationMessage {
    id: String,
}

pub fn activate_main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    window.show()?;
    window.unminimize()?;
    // Tauri's macOS dispatcher reaches tao's set_focus, which calls both
    // makeKeyAndOrderFront and NSApplication.activateIgnoringOtherApps.
    window.set_focus()
}

pub async fn watch<R: Runtime>(
    app: tauri::AppHandle<R>,
    handshake_path: PathBuf,
    owner_id: String,
) {
    let client = reqwest::Client::new();
    loop {
        let backend = match wait_for_sidecar_json(&handshake_path).await {
            Ok(backend) => backend,
            Err(error) => {
                eprintln!("activation bridge waiting for sidecar: {error}");
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        let origin = format!("http://127.0.0.1:{}", backend.port);
        let response = client
            .get(format!("{origin}/native/activation"))
            .bearer_auth(&backend.token)
            .header("x-nisi-activation-owner", &owner_id)
            .send()
            .await;
        if let Ok(mut response) = response {
            if response.status().is_success() {
                let mut buffer = Vec::new();
                'stream: loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) => {
                            buffer.extend_from_slice(&chunk);
                            while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                                let line: Vec<u8> = buffer.drain(..=end).collect();
                                match serde_json::from_slice::<ActivationMessage>(&line) {
                                    Ok(message) => {
                                        if let Err(error) = activate_main_window(&app) {
                                            eprintln!("failed to activate main window: {error}");
                                            break 'stream;
                                        }
                                        match client
                                            .post(format!("{origin}/native/activation/ack"))
                                            .query(&[("id", &message.id)])
                                            .bearer_auth(&backend.token)
                                            .header("x-nisi-activation-owner", &owner_id)
                                            .timeout(Duration::from_secs(2))
                                            .send()
                                            .await
                                        {
                                            Ok(response) if response.status().is_success() => {}
                                            Ok(response) => {
                                                eprintln!(
                                                    "activation acknowledgement returned {}",
                                                    response.status()
                                                );
                                                break 'stream;
                                            }
                                            Err(error) => {
                                                eprintln!(
                                                    "failed to acknowledge activation: {error}"
                                                );
                                                break 'stream;
                                            }
                                        }
                                    }
                                    Err(error) => eprintln!("invalid activation message: {error}"),
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(error) => {
                            eprintln!("activation stream disconnected: {error}");
                            break;
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
