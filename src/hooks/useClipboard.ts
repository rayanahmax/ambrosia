import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

/**
 * Clipboard history for the notch.
 *
 * The Rust watchdog owns the actual capture (see src-tauri/src/clipboard.rs); this is
 * just a live view of its in-memory list. Nothing here touches disk, and the whole
 * feature stays off until `nectar-clipboard-enabled` is turned on, because a clipboard
 * log is a list of everything you copied, passwords included.
 */

export interface ClipEntry {
  text: string;
  /** Milliseconds since the unix epoch. */
  copied_at: number;
  source: string | null;
}

const KEY_ENABLED = "nectar-clipboard-enabled";

function boolOf(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fallback;
}

export function useClipboard() {
  const [enabled, setEnabled] = useState(() => boolOf(localStorage.getItem(KEY_ENABLED), false));
  const [items, setItems] = useState<ClipEntry[]>([]);

  useEffect(() => {
    let alive = true;
    invoke<Record<string, unknown>>("load_settings")
      .then((raw) => {
        if (alive) setEnabled(boolOf(raw[KEY_ENABLED], false));
      })
      .catch(() => {});

    const apply = (key: string, value: unknown) => {
      if (key === KEY_ENABLED) setEnabled(boolOf(value, false));
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

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    invoke<ClipEntry[]>("get_clipboard_history").then(setItems).catch(() => {});
    const unlisten = listen<ClipEntry[]>("clipboard-history", (e) => setItems(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, [enabled]);

  /** Put an entry back on the clipboard so the user can paste it. */
  const restore = useCallback(async (index: number) => {
    await invoke("clipboard_restore", { index });
  }, []);

  const remove = useCallback(async (index: number) => {
    const next = await invoke<ClipEntry[]>("clipboard_delete", { index });
    setItems(next);
  }, []);

  const clear = useCallback(async () => {
    const next = await invoke<ClipEntry[]>("clipboard_clear");
    setItems(next);
  }, []);

  return { enabled, items, restore, remove, clear };
}

/** Compact "3m ago" style label. */
export function clipAge(copiedAt: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - copiedAt) / 1000));
  if (secs < 45) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** One-line preview with the newlines a copied block usually has folded away. */
export function clipPreview(text: string, max = 60): string {
  const flat = text.replace(/\s*\n\s*/g, "  ·  ").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
