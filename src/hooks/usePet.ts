import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { PetState } from "../components/NotchPet";

/**
 * Drives the notch pet and the break nudge from the backend's activity signal.
 *
 * The Rust side (`src-tauri/src/activity.rs`) reports `user-state` when the machine
 * crosses the sleep threshold, and once a minute while you keep working. That is
 * too coarse on its own for a smooth sleepy -> dozing -> asleep ramp, so we take the
 * reported idle time, work out the instant of last input from it, and then count up
 * locally between reports.
 */

export interface UserState {
  active: boolean;
  idle_ms: number;
  focus_ms: number;
}

export interface PetSettings {
  enabled: boolean;
  /** Seconds of no input before the pet is fully asleep. */
  sleepAfterSec: number;
  /** Minutes of work that trigger the nudge. 0 switches it off. */
  breakAfterMin: number;
  /** Seconds of quiet that count as having taken the break. Matches the backend's
   *  `nectar-activity-reset-after`, which restarts the focus run over this long. */
  breakResetSec: number;
  /** Body colour of the pet. */
  hue: string;
}

const DEFAULTS: PetSettings = {
  enabled: true,
  sleepAfterSec: 90,
  breakAfterMin: 45,
  breakResetSec: 240,
  hue: "#f6c453",
};

const STORAGE = {
  enabled: "nectar-pet-enabled",
  sleep: "nectar-pet-sleep-after",
  breakAfter: "nectar-pet-break-after-min",
  breakReset: "nectar-activity-reset-after",
  hue: "nectar-pet-hue",
};

function boolOf(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fallback;
}

