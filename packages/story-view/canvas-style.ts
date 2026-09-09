/**
 * The canvas's shared surface language, in one place so it cannot drift.
 *
 * ONE radius across every box the canvas draws — a card, a frame, a lane label,
 * a chip. Boxes at three different radii read as three different kinds of
 * thing, which is a distinction the picture never means to make.
 *
 * `LIFT` is the other half, and it is now on EVERY box the canvas draws —
 * dashed frames included. The grid runs behind all of them, so the whole
 * picture reads as objects laid on a surface; lifting only some of them read as
 * two classes of thing, which is a distinction the picture never meant either.
 * Connectors and bare captions stay flat — they are the surface, not things on
 * it.
 *
 */

export const BOX = "rounded-md";

export const LIFT =
  "shadow-[0_1px_2px_rgba(16,24,40,0.10),0_4px_10px_rgba(16,24,40,0.08)]";

/**
 * The canvas surface itself: the engineering grid from the marketing homepage,
 * reused rather than approximated — same base tint, same line colour, same
 * 46px pitch (`apps/marketing/src/components/marketing/LandingBackground.tsx`).
 *
 * The grid's POSITION is driven at runtime (see `pannable-surface`): it trails
 * the board it sits under, so the surface has depth without ever competing with
 * what is on it.
 *
 * Its PITCH does not zoom. The grid is the desk, not the paper: it already
 * refuses to travel with the board, and a grid that scaled with the zoom would
 * be claiming the opposite — that it is part of the picture — while also
 * dissolving into noise on the way out. Screen-fixed, it stays the thing the
 * board is being moved across, and the zoom reads as the board getting smaller
 * rather than as the whole world receding.
 */
export const GRID_BACKGROUND = {
  backgroundColor: "white",
  backgroundImage:
    "linear-gradient(to right, rgba(15,23,42,0.035) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,0.035) 1px, transparent 1px)",
  backgroundSize: "46px 46px",
} as const;

/** The grid's pitch, in px — the modulus every parallax offset is folded into,
 *  so the numbers written to `background-position` stay small however far the
 *  board has travelled. */
export const GRID_PITCH = 46;

/** How much of a scroll the grid takes. Below 1 it trails what sits on it,
 *  which is the whole effect; at 1 it would be glued to the board again. */
export const PARALLAX = 0.5;
