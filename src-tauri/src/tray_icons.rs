
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern, TreeScope_Descendants,
    UIA_InvokePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowA, FindWindowExA, GetCursorPos, GetWindowLongA, GetWindowRect, IsWindowVisible, SetForegroundWindow,
    SetLayeredWindowAttributes, SetWindowLongA, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, LWA_ALPHA,
    SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNA, WS_EX_LAYERED, WS_EX_TRANSPARENT,
};
use windows::core::Interface;

static AUTOMATION_LOCK: Mutex<()> = Mutex::new(());
static FLYOUT_OPEN: AtomicBool = AtomicBool::new(false);

fn automation() -> windows::core::Result<IUIAutomation> {
    unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
}

fn find_window(class: &std::ffi::CStr) -> windows::core::Result<HWND> {
    unsafe { FindWindowA(windows::core::PCSTR(class.as_ptr() as *const u8), windows::core::PCSTR::null()) }
}

fn find_overflow_window() -> Option<HWND> {
    find_window(c"TopLevelWindowForOverflowXamlIsland")
        .or_else(|_| find_window(c"NotifyIconOverflowWindow"))
        .ok()
}

fn invoke_element(el: &IUIAutomationElement) -> bool {
    unsafe {
        let Ok(pattern) = el.GetCurrentPattern(UIA_InvokePatternId) else { return false };
        let Ok(invoke_pattern) = pattern.cast::<IUIAutomationInvokePattern>() else { return false };
        invoke_pattern.Invoke().is_ok()
    }
}

fn find_show_hidden_icons_button(automation: &IUIAutomation, tray_root: &IUIAutomationElement) -> Option<IUIAutomationElement> {
    unsafe {
        let condition = automation.CreateTrueCondition().ok()?;
        let all = tray_root.FindAll(TreeScope_Descendants, &condition).ok()?;
        for i in 0..all.Length().unwrap_or(0) {
            if let Ok(el) = all.GetElement(i) {
                let automation_id = el.CurrentAutomationId().map(|s| s.to_string()).unwrap_or_default();
                if automation_id == "NotificationChevron" {
                    return Some(el);
                }
                let name = el.CurrentName().map(|s| s.to_string().to_lowercase()).unwrap_or_default();
                if name.contains("hidden icons") {
                    return Some(el);
                }
            }
        }
        None
    }
}

fn place_flyout(flyout: HWND, anchor: Option<(i32, i32)>) {
    unsafe {
        let mut cursor = POINT::default();
        let _ = GetCursorPos(&mut cursor);
        let (ax, ay) = anchor.unwrap_or((cursor.x, cursor.y - 4));
        let point = POINT { x: ax, y: ay };
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST), &mut mi);
        let work = mi.rcWork;

        let mut rect = RECT::default();
        for _ in 0..10 {
            let _ = GetWindowRect(flyout, &mut rect);
            if rect.right - rect.left > 50 { break; }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);

        let x = (ax - w / 2).clamp(work.left + 8, (work.right - w - 8).max(work.left + 8));
        let below = ay + 10;
        let y = if below + h <= work.bottom - 8 { below } else { (ay - h - 10).max(work.top + 8) };
        let _ = SetWindowPos(flyout, Some(HWND_TOPMOST), x, y, 0, 0, SWP_NOSIZE | SWP_SHOWWINDOW);
        let _ = SetForegroundWindow(flyout);
    }
}

fn tlog(msg: &str) {
    crate::diagnostics::log(&format!("tray: {msg}"));
}

