//! Resolves the app data dir override: `NISI_DATA_DIR`, else `data_dir` in
//! `~/.config/nisi/config.toml`, else `None` (the caller's own default).
//!
//! `packages/db/src/paths.ts` implements the same rules for the sidecar and
//! CLI — change both together.

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigFile {
    data_dir: Option<String>,
}

pub fn resolve() -> Result<Option<PathBuf>, String> {
    match std::env::var("NISI_DATA_DIR") {
        Ok(dir) => return Ok(Some(PathBuf::from(dir))),
        Err(std::env::VarError::NotPresent) => {}
        Err(e) => return Err(format!("NISI_DATA_DIR is not usable: {e}")),
    }
    let home = std::env::var("HOME").map_err(|e| format!("could not resolve $HOME: {e}"))?;
    let home = PathBuf::from(home);
    let config_path = home.join(".config").join("nisi").join("config.toml");
    let contents = match std::fs::read_to_string(&config_path) {
        Ok(contents) => contents,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {}: {e}", config_path.display())),
    };
    parse_config(&contents, &config_path, &home)
}

fn parse_config(
    contents: &str,
    config_path: &Path,
    home: &Path,
) -> Result<Option<PathBuf>, String> {
    let config: ConfigFile = toml::from_str(contents)
        .map_err(|e| format!("{} is invalid: {e}", config_path.display()))?;
    let Some(raw) = config.data_dir else {
        return Ok(None);
    };
    let expanded = match raw.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(&raw),
    };
    if !expanded.is_absolute() {
        return Err(format!(
            "{}: data_dir must be an absolute path (or start with ~/), got \"{raw}\"",
            config_path.display()
        ));
    }
    Ok(Some(expanded))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG_PATH: &str = "/home/u/.config/nisi/config.toml";

    fn parse(contents: &str) -> Result<Option<PathBuf>, String> {
        parse_config(contents, Path::new(CONFIG_PATH), Path::new("/home/u"))
    }

    #[test]
    fn empty_file_has_no_value() {
        assert_eq!(parse(""), Ok(None));
    }

    #[test]
    fn absolute_path_is_returned_as_written() {
        assert_eq!(
            parse("data_dir = \"/var/nisi\""),
            Ok(Some(PathBuf::from("/var/nisi")))
        );
    }

    #[test]
    fn leading_tilde_slash_expands_to_home() {
        assert_eq!(
            parse("data_dir = \"~/nisi-data\""),
            Ok(Some(PathBuf::from("/home/u/nisi-data")))
        );
    }

    #[test]
    fn relative_path_is_rejected() {
        let err = parse("data_dir = \"relative/dir\"").unwrap_err();
        assert!(
            err.contains(CONFIG_PATH) && err.contains("absolute"),
            "{err}"
        );
    }

    #[test]
    fn non_string_data_dir_is_rejected() {
        let err = parse("data_dir = 42").unwrap_err();
        assert!(err.contains(CONFIG_PATH), "{err}");
    }

    #[test]
    fn unknown_key_is_rejected() {
        let err = parse("data_dir = \"/var/nisi\"\nextra = 1").unwrap_err();
        assert!(err.contains(CONFIG_PATH) && err.contains("extra"), "{err}");
    }

    #[test]
    fn malformed_toml_is_rejected() {
        let err = parse("data_dir = \n[").unwrap_err();
        assert!(err.contains(CONFIG_PATH), "{err}");
    }
}
