//! Clipboard history: the last few things you copied, with what you had in focus
//! when you copied them.
//!
//! Windows gives us `GetClipboardSequenceNumber()`, which ticks whenever anything
//! writes to the clipboard. Polling that is far cheaper and far more reliable than
//! being a clipboard viewer chain member, which needs a hidden window and breaks if
//! another app drops the chain.
//!
//! Off by default. Everything you copy passes through here, including passwords and
//! tokens, so `nectar-clipboard-enabled` has to be turned on deliberately, and
//! nothing is ever written to disk.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
    OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// How many entries we keep.
const DEFAULT_LIMIT: usize = 15;
/// Anything bigger than this is a blob, not a snippet, and is not worth keeping.
const MAX_TEXT_CHARS: usize = 20_000;
/// Clipboard owners routinely hold the clipboard for a moment during a paste.
const OPEN_RETRIES: u32 = 3;

#[derive(Clone, Serialize)]
pub struct ClipEntry {
    pub text: String,
    /// Milliseconds since the unix epoch.
    pub copied_at: i64,
    /// Process name of the window that had focus when the copy happened.
    pub source: Option<String>,
}

fn store() -> &'static Mutex<Vec<ClipEntry>> {
    static CELL: OnceLock<Mutex<Vec<ClipEntry>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(Vec::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Settings are strings for historical reasons but may be written as real JSON
/// booleans or numbers, so read them tolerantly.
fn setting_flag(key: &str, default: bool) -> bool {
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
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => default,
        },
        _ => default,
    }
}

fn setting_usize(key: &str, default: usize) -> usize {
    let Some(cache) = crate::state::SETTINGS_CACHE.get() else {
        return default;
    };
    let Ok(guard) = cache.lock() else {
        return default;
    };
    let Some(value) = guard.get(key) else {
        return default;
    };
    let parsed = match value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    parsed.map(|v| v as usize).filter(|v| (1..=100).contains(v)).unwrap_or(default)
}

/// Name of the process holding focus, used as the "copied from" label.
unsafe fn foreground_source() -> Option<String> {
    let hwnd = GetForegroundWindow();
    if hwnd.0.is_null() {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return None;
    }
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(process);
    if ok.is_err() || len == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let file = path.rsplit(['\\', '/']).next()?;
    Some(file.trim_end_matches(".exe").to_string())
}

/// Read the current clipboard text. Returns None when there is nothing text-shaped there.
unsafe fn read_text() -> Option<String> {
    if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_err() {
        return None;
    }
    let mut opened = false;
    for attempt in 0..OPEN_RETRIES {
        if OpenClipboard(None).is_ok() {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(40 * (attempt as u64 + 1)));
    }
    if !opened {
        return None;
    }
    let text = (|| {
        let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
        let hglobal = HGLOBAL(handle.0);
        let ptr = GlobalLock(hglobal) as *const u16;
        if ptr.is_null() {
            return None;
        }
        let size = GlobalSize(hglobal);
        let slice = std::slice::from_raw_parts(ptr, size / 2);
        let end = slice.iter().position(|c| *c == 0).unwrap_or(slice.len());
        let out = String::from_utf16_lossy(&slice[..end]);
        let _ = GlobalUnlock(hglobal);
        Some(out)
    })();
    let _ = CloseClipboard();
    text
}

/// Put text back on the clipboard so the user can paste it wherever they like.
unsafe fn write_text(text: &str) -> Result<(), String> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * 2;

    let mut opened = false;
    for attempt in 0..OPEN_RETRIES {
        if OpenClipboard(None).is_ok() {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(40 * (attempt as u64 + 1)));
    }
    if !opened {
        return Err("clipboard is busy".into());
    }
    let result = (|| -> Result<(), String> {
        EmptyClipboard().map_err(|e| e.message())?;
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| e.message())?;
        let ptr = GlobalLock(hglobal) as *mut u16;
        if ptr.is_null() {
            let _ = GlobalUnlock(hglobal);
            return Err("could not lock clipboard memory".into());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
        GlobalUnlock(hglobal).map_err(|e| e.message())?;
        // On success the clipboard owns this block and must not be freed by us.
        if SetClipboardData(CF_UNICODETEXT.0 as u32, Some(windows::Win32::Foundation::HANDLE(hglobal.0)))
            .is_err()
        {
            return Err("clipboard rejected the text".into());
        }
        Ok(())
    })();
    let _ = CloseClipboard();
    result
}

fn push_entry(entry: ClipEntry, limit: usize) -> Vec<ClipEntry> {
    let Ok(mut guard) = store().lock() else {
        return Vec::new();
    };
    // Re-copying the same thing should move it to the front, not pile up duplicates.
    if let Some(pos) = guard.iter().position(|e| e.text == entry.text) {
        guard.remove(pos);
    }
    guard.insert(0, entry);
    guard.truncate(limit);
    guard.clone()
}

/// Watch the clipboard sequence number and emit `clipboard-history` after each copy.
pub fn setup_clipboard_watchdog(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(Duration::from_millis(700));
            if crate::state::SHUTTING_DOWN.load(std::sync::atomic::Ordering::Relaxed) {
                continue;
            }
            let seq = unsafe { GetClipboardSequenceNumber() };
            if !setting_flag("nectar-clipboard-enabled", false) {
                // Switched off: keep the number current so turning it back on does not
                // sweep up whatever is already on the clipboard, and drop what we hold.
                last_seq = seq;
                let had_entries = store().lock().map(|g| !g.is_empty()).unwrap_or(false);
                if had_entries {
                    if let Ok(mut guard) = store().lock() {
                        guard.clear();
                    }
                    let _ = app.emit("clipboard-history", Vec::<ClipEntry>::new());
                }
                continue;
            }
            if seq == last_seq {
                continue;
            }
            last_seq = seq;
            let Some(raw) = (unsafe { read_text() }) else {
                continue;
            };
            let text = raw.trim().to_string();
            if text.chars().count() < 2 || text.chars().count() > MAX_TEXT_CHARS {
                continue;
            }
            let source = unsafe { foreground_source() };
            let limit = setting_usize("nectar-clipboard-history-size", DEFAULT_LIMIT);
            let history = push_entry(
                ClipEntry {
                    text,
                    copied_at: now_ms(),
                    source,
                },
                limit,
            );
            let _ = app.emit("clipboard-history", history);
        }
    });
}

#[tauri::command]
pub fn get_clipboard_history() -> Vec<ClipEntry> {
    store().lock().map(|g| g.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn clipboard_restore(index: usize) -> Result<(), String> {
    let Some(entry) = store().lock().ok().and_then(|g| g.get(index).cloned()) else {
        return Err("that entry is no longer in the history".into());
    };
    unsafe { write_text(&entry.text) }
}

#[tauri::command]
pub fn clipboard_delete(index: usize) -> Vec<ClipEntry> {
    if let Ok(mut guard) = store().lock() {
        guard.remove(index);
        return guard.clone();
    }
    Vec::new()
}

#[tauri::command]
pub fn clipboard_clear() -> Vec<ClipEntry> {
    if let Ok(mut guard) = store().lock() {
        guard.clear();
    }
    Vec::new()
}