/// Find the tray's "show hidden icons" chevron and press it, retrying while the
/// tray finishes coming up. Returns whether the press succeeded.
fn invoke_chevron(automation: &IUIAutomation, tray: HWND, tries: u8) -> bool {
    let Ok(root) = (unsafe { automation.ElementFromHandle(tray) }) else {
        tlog("gave up: UIA has no element for Shell_TrayWnd");
        return false;
    };
    for attempt in 0..tries {
        if let Some(button) = find_show_hidden_icons_button(automation, &root) {
            let ok = invoke_element(&button);
            tlog(&format!("chevron found on attempt {}, invoke ok={ok}", attempt + 1));
            return ok;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    tlog(&format!("chevron not found in the tray tree after {tries} tries"));
    false
}

/// Read the shell's appbar state for the taskbar (0 normal, 1 auto-hide, 2 always on top).
fn get_appbar_state(tray: HWND) -> i32 {
    use windows::Win32::UI::Shell::{SHAppBarMessage, APPBARDATA, ABM_GETSTATE};
    let mut abd = APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: tray, ..Default::default() };
    let state = unsafe { SHAppBarMessage(ABM_GETSTATE, &mut abd) };
    state as i32
}

/// Hand the shell an appbar state for the taskbar.
fn set_appbar_state(tray: HWND, state: i32) {
    use windows::Win32::UI::Shell::{SHAppBarMessage, APPBARDATA, ABM_SETSTATE};
    let mut abd = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        hWnd: tray,
        lParam: windows::Win32::Foundation::LPARAM(state as isize),
        ..Default::default()
    };
    unsafe { SHAppBarMessage(ABM_SETSTATE, &mut abd) };
}

