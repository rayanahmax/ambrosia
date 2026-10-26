import { motion } from "framer-motion";

/**
 * The Focus panel: how long you have been going without a proper pause, and when the
 * next one is due.
 *
 * This is what makes the pet more than decoration. It sleeps when you walk away and
 * starts waving once you have been at the keyboard long enough that you probably
 * should not still be.
 */

interface NotchFocusProps {
  /** Unbroken activity in milliseconds. */
  focusMs: number;
  breakDue: boolean;
  /** Minutes of work that trigger the nudge. */
  breakAfterMin: number;
  hue: string;
  onDone: () => void;
}

function minutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

export default function NotchFocus({ focusMs, breakDue, breakAfterMin, hue, onDone }: NotchFocusProps) {
  const mins = minutes(focusMs);
  const progress = breakAfterMin > 0 ? Math.min(1, focusMs / (breakAfterMin * 60_000)) : 0;
  const untilBreak = Math.max(0, breakAfterMin - mins);

  return (
    <div style={wrapStyle}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
        <span style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, color: breakDue ? hue : "inherit" }}>
          {mins}
        </span>
        <span style={{ fontSize: 11, opacity: 0.55, marginBottom: 2 }}>min at the keyboard</span>
      </div>

      <div style={trackStyle}>
        <motion.div
          style={{ ...fillStyle, background: breakDue ? hue : "rgba(255,255,255,0.72)" }}
          animate={{ width: `${progress * 100}%` }}
          transition={{ type: "spring", stiffness: 180, damping: 26 }}
        />
      </div>

      {breakDue ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 11, color: hue }}>Stand up, look at something far away</span>
          <button type="button" onClick={(e) => { e.stopPropagation(); onDone(); }} style={buttonStyle}>
            Done
          </button>
        </div>
      ) : (
        <span style={{ fontSize: 10.5, opacity: 0.5 }}>
          {breakAfterMin <= 0
            ? "Break nudges are off"
            : untilBreak <= 1
              ? "Break due in under a minute"
              : `Next break in about ${untilBreak} min`}
        </span>
      )}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  width: "100%",
  height: "100%",
  justifyContent: "center",
  padding: "0 4px",
  boxSizing: "border-box",
  color: "var(--nectar-text, white)",
};

const trackStyle: React.CSSProperties = {
  height: 3,
  borderRadius: 3,
  background: "rgba(255,255,255,0.14)",
  overflow: "hidden",
};

const fillStyle: React.CSSProperties = {
  height: "100%",
  borderRadius: 3,
};

const buttonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.12)",
  border: "none",
  borderRadius: 8,
  color: "var(--nectar-text, white)",
  fontSize: 11,
  padding: "3px 10px",
  cursor: "pointer",
  fontFamily: "inherit",
};
