import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";

/**
 * The little nectar drop that lives on the notch.
 *
 * It sleeps while the machine is quiet and wakes up waving when you come back, so
 * the notch tells you at a glance whether anyone has been at this keyboard. The art
 * is all vector and every part moves on its own, so there is nothing to load and
 * nothing to decode: two eyes, a body, two arms, and the dream letters.
 *
 * Sizes are in the component's own coordinate space (30x26) and scale to `size`.
 */

export type PetState = "asleep" | "dozing" | "waking" | "awake" | "waving" | "alert";

interface NotchPetProps {
  state: PetState;
  /** Rendered width in px. Height follows the 30:26 aspect ratio. */
  size?: number;
  /** Body colour, so the pet can pick up the theme instead of fighting it. */
  hue?: string;
  onPoke?: () => void;
}

const W = 30;
const H = 26;

/** Eyes are shut in these states, half open in dozing, wide open otherwise. */
const CLOSED: PetState[] = ["asleep"];
const DROOPY: PetState[] = ["dozing"];

/** Slow, deep squash while asleep; quick little bounce when awake. */
const BREATH: Record<PetState, { duration: number; amount: number }> = {
  asleep: { duration: 2.6, amount: 0.045 },
  dozing: { duration: 1.8, amount: 0.03 },
  waking: { duration: 0.5, amount: 0.07 },
  awake: { duration: 2.0, amount: 0.025 },
  waving: { duration: 0.55, amount: 0.05 },
  alert: { duration: 0.4, amount: 0.08 },
};

