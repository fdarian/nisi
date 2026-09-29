//! `tauri-runtime-cef` restores the pre-CEF termination handlers only on
//! Linux/BSD. On macOS, Chromium's handlers (installed in `cef::initialize`)
//! swallow SIGINT/SIGTERM/SIGHUP without quitting the event loop, so Ctrl+C in
//! `bun dev` leaves the window open. Delete this once upstream adds macOS to
//! its `TerminationSignals` cfg.

use std::io;
use std::mem::MaybeUninit;

const TERMINATION_SIGNALS: [libc::c_int; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

struct SavedHandler {
    signal: libc::c_int,
    action: libc::sigaction,
}

pub struct TerminationSignals(Vec<SavedHandler>);

impl TerminationSignals {
    /// Call before the CEF runtime is built.
    pub fn capture() -> io::Result<Self> {
        TERMINATION_SIGNALS
            .iter()
            .map(|&signal| {
                let mut action = MaybeUninit::<libc::sigaction>::uninit();
                if unsafe { libc::sigaction(signal, std::ptr::null(), action.as_mut_ptr()) } != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(SavedHandler {
                    signal,
                    action: unsafe { action.assume_init() },
                })
            })
            .collect::<io::Result<Vec<_>>>()
            .map(Self)
    }

    /// Call after the CEF runtime is built; nothing reinstalls CEF's handlers later.
    pub fn restore(&self) -> io::Result<()> {
        for saved in &self.0 {
            if unsafe { libc::sigaction(saved.signal, &saved.action, std::ptr::null_mut()) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}
