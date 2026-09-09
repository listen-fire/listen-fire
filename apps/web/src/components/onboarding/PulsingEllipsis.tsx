"use client";

/**
 * The page's one motif: a text caret and three pulsing dots. It opens the
 * onboarding (before the first card wipes in) and reappears, small and inline,
 * wherever we're making the user wait — so waiting always looks the same.
 */

import styles from "./onboarding-motion.module.css";

export function PulsingEllipsis({ size = "lg" }: { size?: "lg" | "sm" }) {
  const large = size === "lg";
  const caret = large ? "h-7" : "h-3.5";
  const dot = large ? "h-2 w-2" : "h-1 w-1";

  return (
    <span
      className={`inline-flex items-center ${large ? "gap-2.5" : "gap-1.5"}`}
      data-testid="pulsing-ellipsis"
      aria-hidden
    >
      <span className={`${styles.caret} ${caret}`} />
      <span className={`inline-flex items-center ${large ? "gap-1.5" : "gap-1"}`}>
        <span className={`${styles.dot} ${dot}`} />
        <span className={`${styles.dot} ${dot}`} />
        <span className={`${styles.dot} ${dot}`} />
      </span>
    </span>
  );
}