pub fn open_native_tray(anchor: Option<(i32, i32)>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    tlog(&format!("open requested, anchor={anchor:?}, flyout_open={}", FLYOUT_OPEN.load(Ordering::SeqCst)));

    if FLYOUT_OPEN.load(Ordering::SeqCst) {
        if let (Ok(auto), Ok(tray)) = (automation(), find_window(c"Shell_TrayWnd")) {
            invoke_chevron(&auto, tray, 1);
        }
        return;
    }
    let Ok(_guard) = AUTOMATION_LOCK.try_lock() else {
        tlog("gave up: another tray operation holds the automation lock");
        return;
    };

    let Ok(tray) = find_window(c"Shell_TrayWnd") else {
        tlog("gave up: Shell_TrayWnd not found");
        return;
    };
    let Ok(auto) = automation() else {
        tlog("gave up: UI Automation unavailable");
        return;
    };

    let hidden = !unsafe { IsWindowVisible(tray) }.as_bool();
    let was_hidden_by_nectar = hidden && crate::state::NATIVE_TASKBAR_HIDDEN.swap(false, Ordering::SeqCst);
    let original_ex = unsafe { GetWindowLongA(tray, GWL_EXSTYLE) };
    let original_ab_state = get_appbar_state(tray);
    let saved_rect = crate::utils::ORIGINAL_TRAY_RECT.lock().ok().and_then(|g| *g);

    // Stay invisible the whole time: layered, fully transparent and click-through, so
    // the taskbar can be brought back without anything flashing on screen.
    if hidden {
        unsafe {
            SetWindowLongA(tray, GWL_EXSTYLE, original_ex | WS_EX_LAYERED.0 as i32 | WS_EX_TRANSPARENT.0 as i32);
            let _ = SetLayeredWindowAttributes(tray, windows::Win32::Foundation::COLORREF(0), 0, LWA_ALPHA);
            let _ = ShowWindow(tray, SW_SHOWNA);
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }

    // Only a couple of tries here. On a taskbar that Nectar parked off its monitor the
    // tray never realises, so a long search is just dead time before the escalation
    // below. Machines where the quiet show is enough still get it without a flash.
    let mut opened = invoke_chevron(&auto, tray, if hidden { 2 } else { 12 });

    // The quiet show is not always enough. Nectar hides the taskbar by unhiding nothing
    // at all: it sets SW_HIDE, parks the window below the monitor, and leaves the shell's
    // appbar state on auto-hide. The Windows 11 tray is a XAML island that only builds its
    // automation tree once the appbar is genuinely on its monitor and not flagged
    // auto-hidden, so the chevron is simply absent from the tree. Put it back for the
    // duration of the press, then let the cleanup below park it again.
    if hidden && !opened {
        tlog(&format!(
            "quiet show left the tray unrealised (ab_state={original_ab_state}), putting it back on its monitor"
        ));
        unsafe {
            set_appbar_state(tray, 0);
            if let Some(r) = saved_rect {
                use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER};
                let _ = SetWindowPos(tray, None, r.left, r.top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
            let _ = ShowWindow(tray, SW_SHOWNA);
        }
        std::thread::sleep(std::time::Duration::from_millis(600));
        opened = invoke_chevron(&auto, tray, 10);
    }

    if opened {
        FLYOUT_OPEN.store(true, Ordering::SeqCst);
        let mut placed = false;
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if let Some(flyout) = find_overflow_window() {
                place_flyout(flyout, anchor);
                placed = true;
                break;
            }
        }
        if !placed {
            tlog("invoked the chevron but no overflow window ever appeared to place");
        }

        // The flyout is its own top-level window, so the taskbar can go straight back to
        // being hidden while the flyout stays up.
        if hidden {
            unsafe {
                let _ = ShowWindow(tray, SW_HIDE);
                SetWindowLongA(tray, GWL_EXSTYLE, original_ex);
                set_appbar_state(tray, original_ab_state);
            }
            if was_hidden_by_nectar {
                crate::utils::set_taskbar_visibility(false, false);
                crate::state::NATIVE_TASKBAR_HIDDEN.store(true, Ordering::SeqCst);
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(500));
        for _ in 0..2400 {
            if find_overflow_window().is_none_or(|w| !unsafe { IsWindowVisible(w) }.as_bool()) { break; }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        FLYOUT_OPEN.store(false, Ordering::SeqCst);
        return;
    }

    if hidden {
        unsafe {
            let _ = ShowWindow(tray, SW_HIDE);
            SetWindowLongA(tray, GWL_EXSTYLE, original_ex);
            set_appbar_state(tray, original_ab_state);
        }
        if was_hidden_by_nectar {
            crate::utils::set_taskbar_visibility(false, false);
            crate::state::NATIVE_TASKBAR_HIDDEN.store(true, Ordering::SeqCst);
        }
    }
}

fn all_taskbars() -> Vec<HWND> {
    let mut taskbars = Vec::new();
    if let Ok(primary) = find_window(c"Shell_TrayWnd") {
        taskbars.push(primary);
    }
    let mut previous = None;
    loop {
        let next = unsafe {
            FindWindowExA(None, previous, windows::core::PCSTR(c"Shell_SecondaryTrayWnd".as_ptr() as *const u8), windows::core::PCSTR::null())
        };
        match next {
            Ok(hwnd) if !hwnd.0.is_null() => {
                taskbars.push(hwnd);
                previous = Some(hwnd);
            }
            _ => break,
        }
    }
    taskbars
}

pub fn schedule_taskbar_layout_refresh() {
    static SCHEDULED: AtomicBool = AtomicBool::new(false);
    if SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        let Ok(_guard) = AUTOMATION_LOCK.try_lock() else { return };
        if !crate::state::NATIVE_TASKBAR_HIDDEN.swap(false, Ordering::SeqCst) {
            return;
        }

        let taskbars = all_taskbars();
        let originals: Vec<(HWND, i32)> = taskbars
            .iter()
            .map(|&hwnd| (hwnd, unsafe { GetWindowLongA(hwnd, GWL_EXSTYLE) }))
            .collect();
        for &(hwnd, ex) in &originals {
            unsafe {
                SetWindowLongA(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED.0 as i32 | WS_EX_TRANSPARENT.0 as i32);
                let _ = SetLayeredWindowAttributes(hwnd, windows::Win32::Foundation::COLORREF(0), 0, LWA_ALPHA);
                let _ = ShowWindow(hwnd, SW_SHOWNA);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
        for &(hwnd, ex) in &originals {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
                SetWindowLongA(hwnd, GWL_EXSTYLE, ex);
            }
        }
        crate::utils::set_taskbar_visibility(false, false);
        crate::state::NATIVE_TASKBAR_HIDDEN.store(true, Ordering::SeqCst);
    });
}
