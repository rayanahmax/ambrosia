import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PawPrint, Moon, Coffee, TimerReset, Palette, ClipboardList, Eraser, Hourglass } from "lucide-react";
import { SettingRow } from "./SettingRow";
import { Dropdown } from "./Dropdown";
import { saveSetting } from "./useSettings";

/**
 * Settings for the notch pet, its break nudge, and clipboard history.
 *
 * This tab owns its keys outright rather than routing them through useSettings, which
 * is already carrying the whole app's state. Values are written the same way as
 * everywhere else: localStorage for the instant render, `save_setting` for the file and
 * the live watcher.
 */

const KEYS = {
  petEnabled: "nectar-pet-enabled",
  sleepAfter: "nectar-pet-sleep-after",
  breakAfter: "nectar-pet-break-after-min",
  activityReset: "nectar-activity-reset-after",
  hue: "nectar-pet-hue",
  clipEnabled: "nectar-clipboard-enabled",
  clipSize: "nectar-clipboard-history-size",
};

const DEFAULTS: Record<string, string> = {
  [KEYS.petEnabled]: "true",
  [KEYS.sleepAfter]: "90",
  [KEYS.breakAfter]: "45",
  [KEYS.activityReset]: "240",
  [KEYS.hue]: "#f6c453",
  [KEYS.clipEnabled]: "false",
  [KEYS.clipSize]: "15",
};

type Values = Record<string, string>;

const secs = (n: number, label: string) => ({ value: String(n), label });
const mins = (n: number, label?: string) => ({ value: String(n), label: label ?? `${n} min` });

export function PetTab() {
  const [values, setValues] = useState<Values>(() => {
    const initial: Values = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      initial[key] = localStorage.getItem(key) ?? fallback;
    }
    return initial;
  });

  // Pick up edits made in the other window, or by hand in settings.json.
  useEffect(() => {
    invoke<Record<string, unknown>>("load_settings")
      .then((raw) => {
        setValues((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(DEFAULTS)) {
            if (raw[key] !== undefined && raw[key] !== null) next[key] = String(raw[key]);
          }
          return next;
        });
      })
      .catch(() => {});
  }, []);

  const set = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    saveSetting(key, value);
  };

  const petOn = values[KEYS.petEnabled] !== "false";
  const clipOn = values[KEYS.clipEnabled] === "true";

  return (
    <>
      <div className="setting-group-label">Pet</div>
      <div className="setting-group">
        <SettingRow icon={PawPrint} label="Notch pet" desc="A little drop that lives on the notch">
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={petOn}
              onChange={(e) => set(KEYS.petEnabled, String(e.target.checked))}
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {petOn && (
          <>
            <SettingRow icon={Moon} label="Fall asleep after" desc="Quiet time before the pet dozes off">
              <Dropdown
                value={values[KEYS.sleepAfter]}
                onChange={(v) => set(KEYS.sleepAfter, v)}
                options={[
                  secs(30, "30 sec"),
                  secs(60, "1 min"),
                  secs(90, "1.5 min"),
                  secs(180, "3 min"),
                  secs(300, "5 min"),
                  secs(600, "10 min"),
                ]}
              />
            </SettingRow>

            <SettingRow icon={Coffee} label="Break nudge after" desc="Waves when you have been going a while">
              <Dropdown
                value={values[KEYS.breakAfter]}
                onChange={(v) => set(KEYS.breakAfter, v)}
                options={[mins(0, "Off"), mins(30), mins(45), mins(60), mins(90), mins(120)]}
              />
            </SettingRow>

            {values[KEYS.breakAfter] !== "0" && (
              <SettingRow
                icon={TimerReset}
                label="Break counts as taken after"
                desc="How long a pause has to be to reset the timer"
                divider={false}
              >
                <Dropdown
                  value={values[KEYS.activityReset]}
                  onChange={(v) => set(KEYS.activityReset, v)}
                  options={[secs(120, "2 min"), secs(240, "4 min"), secs(420, "7 min"), secs(600, "10 min")]}
                />
              </SettingRow>
            )}

            <SettingRow icon={Palette} label="Pet colour" desc="Body colour of the drop" divider={false}>
              <input
                type="color"
                value={values[KEYS.hue]}
                onChange={(e) => set(KEYS.hue, e.target.value)}
                className="pet-colour-input"
                aria-label="Pet colour"
              />
            </SettingRow>
          </>
        )}
      </div>

      <div className="setting-group-label">Clipboard</div>
      <div className="setting-group">
        <SettingRow
          icon={ClipboardList}
          label="Clipboard history"
          desc="Swipe to the clipboard panel to reuse an earlier copy"
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={clipOn}
              onChange={(e) => set(KEYS.clipEnabled, String(e.target.checked))}
            />
            <span className="slider"></span>
          </label>
        </SettingRow>

        {clipOn && (
          <>
            <SettingRow icon={Hourglass} label="Keep the last" desc="Copies held in memory">
              <Dropdown
                value={values[KEYS.clipSize]}
                onChange={(v) => set(KEYS.clipSize, v)}
                options={[
                  { value: "5", label: "5 entries" },
                  { value: "10", label: "10 entries" },
                  { value: "15", label: "15 entries" },
                  { value: "25", label: "25 entries" },
                ]}
              />
            </SettingRow>
            <SettingRow
              icon={Eraser}
              label="Clear history now"
              desc="Drops everything already captured"
              action
              divider={false}
              onClick={() => {
                invoke("clipboard_clear").catch(() => {});
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