export default function NotchPet({ state, size = 30, hue = "#f6c453", onPoke }: NotchPetProps) {
  const eyesClosed = CLOSED.includes(state);
  const eyesDroopy = DROOPY.includes(state);
  const dreaming = state === "asleep" || state === "dozing";
  const armsUp = state === "waving" || state === "alert" || state === "waking";

  // A blink at an irregular interval, but never while the eyes are already shut.
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    if (eyesClosed) return;
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setBlinking(true);
        window.setTimeout(() => {
          setBlinking(false);
          schedule();
        }, 130);
      }, 2200 + Math.random() * 4200);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [eyesClosed]);

  const breath = BREATH[state];
  const eyeScaleY = eyesClosed || blinking ? 0.08 : eyesDroopy ? 0.45 : 1;

  // Three dream letters, each with its own delay. They start past the right edge of
  // the body and drift further right, so they always travel over the dark notch
  // rather than over the pet, which would make them vanish on a light body colour.
  const zzz = useMemo(
    () => [
      { key: "z0", delay: 0, x: 27, y: 12, size: 7 },
      { key: "z1", delay: 0.9, x: 31, y: 9, size: 8.5 },
      { key: "z2", delay: 1.8, x: 35, y: 6, size: 10 },
    ],
    []
  );

  return (
    <motion.div
      className="notch-pet"
      style={{ width: size, height: (size * H) / W, position: "relative", cursor: onPoke ? "pointer" : "default" }}
      onClick={(e) => {
        e.stopPropagation();
        onPoke?.();
      }}
      whileHover={{ scale: 1.12 }}
      transition={{ type: "spring", stiffness: 500, damping: 24 }}
      data-pet-state={state}
    >
      <motion.svg
        viewBox={`-4 -6 ${W + 8} ${H + 8}`}
        width={size}
        height={(size * H) / W}
        style={{ overflow: "visible", display: "block" }}
        animate={{ scaleY: [1, 1 - breath.amount, 1], y: [0, breath.amount * 6, 0] }}
        transition={{
          duration: breath.duration,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        <defs>
          <linearGradient id="nectar-pet-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={hue} stopOpacity="0.95" />
            <stop offset="100%" stopColor={hue} stopOpacity="0.55" />
          </linearGradient>
        </defs>

        {/* Arms. Shoulders sit at the sides of the body so the wave pivots from there. */}
        <motion.g
          style={{ originX: 4.5 / W, originY: 17 / H }}
          animate={{ rotate: armsUp ? [8, -46, 8] : [0, -6, 0] }}
          transition={{
            duration: state === "alert" ? 0.32 : state === "waving" ? 0.5 : 2.2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        >
          <path
            d="M5 16 C2.4 16.6 1.2 19 1.6 21.4"
            stroke={hue}
            strokeWidth="2.6"
            strokeLinecap="round"
            fill="none"
            opacity="0.95"
          />
        </motion.g>
        <motion.g
          style={{ originX: 25.5 / W, originY: 17 / H }}
          animate={{ rotate: armsUp ? [-8, 46, -8] : [0, 6, 0] }}
          transition={{
            duration: state === "alert" ? 0.32 : state === "waving" ? 0.5 : 2.2,
            repeat: Infinity,
            ease: "easeInOut",
            delay: state === "waving" ? 0.12 : 0,
          }}
        >
          <path
            d="M25 16 C27.6 16.6 28.8 19 28.4 21.4"
            stroke={hue}
            strokeWidth="2.6"
            strokeLinecap="round"
            fill="none"
            opacity="0.95"
          />
        </motion.g>

        {/* Body: a drop with a soft point at the top where it clings to the edge. */}
        <path
          d="M15 0.5 C22.5 4.5 26.5 9.5 26.5 15 C26.5 20.5 21.3 25 15 25 C8.7 25 3.5 20.5 3.5 15 C3.5 9.5 7.5 4.5 15 0.5 Z"
          fill="url(#nectar-pet-body)"
        />
        {/* Highlight, so it reads as wet nectar rather than a flat sticker. */}
        <ellipse cx="10.5" cy="9" rx="3.4" ry="2.2" fill="#fff" opacity="0.28" transform="rotate(-24 10.5 9)" />

        {/* Eyes */}
        <motion.g animate={{ scaleY: eyeScaleY }} style={{ originY: 0.5 }} transition={{ type: "spring", stiffness: 700, damping: 26 }}>
          <ellipse cx="10.6" cy="13.6" rx="2.1" ry="2.6" fill="#0b0b0d" />
          <ellipse cx="19.4" cy="13.6" rx="2.1" ry="2.6" fill="#0b0b0d" />
          {!eyesClosed && <circle cx="11.3" cy="12.6" r="0.72" fill="#fff" opacity="0.9" />}
          {!eyesClosed && <circle cx="20.1" cy="12.6" r="0.72" fill="#fff" opacity="0.9" />}
        </motion.g>

        {/* Mouth: a small open O when asleep, a flat content line otherwise. */}
        <AnimatePresence mode="wait" initial={false}>
          {eyesClosed ? (
            <motion.ellipse
              key="mouth-open"
              cx="15"
              cy="19"
              rx="1.5"
              ry="1.9"
              fill="#0b0b0d"
              opacity="0.75"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.75, ry: [1.4, 2.1, 1.4] }}
              exit={{ opacity: 0 }}
              transition={{ duration: breath.duration, repeat: Infinity, ease: "easeInOut" }}
            />
          ) : (
            <motion.path
              key="mouth-smile"
              d="M12.4 19 Q15 21.2 17.6 19"
              stroke="#0b0b0d"
              strokeWidth="1.3"
              strokeLinecap="round"
              fill="none"
              opacity="0.7"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.7 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            />
          )}
        </AnimatePresence>
      </motion.svg>

      {/* Dream letters. They rise along the notch face, since the screen edge is above. */}
      <AnimatePresence>
        {dreaming &&
          zzz.map((z, i) => (
            <motion.span
              key={z.key}
              className="notch-pet-z"
              initial={{ opacity: 0, x: z.x, y: z.y + 6, scale: 0.5 }}
              animate={{
                opacity: [0, 0.95, 0],
                x: [z.x, z.x + 4, z.x + 7],
                y: [z.y + 6, z.y + 1, z.y - 4],
                scale: [0.5, 1, 1.15],
              }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{
                duration: 2.7,
                repeat: Infinity,
                delay: z.delay,
                ease: "easeOut",
              }}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                fontSize: (z.size * size) / W,
                fontWeight: 700,
                color: "#c9d2ff",
                lineHeight: 1,
                pointerEvents: "none",
                fontStyle: i === 2 ? "italic" : "normal",
              }}
            >
              z
            </motion.span>
          ))}
      </AnimatePresence>
    </motion.div>
  );
}
