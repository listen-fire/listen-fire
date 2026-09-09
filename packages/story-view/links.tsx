"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";

import { middleOf, useSurface } from "./pannable-surface";

/**
 * The one relationship on the board that is NOT top-to-bottom: a step in this
 * column runs the movement in that one.
 *
 * The board's whole grammar is "down means then", and a column stands on its
 * own because nothing in the file connects it to its neighbour. A call breaks
 * that: it is a real edge between two columns, and until it was drawn the only
 * thing saying so was two matching words in two different sentences.
 *
 * It is drawn as a LINK rather than as a line. A line across the board would
 * have to be measured off the DOM — the one thing this canvas has refused to do
 * (see `FlowCanvas`), because every lane and every fan is placed by
 * construction — and it would cross columns that have nothing to do with it.
 * A link says the same thing in the reader's own idiom: the callee's name is a
 * chip on the call, the callers' names are chips on the helper, pointing at one
 * lights up the other wherever it is on the board, and clicking it takes you
 * there.
 *
 * Both directions are ONE piece of state — the movement being pointed at — so
 * hovering the helper's "used by" chip lights the call site and hovering the
 * call lights the helper, without either side knowing about the other.
 *
 */

interface LinksData {
  /** The movement currently being pointed at, from either end. */
  pointed: string | null;
  point: (name: string | null) => void;
  /** Where each column is, so a click can take the board to it. */
  columns: Map<string, HTMLElement>;
}

const Links = createContext<LinksData | null>(null);

export function LinksProvider({ children }: { children: React.ReactNode }) {
  const [pointed, setPointed] = useState<string | null>(null);
  const columns = useRef(new Map<string, HTMLElement>()).current;
  const value = useMemo<LinksData>(
    () => ({ pointed, point: setPointed, columns }),
    [pointed, columns],
  );
  return <Links.Provider value={value}>{children}</Links.Provider>;
}

/**
 * A column, as somewhere a link can point. Returns the ref to hang on it and
 * whether it is the one being pointed at right now.
 */
export function useColumnLink(name: string | undefined): {
  ref: (element: HTMLElement | null) => void;
  pointed: boolean;
} {
  const links = useContext(Links);
  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (!links || name === undefined) return;
      if (element) links.columns.set(name, element);
      else links.columns.delete(name);
    },
    [links, name],
  );
  return { ref, pointed: name !== undefined && links?.pointed === name };
}

/**
 * One movement's name, as a link to its column.
 *
 * `known` is the honesty valve: a call naming something this file never
 * declares has nowhere to go, so it reads as plain text and does not offer to
 * take anyone anywhere.
 */
export function MovementLink({ name, known = true }: { name: string; known?: boolean }) {
  const links = useContext(Links);
  const surface = useSurface();
  const lit = links?.pointed === name;

  // "Take me to it" means the MIDDLE of the pane, the same place the board
  // opens on — the gutters are what make that reachable for the columns at
  // either end. Only the horizontal axis moves: how far down the story you
  // were reading is yours, not the link's.
  const go = useCallback(() => {
    const board = surface?.current;
    const column = links?.columns.get(name);
    if (!board || !column) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    board.scrollTo({ left: middleOf(board, column), behavior: still ? "auto" : "smooth" });
  }, [links, name, surface]);

  if (!known || !links) {
    return <span className="font-medium text-gray-600">{name}</span>;
  }

  return (
    <button
      type="button"
      title="Take me to it"
      onClick={go}
      onPointerEnter={() => links.point(name)}
      onPointerLeave={() => links.point(null)}
      onFocus={() => links.point(name)}
      onBlur={() => links.point(null)}
      className={`mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded-md border px-1.5 py-[1px] align-middle text-[11.5px] leading-[18px] transition-colors [overflow-wrap:anywhere] ${
        lit
          ? "border-primary-400 bg-primary-100 text-primary-800"
          : "border-primary-200 bg-primary-50 text-primary-700 hover:bg-primary-100"
      }`}
    >
      <ArrowRight size={11} className="shrink-0 translate-y-[1px] opacity-70" aria-hidden />
      <span className="min-w-0">{name}</span>
    </button>
  );
}

/** What a column looks like while a link points at it. */
export function pointedStyle(pointed: boolean): string {
  return pointed ? "bg-primary-50 ring-1 ring-primary-300" : "ring-1 ring-transparent";
}
