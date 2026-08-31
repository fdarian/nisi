use std::env;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use percent_encoding::utf8_percent_encode;
use tauri_plugin_opener::OpenerExt;

use super::PATH_SAFE;

/**
 * The real Zed CLI binary — `/usr/local/bin/zed` is a symlink to this one.
 * Checked first because a Tauri GUI process doesn't inherit the login
 * shell's `PATH`, so relying on that symlink resolving is unreliable from
 * inside the app; `resolve_zed_cli` only falls back to a `PATH` lookup when
 * this path is absent.
 */
const BUNDLED_ZED_CLI: &str = "/Applications/Zed.app/Contents/MacOS/cli";

/**
 * Opens `repo_root` and `path` in Zed as a single CLI invocation —
 * `zed <repo_root> <path>` — instead of the `zed://file/<path>` URL scheme
 * every other editor uses. Zed's URL parser accepts exactly one path, so
 * routing a file through it makes the file itself the project root and the
 * repo root is lost; the CLI form doesn't have that limit.
 *
 * `Workspace::open_paths` (Zed's side) sorts parents before children and
 * calls `find_or_create_worktree`, which reuses an existing worktree rather
 * than adding a duplicate root — so `repo_root` becomes the one worktree and
 * `path` opens as a tab inside it. Zed also does its own live containment
 * check against already-open windows (`find_existing_workspace`), so window
 * reuse is Zed's job: this function never tracks sessions or windows of its
 * own, and never passes `--wait`.
 *
 * When neither the bundled CLI nor a `PATH` `zed` resolves, this falls back
 * to the `zed://file/<path>` URL scheme — a deliberate degraded path, not a
 * swallowed error. That URL drops the repo root the same way `open_in_editor`
 * always has for Zed, so it's not a regression, just a loss of the project
 * context this function exists to add.
 */
pub fn open(app: &tauri::AppHandle, repo_root: &str, path: &str) -> Result<(), String> {
    match resolve_zed_cli() {
        Some(cli) => spawn_zed_cli(&cli, repo_root, path),
        None => {
            eprintln!(
                "no Zed CLI found (checked {BUNDLED_ZED_CLI} and PATH) — opening {path} via zed://file instead, with no project root"
            );
            open_via_url(app, path)
        }
    }
}

fn resolve_zed_cli() -> Option<PathBuf> {
    let bundled = Path::new(BUNDLED_ZED_CLI);
    if bundled.is_file() {
        return Some(bundled.to_path_buf());
    }
    resolve_on_path("zed")
}

/**
 * Mimics `which zed` over the current process's own `PATH` — checking
 * resolvability up front, rather than just calling `Command::new("zed")`
 * and letting `spawn` fail, is what lets a missing CLI fall back to the
 * `zed://file` URL instead of surfacing a spawn error to the user.
 */
fn resolve_on_path(name: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    env::split_paths(&path_var).find_map(|dir| {
        let candidate = dir.join(name);
        let metadata = std::fs::metadata(&candidate).ok()?;
        let is_executable = metadata.is_file() && metadata.permissions().mode() & 0o111 != 0;
        is_executable.then_some(candidate)
    })
}

fn spawn_zed_cli(cli: &Path, repo_root: &str, path: &str) -> Result<(), String> {
    let mut command = Command::new(cli);
    command.arg(repo_root);
    // `pr-header.tsx`'s "Open in..." opens the repo root itself, handing
    // this the same value for both — skip the duplicate arg rather than
    // pass Zed a redundant path.
    if path != repo_root {
        command.arg(path);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_child| ())
        .map_err(|e| format!("failed to spawn Zed CLI at {}: {e}", cli.display()))
}

fn open_via_url(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let encoded_path = utf8_percent_encode(path, PATH_SAFE).to_string();
    let url = format!("zed://file/{encoded_path}");
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("failed to open zed: {e}"))
}
