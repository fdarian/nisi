use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSString, NSURL};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

/** One "Open in..." entry — an editor with a URL scheme registered in macOS Launch Services. */
#[derive(Debug, Clone, Serialize)]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
}

/**
 * Editors probed for a registered `<scheme>://` handler, in the order they
 * should appear in the "Open in..." submenu. Xcode is deliberately excluded
 * here — this menu is for handing a PR's repo root to a general-purpose code
 * editor, not a full IDE picker.
 */
const CANDIDATE_EDITORS: &[(&str, &str)] = &[
    ("vscode", "VS Code"),
    ("cursor", "Cursor"),
    ("zed", "Zed"),
    ("windsurf", "Windsurf"),
];

/**
 * Whether macOS Launch Services currently has an app registered to open
 * `scheme://` URLs. Asked live via `NSWorkspace` on every call rather than
 * cached at startup, so installing or uninstalling an editor is reflected
 * the next time the dropdown opens instead of needing an app restart.
 */
fn has_registered_handler(scheme: &str) -> bool {
    let probe = NSString::from_str(&format!("{scheme}://"));
    let Some(url) = NSURL::URLWithString(&probe) else {
        return false;
    };
    NSWorkspace::sharedWorkspace()
        .URLForApplicationToOpenURL(&url)
        .is_some()
}

/** Editors with a registered handler, for the PR header's "Open in..." submenu. */
#[tauri::command]
pub fn list_available_editors() -> Vec<EditorInfo> {
    CANDIDATE_EDITORS
        .iter()
        .filter(|(scheme, _)| has_registered_handler(scheme))
        .map(|(id, name)| EditorInfo {
            id: (*id).to_string(),
            name: (*name).to_string(),
        })
        .collect()
}

/**
 * Characters left unescaped inside the `file/<path>` segment of an editor
 * URL — every RFC 3986 unreserved character plus `/`, since `path` is an
 * absolute filesystem path whose separators the receiving editor expects
 * literally, not encoded as `%2F`.
 */
const PATH_SAFE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/**
 * Opens `path` — a repo root, never a specific file/line — in the editor
 * registered for `scheme`. Built as `<scheme>://file/<percent-encoded-path>`
 * and handed to `tauri_plugin_opener`'s Rust `open_url` directly (the plugin
 * already registered in `lib.rs`'s builder; its sibling `tauri_plugin_shell`
 * has an equivalent `open`, but that one is deprecated in favor of this).
 * Called from inside a command function like this rather than invoked over
 * IPC, it bypasses the capability/ACL system entirely — no `shell:allow-open`
 * or opener-equivalent grant is needed for this to work.
 */
#[tauri::command]
pub fn open_in_editor(app: tauri::AppHandle, scheme: String, path: String) -> Result<(), String> {
    let encoded_path = utf8_percent_encode(&path, PATH_SAFE).to_string();
    let url = format!("{scheme}://file/{encoded_path}");
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("failed to open {scheme}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /** Sanity check against whatever editors are actually installed on the machine running this test — not asserting a specific set, just that the live Launch Services query doesn't panic and returns a well-formed list. */
    #[test]
    fn lists_editors_without_panicking() {
        let editors = list_available_editors();
        eprintln!("detected editors: {editors:?}");
        for editor in &editors {
            assert!(CANDIDATE_EDITORS.iter().any(|(id, _)| *id == editor.id));
        }
    }
}
