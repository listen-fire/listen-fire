"use client";

import type { StoryViewSystem } from "./view";

/**
 * A system's brand mark, drawn from the path the SERVER sent.
 *
 * Deliberately not the app's own `ServiceIcon`: that keeps a local table
 * keyed by service slug, so using it here would put a copy of every system's
 * identity back inside the renderer. The story page knows only what the
 * system declared about itself.
 */
export function BrandMark({
  system,
  size = 14,
}: {
  system: StoryViewSystem | null;
  size?: number;
}) {
  if (!system?.icon) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className="inline-block shrink-0 rounded-[3px] bg-gray-200"
      />
    );
  }
  const { d, fill, viewBox } = system.icon;
  return (
    <svg
      role="img"
      aria-label={system.label}
      width={size}
      height={size}
      viewBox={viewBox ?? "0 0 24 24"}
      className="shrink-0"
      {...(fill === false
        ? {
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 2,
            strokeLinecap: "round" as const,
            strokeLinejoin: "round" as const,
          }
        : { fill: "currentColor" })}
    >
      <path d={d} />
    </svg>
  );
}
