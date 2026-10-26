//! Is someone actually at this machine, and for how long have they been going?
//!
//! Windows already tracks the last input event for the whole session, so we read
//! that instead of counting on our own global hooks. A hook only sees input that
//! reaches the hook chain, and it goes quiet when another app is elevated.
//! `GetLastInputInfo` covers keyboard, mouse and whatever else the shell counts as
//! input, with no hook to install.
//!
//! Two numbers come out of this module:
//!   * `idle_ms`   - how long since the last input.
//!   * `focus_ms`  - how long the current run of activity has lasted. A run survives
//!                   short pauses and only restarts once the machine has been quiet
//!                   for `nectar-activity-reset-after` seconds, so stepping away to
//!                   make tea does not reset your break timer.
//!
//! The notch pet and the wellness nudges are both driven from here.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

/// Milliseconds since the last input, as of the most recent poll.
static IDLE_MS: AtomicU64 = AtomicU64::new(0);
/// Length of the current run of activity, as of the most recent poll.
static FOCUS_MS: AtomicU64 = AtomicU64::new(0);
/// `false` once the machine has been quiet for `nectar-pet-sleep-after` seconds.
static ACTIVE: AtomicBool = AtomicBool::new(true);

/// Payload of the `user-state` event, and the return type of `get_user_state`.
#[derive(Clone, Serialize)]
pub struct UserState {
    pub active: bool,
    pub idle_ms: u64,
    pub focus_ms: u64,
}

/// Milliseconds since the user last touched the keyboard or mouse.
///
/// `dwTime` is a 32 bit tick counter, so it wraps roughly every 49.7 days of uptime.
/// Subtracting in `u32` with `wrapping_sub` keeps the answer correct across that wrap,
/// which a plain `u64` subtraction would not.
pub fn idle_ms() -> Option<u64> {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        return None;
    }
    let now = unsafe { GetTickCount64() } as u32;
    Some(now.wrapping_sub(info.dwTime) as u64)
}

/// Read a numeric setting that may arrive as a JSON number or as a quoted string,
/// since `settings.json` has historically stored everything as a string.
fn setting_number(key: &str, default: f64) -> f64 {
    let Some(cache) = crate::state::SETTINGS_CACHE.get() else {
        return default;
    };
    let Ok(guard) = cache.lock() else {
        return default;
    };
    let Some(value) = guard.get(key) else {
        return default;
    };
    match value {
        serde_json::Value::String(s) => s.trim().parse::<f64>().unwrap_or(default),
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(default),
        _ => default,
    }
}

/// Poll once a second and emit `user-state` when the answer changes, plus once a
/// minute while the user keeps going so long focus runs stay in sync.
pub fn setup_activity_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        let mut focus_ms: u64 = 0;
        let mut last_active = true;
        let mut last_focus_bucket = u64::MAX;

        // Give the first webview render something to work with instead of making it
        // wait up to a second for the first transition.
        if let Some(idle) = idle_ms() {
            IDLE_MS.store(idle, Ordering::Relaxed);
            let _ = app.emit(
                "user-state",
                UserState {
                    active: true,
                    idle_ms: idle,
                    focus_ms: 0,
                },
            );
        }

        loop {
            std::thread::sleep(Duration::from_millis(1000));
            if crate::state::SHUTTING_DOWN.load(Ordering::Relaxed) {
                continue;
            }
            let Some(idle) = idle_ms() else { continue };

            // Floor both thresholds so a typo in settings.json cannot make the pet
            // flicker or the focus run reset on every poll.
            let sleep_after_ms = (setting_number("nectar-pet-sleep-after", 90.0).max(5.0) * 1000.0) as u64;
            let reset_after_ms = (setting_number("nectar-activity-reset-after", 240.0).max(30.0) * 1000.0) as u64;

            let active = idle < sleep_after_ms;
            if active {
                focus_ms = focus_ms.saturating_add(1000);
            } else if idle >= reset_after_ms {
                focus_ms = 0;
            }

            IDLE_MS.store(idle, Ordering::Relaxed);
            FOCUS_MS.store(focus_ms, Ordering::Relaxed);
            ACTIVE.store(active, Ordering::Relaxed);

            let focus_bucket = focus_ms / 60_000;
            if active != last_active || focus_bucket != last_focus_bucket {
                last_active = active;
                last_focus_bucket = focus_bucket;
                let _ = app.emit(
                    "user-state",
                    UserState {
                        active,
                        idle_ms: idle,
                        focus_ms,
                    },
                );
            }
        }
    });
}

#[tauri::command]
pub fn get_user_state() -> UserState {
    UserState {
        active: ACTIVE.load(Ordering::Relaxed),
        idle_ms: IDLE_MS.load(Ordering::Relaxed),
        focus_ms: FOCUS_MS.load(Ordering::Relaxed),
    }
}
