"use client";

/**
 * ServicePickerBox — a square, brand-coloured service tile with the
 * cursor-tracking effect lifted from the old /cards route: 3D tilt, a faint
 * brand-tinted background, a proximity reveal of the tiled service icon, and a
 * moving foil sheen. All the motion is CSS (ServicePickerBox.module.css) driven
 * by `--x`/`--y` cursor variables this component writes on mousemove.
 *
 */

import { useRef, type CSSProperties, type MouseEvent } from "react";
import { Check } from "lucide-react";

import { ServiceIcon, getServiceIconPath } from "@/components/service-icon";

import type { PickerService } from "./services";
import styles from "./ServicePickerBox.module.css";

/** Build a repeating icon mask: the service mark on a padded viewBox so the
 *  tiled repeats sit apart. */
function iconTileMask(key: string): string {
  const path = getServiceIconPath(key);
  if (!path) return "none";
  const [minX, minY, w, h] = path.viewBox.split(/\s+/).map(Number);
  const pad = 0.75;
  const padded = [minX - w * pad, minY - h * pad, w * (1 + 2 * pad), h * (1 + 2 * pad)].join(" ");
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${padded}'>` +
    `<path fill='black' fill-rule='evenodd' d='${path.d}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function ServicePickerBox({
  service,
  selected,
  disabled = false,
  onToggle,
}: {
  service: PickerService;
  selected: boolean;
  /** Set on unpicked tiles once the pick limit is reached. */
  disabled?: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  const track = (e: MouseEvent<HTMLButtonElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--x", (e.clientX - rect.left).toFixed(1));
    el.style.setProperty("--y", (e.clientY - rect.top).toFixed(1));
    el.style.setProperty("--w", rect.width.toFixed(1));
    el.style.setProperty("--h", rect.height.toFixed(1));
  };

  const recenter = () => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--x", (rect.width / 2).toFixed(1));
    el.style.setProperty("--y", (rect.height / 2).toFixed(1));
  };

  const style = {
    "--brand": service.brand,
    "--bg": service.brandBg ?? service.brand,
    "--icon-tile": iconTileMask(service.key),
  } as CSSProperties;

  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onToggle}
      onMouseMove={track}
      onMouseLeave={recenter}
      style={style}
      className={selected ? `${styles.box} ${styles.selected}` : styles.box}
      data-testid="service-picker"
      data-service={service.key}
    >
      <span className={styles.holo} aria-hidden />
      <span className={styles.sheen} aria-hidden />
      <Check className={styles.tick} strokeWidth={3} aria-hidden />
      <ServiceIcon type={service.key} className={styles.logo} />
      <span className={styles.name}>{service.label}</span>
    </button>
  );
}