function numOf(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readSettings(raw: Record<string, unknown>): PetSettings {
  return {
    enabled: boolOf(raw[STORAGE.enabled], DEFAULTS.enabled),
    sleepAfterSec: Math.max(5, numOf(raw[STORAGE.sleep], DEFAULTS.sleepAfterSec)),
    breakAfterMin: numOf(raw[STORAGE.breakAfter], DEFAULTS.breakAfterMin),
    breakResetSec: Math.max(30, numOf(raw[STORAGE.breakReset], DEFAULTS.breakResetSec)),
    hue: typeof raw[STORAGE.hue] === "string" ? (raw[STORAGE.hue] as string) : DEFAULTS.hue,
  };
}

interface UsePetOptions {
  /** Suppress the break nudge, e.g. while Do Not Disturb is on. */
  muted?: boolean;
}

export function usePet({ muted = false }: UsePetOptions = {}) {
  const [settings, setSettings] = useState<PetSettings>(() =>
    readSettings({
      [STORAGE.enabled]: localStorage.getItem(STORAGE.enabled),
      [STORAGE.sleep]: localStorage.getItem(STORAGE.sleep),
      [STORAGE.breakAfter]: localStorage.getItem(STORAGE.breakAfter),
      [STORAGE.breakReset]: localStorage.getItem(STORAGE.breakReset),
      [STORAGE.hue]: localStorage.getItem(STORAGE.hue),
    })
  );
  const [petState, setPetState] = useState<PetState>("awake");
  const [focusMs, setFocusMs] = useState(0);
  const [breakDue, setBreakDue] = useState(false);
  const [dismissedAt, setDismissedAt] = useState(0);

  /** Wall-clock estimate of the last input, rebuilt from each backend report. */
  const lastInputAt = useRef<number>(Date.now());
  const wasAsleep = useRef(false);
  const waveTimer = useRef<number | null>(null);
  /** Live copy of the settings for callbacks that outlive a render. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Load once, then track edits from either the settings window or the file watcher.
  useEffect(() => {
    let alive = true;
    invoke<Record<string, unknown>>("load_settings")
      .then((raw) => {
        if (alive) setSettings(readSettings(raw));
      })
      .catch(() => {});

    const apply = (key: string, value: unknown) => {
      if (!Object.values(STORAGE).includes(key)) return;
      setSettings((prev) => readSettings({ ...prev, [key]: value }));
    };

    const subs = [
      listen<{ key: string; value: unknown }>("settings-changed", (e) => apply(e.payload.key, e.payload.value)),
      listen<{ key: string; value: unknown }>("settings-external-changed", (e) =>
        apply(e.payload.key, e.payload.value)
      ),
    ];
    return () => {
      alive = false;
      subs.forEach((s) => s.then((f) => f()));
    };
  }, []);

  // The activity signal.
  useEffect(() => {
    let alive = true;
    invoke<UserState>("get_user_state")
      .then((s) => {
        if (alive) lastInputAt.current = Date.now() - s.idle_ms;
      })
      .catch(() => {});

    const unlisten = listen<UserState>("user-state", (e) => {
      const { idle_ms, focus_ms, active } = e.payload;
      lastInputAt.current = Date.now() - idle_ms;
      setFocusMs(focus_ms);

      if (!active && !wasAsleep.current) {
        wasAsleep.current = true;
      } else if (active && wasAsleep.current) {
        // Coming back to the machine: the pet wakes and waves.
        wasAsleep.current = false;
        setBreakDue(false);
        setPetState("waving");
        if (waveTimer.current) clearTimeout(waveTimer.current);
        waveTimer.current = window.setTimeout(() => setPetState("awake"), 2200);
      }
    });

    return () => {
      alive = false;
      unlisten.then((f) => f());
      if (waveTimer.current) clearTimeout(waveTimer.current);
    };
  }, []);

  // Ramp sleepy -> dozing -> asleep between backend reports.
  useEffect(() => {
    const tick = () => {
      const { enabled, sleepAfterSec } = settingsRef.current;
      if (!enabled) return;
      const idle = Date.now() - lastInputAt.current;
      const sleepMs = sleepAfterSec * 1000;

      setPetState((prev) => {
        if (prev === "waving") return prev; // let the wave finish
        if (idle >= sleepMs) {
          wasAsleep.current = true;
          return "asleep";
        }
        if (idle >= sleepMs * 0.55) return "dozing";
        return "awake";
      });
    };
    const id = window.setInterval(tick, 1000);
    tick();
    return () => clearInterval(id);
  }, [settings.enabled]);

  // The break nudge. focus_ms only grows while the backend sees activity and resets
  // itself after a long enough pause, so reaching the threshold already means you
  // are still going.
  useEffect(() => {
    const { breakAfterMin, enabled } = settings;
    if (!enabled || breakAfterMin <= 0) {
      setBreakDue(false);
      return;
    }
    if (focusMs >= breakAfterMin * 60_000 && !muted) {
      setBreakDue(true);
      setPetState("alert");
    }
  }, [focusMs, muted, settings]);

  // Stepping away for at least the reset period counts as having taken the break.
  // This needs its own timer: the pet state stops changing once it is asleep, so
  // keying off renders alone would leave the nudge up forever.
  useEffect(() => {
    if (!breakDue) return;
    const id = window.setInterval(() => {
      if (Date.now() - lastInputAt.current >= settings.breakResetSec * 1000) {
        setBreakDue(false);
        setFocusMs(0);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [breakDue, settings.breakResetSec]);

  const dismissBreak = useCallback(() => {
    setBreakDue(false);
    setFocusMs(0);
    setDismissedAt(Date.now());
    setPetState("awake");
    lastInputAt.current = Date.now();
  }, []);

  /** Clicking the pet: it waves back, and shows how long the current run is. */
  const poke = useCallback(() => {
    setPetState("waving");
    if (waveTimer.current) clearTimeout(waveTimer.current);
    waveTimer.current = window.setTimeout(() => setPetState("awake"), 2200);
  }, []);

  return {
    state: petState,
    enabled: settings.enabled,
    hue: settings.hue,
    focusMs,
    breakDue,
    dismissedAt,
    settings,
    dismissBreak,
    poke,
  };
}
