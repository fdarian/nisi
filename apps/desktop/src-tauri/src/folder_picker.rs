use std::path::Path;

fn selected_folder_path(path: Option<&Path>) -> Result<Option<String>, String> {
    path.map(|path| {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "Selected folder path is not valid UTF-8".to_owned())
    })
    .transpose()
}

#[tauri::command]
pub async fn pick_folder(
    window: tauri::WebviewWindow,
    title: String,
) -> Result<Option<String>, String> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title(title)
        .set_parent(&window)
        .pick_folder()
        .await;
    selected_folder_path(picked.as_ref().map(|folder| folder.path()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_returns_none() {
        assert_eq!(selected_folder_path(None), Ok(None));
    }

    #[test]
    fn preserves_utf8_paths() {
        let path = Path::new("/repos/café");
        assert_eq!(
            selected_folder_path(Some(path)),
            Ok(Some("/repos/café".to_owned()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_utf8_paths() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let path = Path::new(OsStr::from_bytes(b"/repos/\xff"));
        assert_eq!(
            selected_folder_path(Some(path)),
            Err("Selected folder path is not valid UTF-8".to_owned())
        );
    }
}
