import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { clipAge, clipPreview, type ClipEntry } from "../hooks/useClipboard";

/**
 * Clipboard history panel, shown in the notch.
 *
 * Click a row to put that text back on the clipboard (it does not paste for you, so
 * nothing can land in the wrong field). The x appears on hover for dropping a single
 * entry, and the header count clears everything.
 */

interface NotchClipboardProps {
  items: ClipEntry[];
  onRestore: (index: number) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}

const MAX_VISIBLE = 4;

export default function NotchClipboard({ items, onRestore, onRemove, onClear }: NotchClipboardProps) {
  // Keeps the "3m" labels honest without re-rendering on every parent change.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 20000);
    return () => clearInterval(id);
  }, []);

  if (items.length === 0) {
    return (
      <div style={emptyStyle}>
        <span style={{ opacity: 0.75 }}>Nothing copied yet</span>
        <span style={{ opacity: 0.45, fontSize: 10 }}>Copy something and it lands here</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
      <div style={headerStyle}>
        <span style={{ fontSize: 10, letterSpacing: 0.6, opacity: 0.55, textTransform: "uppercase" }}>
          Clipboard
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          style={clearButtonStyle}
          title="Clear history"
        >
          Clear
        </button>
      </div>

      <div style={{ overflowY: "auto", maxHeight: 118, paddingRight: 2 }}>
        <AnimatePresence initial={false}>
          {items.slice(0, MAX_VISIBLE + 2).map((item, i) => (
            <motion.div
              key={`${item.copied_at}-${i}`}
              layout
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.14 }}
              className="clip-row"
              onClick={(e) => {
                e.stopPropagation();
                onRestore(i);
              }}
              style={rowStyle}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={previewStyle}>{clipPreview(item.text)}</div>
                <div style={metaStyle}>
                  {item.source ? <span>{item.source}</span> : null}
                  <span>{clipAge(item.copied_at, now)}</span>
                </div>
              </div>
              <button
                type="button"
                className="clip-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(i);
                }}
                style={removeStyle}
                title="Forget this"
              >
                ×
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  height: "100%",
  width: "100%",
  fontSize: 11,
  color: "var(--nectar-text, white)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "2px 2px 5px",
  color: "var(--nectar-text, white)",
};

const clearButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--nectar-text, white)",
  opacity: 0.5,
  fontSize: 10,
  cursor: "pointer",
  padding: 0,
  fontFamily: "inherit",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 7px",
  borderRadius: 9,
  cursor: "pointer",
  color: "var(--nectar-text, white)",
};

const previewStyle: React.CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.25,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const metaStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  fontSize: 9.5,
  opacity: 0.45,
  marginTop: 1,
};

const removeStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--nectar-text, white)",
  fontSize: 14,
  lineHeight: 1,
  cursor: "pointer",
  opacity: 0,
  padding: "0 2px",
};
