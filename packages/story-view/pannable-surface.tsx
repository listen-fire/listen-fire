"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Minus, Plus } from "lucide-react";

import { BOX, GRID_BACKGROUND, GRID_PITCH, PARALLAX } from "./canvas-style";

/**
 * The canvas is a BOARD you move across, not a page you scroll down.
 *
 * The board is ONE scroller, on both axes. It fills the pane it is given and
 * scrolls inside itself, so a trackpad gesture over it moves one thing in one
 * direction instead of splitting across nested scrollers — which is what made
 * a diagonal swipe feel like two arguing surfaces. Dragging the empty canvas
 * pushes it the way you would push a sheet of paper, both axes at once.
 *
 * It also feels ENDLESS: half a pane of empty canvas surrounds the board on all
 * four sides, so the scroll range runs past the content and ANY part of the
 * story can be pulled to the middle of the screen — which is where you read it.
 * Exactly half is not a taste: it is the smallest gutter that lets the far edge
 * of the board reach the centre, and the largest that never lets the board
 * leave the pane entirely.
 *
 * What pans and what doesn't is decided STRUCTURALLY, and at the granularity of
 * the THING rather than of the region around it: each readable thing marks
 * ITSELF (`readable`), and a drag that starts on one is a read — select the
 * text, click the card. Everything else is canvas, including the space between
 * two cards on a spine and the inside of a frame. Nothing here enumerates the
 * kinds of things a card can contain, so it stays true as cards grow
 * interactions of their own.
 *
 * The grid TRAILS the board rather than being glued to it: it takes a fraction
 * of every movement, on both axes, so the surface sits behind the cards instead
 * of alongside them. One continuous grid spans the whole pannable width rather
 * than a patch under each column.
 *
 * It also ZOOMS, around whatever the cursor is over — or, on a touchscreen,
 * around the midpoint of two fingers. Zoom is one CSS transform on the whole
 * board, so the picture scales as ONE thing — cards, fans, the grid-relative
 * layout — and every by-construction centre in the canvas stays a centre. Pan
 * is still native scroll underneath it, which is why the two compose: scaling
 * changes how big the board is, not how it is moved across.
 *
 */
export function PannableSurface({ children }: { children: React.ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // Every finger on the surface, whatever it is doing — the one list both
  // gestures are read off, so "a second finger landed" is a fact rather than a
  // guess, and no second tracking system can disagree with this one.
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<Pinch | null>(null);
  const [panning, setPanning] = useState(false);
  const [gutter, setGutter] = useState<Point>({ x: 0, y: 0 });
  const { scale, reach, zoomBy, reset, grip, zoomTo } = useZoom({ surface, board, gutter });

  // The gutter is HALF THE PANE, so it is remeasured whenever the pane
  // resizes and never otherwise — it does not depend on the board at all.
  // (A percentage padding would have been width-relative on all four sides,
  // which is not what "half a pane tall" means.)
  //
  // It is SCREEN room, not board room, so it does not scale: half a pane is
  // half a pane at any zoom, and it is exactly what makes the scroll range end
  // where the board's far edge reaches the middle — which stays true at every
  // scale, because the board's reach scales with the board.
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const measure = () =>
      setGutter((was) => {
        const now = { x: element.clientWidth / 2, y: element.clientHeight / 2 };
        return was.x === now.x && was.y === now.y ? was : now;
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Where the reader starts: the board's own origin — the first story that
  // fires — in the middle of the pane, not the empty corner of the gutter.
  // Placed once, and only once the gutters exist to place it against; a pane
  // that is still hidden measures zero and is placed when it opens.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || placed.current || gutter.x === 0) return;
    const origin = element.querySelector<HTMLElement>(`[${ORIGIN}]`);
    if (!origin) return;
    placed.current = true;
    const box = origin.getBoundingClientRect();
    const top = box.top - element.getBoundingClientRect().top + element.scrollTop;
    element.scrollLeft = middleOf(element, origin);
    // A story taller than the pane is read from its start, a little below the
    // top edge; one that fits sits in the middle of it. Same expression: the
    // top-inset placement is the further of the two exactly when it doesn't fit.
    element.scrollTop = Math.min(
      top - TOP_INSET,
      top + box.height / 2 - element.clientHeight / 2,
    );
  }, [gutter]);

  // What moves the board moves the grid, at a fraction of it. Both axes are the
  // element's OWN scroll offsets, because the board is the only thing that
  // scrolls — one source, one event, no guessing at which ancestor moved. The
  // gutters only move where zero is; the grid still travels at half the speed
  // of the board, and the offset is folded into one cell either way.
  //
  // One frame, one write: both reads happen inside the same rAF and the offset
  // is written once after them, so a burst of scroll events can never interleave
  // a read with a write and force a reflow per event.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    let frame = 0;
    const paint = (): void => {
      frame = 0;
      const x = pitched(-element.scrollLeft * PARALLAX);
      const y = pitched(-element.scrollTop * PARALLAX);
      element.style.backgroundPosition = `${x}px ${y}px`;
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    schedule();
    element.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
    };
  }, []);

  // The browser's own touch gestures, kept off the canvas — the board has its
  // own answer for both of them.
  //
  // `touch-action: pan-x pan-y` is the standing half: one finger still scrolls
  // natively, and pinch-page-zoom is simply not on offer over the board. But
  // `touch-action` cannot say "one finger is yours, two are mine", and the
  // browser's two-finger scroll would take the fingers first — it starts
  // scrolling and CANCELS the pointers mid-gesture, so the pinch below would
  // never see its second pointer. The second touch vetoes that gesture, and
  // that is all this does: the pointer handlers remain the only thing that
  // tracks a finger.
  //
  // Safari's pinch is neither of those. It is a `gesture*` event that no other
  // browser has, and left alone it zooms the PAGE over the canvas; refusing it
  // is enough, because the same two fingers are already a pointer pinch.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const claim = (event: TouchEvent) => {
      if (event.touches.length >= 2) event.preventDefault();
    };
    const refuse = (event: Event) => event.preventDefault();
    element.addEventListener("touchstart", claim, { passive: false });
    element.addEventListener("touchmove", claim, { passive: false });
    element.addEventListener("gesturestart", refuse);
    element.addEventListener("gesturechange", refuse);
    return () => {
      element.removeEventListener("touchstart", claim);
      element.removeEventListener("touchmove", claim);
      element.removeEventListener("gesturestart", refuse);
      element.removeEventListener("gesturechange", refuse);
    };
  }, []);

  const stop = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = surface.current;
      touches.current.delete(event.pointerId);
      const pinching = pinch.current;
      if (pinching?.pointers.includes(event.pointerId)) {
        pinch.current = null;
        // Back to one finger, and the board keeps moving with it: the pan
        // resumes from where that finger IS and where the board now sits, so
        // the handover costs no movement at all. (A touch pointer is captured
        // to its element implicitly, so it needs no capture of its own.)
        const rest = [...touches.current.entries()][0];
        if (element && rest) {
          drag.current = {
            pointer: rest[0],
            from: rest[1],
            scroll: { x: element.scrollLeft, y: element.scrollTop },
          };
        } else {
          setPanning(false);
        }
        return;
      }
      const held = drag.current;
      if (!held || held.pointer !== event.pointerId) return;
      element?.releasePointerCapture(event.pointerId);
      drag.current = null;
      setPanning(false);
    },
    [],
  );

  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = surface.current;
    if (!element || event.button !== 0) return;
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // A PINCH may start anywhere, including on a card. Panning is the gesture
    // that has to keep its hands off readable things — one finger dragging a
    // card is a read, and might be a selection or a tap. Two fingers spreading
    // are never either of those, whatever they landed on, so the rule that
    // protects reading has nothing to protect here.
    const pair = two(touches.current);
    if (pair) {
      // A pan in progress simply hands the gesture over: it ends where it is,
      // and the pinch grips the board from there — nothing jumps, because the
      // grip is taken from where the board actually is at that moment.
      if (drag.current) {
        element.releasePointerCapture(drag.current.pointer);
        drag.current = null;
      }
      const [ids, points] = pair;
      pinch.current = {
        pointers: ids,
        // Two fingers on the same spot have no span to measure a ratio
        // against; a pixel is close enough to that and is never zero.
        span: Math.max(1, spanOf(points)),
        grip: grip(inPane(element, midpointOf(points))),
      };
      setPanning(true);
      return;
    }
    if (touches.current.size > 1) return;

    if (event.target instanceof Element && event.target.closest(`[${CONTENT}]`)) return;
    drag.current = {
      pointer: event.pointerId,
      from: { x: event.clientX, y: event.clientY },
      scroll: { x: element.scrollLeft, y: element.scrollTop },
    };
    element.setPointerCapture(event.pointerId);
    setPanning(true);
    // Otherwise the browser starts a text selection under the moving board.
    event.preventDefault();
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = surface.current;
    if (!element || !touches.current.has(event.pointerId)) return;
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    // The pinch is measured from where it STARTED, not step by step: the scale
    // is the fingers' span against the span they opened with, and the board
    // point gripped between them goes back under wherever that midpoint has
    // travelled to. So the zoom is continuous, both fingers moving together
    // pans, and either one moving does both at once — one expression, the
    // standard feel. Being absolute is also what makes it steady: every move
    // states the whole answer, so nothing accumulates and nothing drifts.
    const pinching = pinch.current;
    if (pinching) {
      const points = pinching.pointers.map((id) => touches.current.get(id));
      const [a, b] = points;
      if (!a || !b) return;
      zoomTo(
        pinching.grip,
        (pinching.grip.scale * spanOf([a, b])) / pinching.span,
        inPane(element, midpointOf([a, b])),
      );
      return;
    }

    const held = drag.current;
    if (!held || held.pointer !== event.pointerId) return;
    // The browser clamps each assignment to that axis's own range, so a board
    // that only pans one way simply doesn't move the other.
    element.scrollLeft = held.scroll.x - (event.clientX - held.from.x);
    element.scrollTop = held.scroll.y - (event.clientY - held.from.y);
  };

  return (
    // The zoom control has to hold its corner while the board moves under it,
    // so it is a SIBLING of the scroller rather than something inside it —
    // which also means a press on it is never a press on the canvas.
    <div className="relative h-full">
      <div
        ref={surface}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerCancel={stop}
        // `h-full` is the whole point: the board takes the room the pane gives
        // it and scrolls INSIDE that room, on both axes. One finger still moves
        // the board natively, in any direction — `pan-x pan-y` is the default
        // minus exactly one thing, the browser's pinch-page-zoom, which is the
        // board's own gesture to answer and not the page's.
        //
        // The grab cursor is UNCONDITIONAL on empty canvas now: with gutters on
        // every side there is always somewhere to go, however small the story,
        // so the hand no longer promises movement that isn't there. (It only
        // shows on the canvas — each readable thing puts the reading cursor
        // back over itself.)
        className={`h-full touch-pan-x touch-pan-y overflow-auto border border-gray-200 ${BOX} ${
          panning ? "cursor-grabbing select-none [&_*]:cursor-grabbing" : "cursor-grab"
        }`}
        style={GRID_BACKGROUND}
      >
        {/* The gutters. `w-max` keeps the wrapper exactly as wide as the board
            plus its gutters, so the board's own centring is the scroll origin's
            job rather than a margin's. */}
        <div className="w-max" style={{ padding: `${gutter.y}px ${gutter.x}px` }}>
          {/* The board's ROOM. A transform paints small but still lays out
              large, so the scroll range would answer to the unzoomed board and
              the gutters would stop being half a pane from the real edge. This
              box is the board's scaled size, stated as layout — the only place
              the zoom is allowed to touch the scroller. Before the first
              measurement it has none, which is exactly right at 1×. */}
          <div style={reach ? { width: reach.x, height: reach.y } : undefined}>
            {/* `w-max` keeps this sized by the board itself rather than by the
                box it fills, which is what stops the two defining each other. */}
            <div
              ref={board}
              className="w-max origin-top-left"
              style={scale === 1 ? undefined : { transform: `scale(${scale})` }}
            >
              <Surface.Provider value={surface}>{children}</Surface.Provider>
            </div>
          </div>
        </div>
      </div>
      <ZoomControl scale={scale} zoomBy={zoomBy} reset={reset} />
    </div>
  );
}

// ── Zoom ────────────────────────────────────────────────────────────────────

/** How far in and out the board goes. Far enough out to see a tall story whole,
 *  far enough in to read a card across a room; past either end the picture
 *  stops being the thing you came to look at. */
const ZOOM = { min: 0.4, max: 2 };

/** A wheel notch (~100px) is a step of about 15%, and a trackpad pinch — which
 *  the browser reports as the same event, in much smaller amounts — comes out
 *  smooth for free, because the step is EXPONENTIAL in the delta rather than
 *  added on. Zooming out then back in returns to where it started. */
const ZOOM_RATE = 0.0015;

/** What a press of − or + does, as the same kind of step. */
const ZOOM_STEP = 1.25;

interface Zoom {
  scale: number;
  /** The board's scaled size, once measured — the room it takes up. */
  reach: Point | null;
  /** Zoom by a factor, keeping the middle of the pane where it is. */
  zoomBy: (factor: number) => void;
  reset: () => void;
  /** Take hold of the board point under a place in the pane, to be put back
   *  under a place in the pane at a new scale for as long as a gesture runs. */
  grip: (at: Point) => Grip;
  zoomTo: (grip: Grip, scale: number, at: Point) => void;
}

/** A place on the board and the scale it was taken at: everything a gesture
 *  needs to remember about where it began. */
type Grip = { scale: number; held: Point };

/**
 * Zoom, as a scale plus the scroll compensation that keeps a point still.
 *
 * The whole of it is one idea: the point under the cursor is a place ON THE
 * BOARD, and it must still be under the cursor afterwards. In the board's own
 * unscaled coordinates that point is `(scroll + cursor − gutter) / scale`; it
 * does not move when the scale changes, so the scroll that puts it back under
 * the cursor is that same number times the NEW scale, plus the gutter, minus
 * the cursor. Two lines, no measurement, and it composes with everything else
 * because it only ever writes scroll offsets — the one thing that moves the
 * board.
 *
 * The `flushSync` is load-bearing, both ways round. The scroll has to be
 * written into room that already exists, or the browser clamps it to the old
 * range and the board slides out from under the cursor; and the NEXT step has
 * to read a scroll that means what it says, or a burst of steps — a pinch, or
 * anything that fires faster than a render — computes every step after the
 * first from a stale offset and lands somewhere else entirely. Deferring the
 * write to a layout effect fixed the first and not the second. It is cheap
 * because the board is not re-rendered: `children` arrives as the same element
 * either way, so the only thing this render touches is the transform.
 *
 */
function useZoom({
  surface,
  board,
  gutter,
}: {
  surface: React.RefObject<HTMLDivElement | null>;
  board: React.RefObject<HTMLDivElement | null>;
  gutter: Point;
}): Zoom {
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState<Point | null>(null);
  // The same number as the state, kept beside it so a handler can read it
  // without being rebuilt — and re-attached to the surface — every step.
  const scaleRef = useRef(1);
  // The exact scroll this hook last wrote. A scroll offset READS BACK as a
  // whole number however precisely it was written, so a burst of steps would
  // otherwise round once per step and multiply each rounding by every scale
  // after it — a pinch across the whole range walks the board a couple of dozen
  // pixels off the finger. Remembering what we wrote costs one comparison, and
  // the comparison is also how anything else that moves the board (a drag, a
  // link, the reader's own scroll) takes precedence: it disagrees, so it wins.
  const written = useRef<Point | null>(null);

  // The board's own size, unscaled — `offsetWidth` is layout, which a transform
  // famously does not touch, so this is the one measurement that stays honest
  // while the picture is scaled.
  useLayoutEffect(() => {
    const element = board.current;
    if (!element) return;
    const measure = () =>
      setSize((was) => {
        const now = { x: element.offsetWidth, y: element.offsetHeight };
        return was && was.x === now.x && was.y === now.y ? was : now;
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [board]);

  // Where on the board a place in the pane is, in the board's own coordinates —
  // the one thing a zoom must not move.
  const grip = useCallback(
    (at: Point): Grip => {
      const element = surface.current;
      const was = scaleRef.current;
      const from = element ? exactly(written.current, element) : { x: 0, y: 0 };
      return {
        scale: was,
        held: {
          x: (from.x + at.x - gutter.x) / was,
          y: (from.y + at.y - gutter.y) / was,
        },
      };
    },
    [surface, gutter.x, gutter.y],
  );

  // …and putting it back: the same two lines whether `at` is where it was
  // gripped a moment ago (a wheel notch) or has travelled since (a pinch, whose
  // midpoint moves with the fingers). Written outright rather than added to, so
  // a whole gesture is one arithmetic from its own start — and so whatever else
  // moved the board in between is simply corrected.
  const zoomTo = useCallback(
    (grip: Grip, scale: number, at: Point) => {
      const element = surface.current;
      if (!element) return;
      const next = Math.min(ZOOM.max, Math.max(ZOOM.min, scale));
      const to = {
        x: grip.held.x * next + gutter.x - at.x,
        y: grip.held.y * next + gutter.y - at.y,
      };
      scaleRef.current = next;
      flushSync(() => setScale(next));
      element.scrollLeft = to.x;
      element.scrollTop = to.y;
      written.current = to;
    },
    [surface, gutter.x, gutter.y],
  );

  const zoomAt = useCallback(
    (by: (was: number) => number, at: Point) => {
      const from = grip(at);
      const next = Math.min(ZOOM.max, Math.max(ZOOM.min, by(from.scale)));
      if (next === from.scale) return;
      zoomTo(from, next, at);
    },
    [grip, zoomTo],
  );

  // Ctrl+wheel IS the trackpad pinch, in every browser — the same event, so one
  // handler serves both. It cannot be a React `onWheel`: React attaches wheel
  // passively at the root, and a passive listener may not stop the browser from
  // zooming the whole page instead.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(
        (was) => was * Math.exp(-pixels(event) * ZOOM_RATE),
        inPane(element, { x: event.clientX, y: event.clientY }),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [surface, zoomAt]);

  // A button has no cursor to zoom around, so it zooms around the middle of the
  // pane — which is where the reader is looking, and where everything else on
  // this surface already means "here".
  const centred = useCallback(
    (by: (was: number) => number) => {
      const element = surface.current;
      if (!element) return;
      zoomAt(by, { x: element.clientWidth / 2, y: element.clientHeight / 2 });
    },
    [surface, zoomAt],
  );

  return {
    scale,
    reach: size && { x: size.x * scale, y: size.y * scale },
    zoomBy: useCallback(
      (factor: number) => centred((was) => was * factor),
      [centred],
    ),
    reset: useCallback(() => centred(() => 1), [centred]),
    grip,
    zoomTo,
  };
}

/** Where the board actually is, to better than a pixel: what we last wrote, so
 *  long as the element still agrees with it to within the rounding that reading
 *  it back costs. Anything else that moved it disagrees by more, and wins. */
function exactly(written: Point | null, element: HTMLElement): Point {
  const now = { x: element.scrollLeft, y: element.scrollTop };
  if (!written) return now;
  return {
    x: Math.abs(written.x - now.x) < 1 ? written.x : now.x,
    y: Math.abs(written.y - now.y) < 1 ? written.y : now.y,
  };
}

/** A wheel delta in PIXELS, whatever unit the device reported it in. */
function pixels(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * 400;
  return event.deltaY;
}

/**
 * The zoom, said out loud — and the way in for anyone without a trackpad.
 *
 * Quiet on purpose: it is not part of the story, it is a handle on the pane.
 * The reading is also the reset, because "100%" is the only number anyone ever
 * wants to type into it.
 */
function ZoomControl({
  scale,
  zoomBy,
  reset,
}: {
  scale: number;
  zoomBy: (factor: number) => void;
  reset: () => void;
}) {
  const step = "px-2 py-1.5 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600 disabled:pointer-events-none disabled:opacity-40";
  return (
    <div
      className={`absolute bottom-3 right-3 flex items-center overflow-hidden border border-gray-200 bg-white/90 backdrop-blur-sm ${BOX} shadow-[0_1px_2px_rgba(16,24,40,0.10)]`}
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        disabled={scale <= ZOOM.min}
        className={step}
        onClick={() => zoomBy(1 / ZOOM_STEP)}
      >
        <Minus size={13} />
      </button>
      <button
        type="button"
        title="Back to actual size"
        className="min-w-[3.25rem] border-x border-gray-200 px-1 py-1.5 text-[11px] tabular-nums text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
        onClick={reset}
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        disabled={scale >= ZOOM.max}
        className={step}
        onClick={() => zoomBy(ZOOM_STEP)}
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

/**
 * The board itself, for the one thing that has to move it on purpose: following
 * a link from a call to the movement it runs. The board owns both axes, so
 * "take me there" is a scroll of this one element — nothing else on the page
 * knows how to move it, and nothing else should.
 *
 */
const Surface = createContext<React.RefObject<HTMLDivElement | null> | null>(null);

export function useSurface(): React.RefObject<HTMLDivElement | null> | null {
  return useContext(Surface);
}

/**
 * Where the board must be scrolled for something on it to sit in the MIDDLE of
 * the pane — the one answer both the opening position and a followed link use,
 * so "take me to it" and "here is where you start" cannot mean two things. The
 * gutters are what make it always reachable.
 *
 * A column too wide to fit is aligned to its left edge instead: its start is
 * what you read first, and centring it would hide that.
 */
export function middleOf(board: HTMLElement, element: HTMLElement): number {
  const box = element.getBoundingClientRect();
  const left = box.left - board.getBoundingClientRect().left + board.scrollLeft;
  return box.width > board.clientWidth
    ? left - EDGE
    : left + box.width / 2 - board.clientWidth / 2;
}

/** How much canvas to leave beside a column too wide to centre. */
const EDGE = 24;

/** How far below the top edge a story that doesn't fit the pane starts. */
const TOP_INSET = 28;

type Point = { x: number; y: number };
type Drag = { pointer: number; from: Point; scroll: Point };
/** A pinch, as the two things it is measured against: the span the fingers
 *  opened with, and the board point held between them. */
type Pinch = { pointers: [number, number]; span: number; grip: Grip };

/** The two fingers of a pinch, or nothing. A pinch is EXACTLY two, so a third
 *  finger neither starts one nor disturbs the one already running. */
function two(touches: Map<number, Point>): [[number, number], [Point, Point]] | null {
  if (touches.size !== 2) return null;
  const [a, b] = [...touches.entries()];
  return [
    [a[0], b[0]],
    [a[1], b[1]],
  ];
}

function spanOf([a, b]: [Point, Point]): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function midpointOf([a, b]: [Point, Point]): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Where a place on the screen is IN THE PANE — the coordinates every zoom
 *  anchor is stated in, cursor and fingers alike. */
function inPane(element: HTMLElement, point: Point): Point {
  const box = element.getBoundingClientRect();
  return { x: point.x - box.left, y: point.y - box.top };
}

/** The grid repeats, so only the offset WITHIN one cell matters. Folding it
 *  keeps the written value small however far the board has travelled, and keeps
 *  it exact — a number that grows all afternoon eventually stops being one. */
function pitched(offset: number): number {
  return ((offset % GRID_PITCH) + GRID_PITCH) % GRID_PITCH;
}

const CONTENT = "data-story-content";

/**
 * Something a reader can touch. Dragging it never pans the board — it selects
 * the text, clicks the link, does whatever that thing does.
 *
 * The marker goes on the READABLE THING ITSELF, never on anything that merely
 * contains one. That is the whole rule, and getting it wrong is how the board
 * grew dead spots: a marker around a whole column made every gap between two
 * cards, every dashed frame's padding, every empty lane a place the hand
 * refused to push, because those are all inside the column too. Marking the
 * card, the bar, the label — the leaves — leaves the space between them canvas,
 * which is what it looks like.
 *
 * The cursor says which is which without anyone having to try: the surface
 * offers the open hand everywhere, and each readable thing puts the reading
 * cursor back over itself. So the dead spots would be visible if they returned.
 *
 * Spread it over the element's own props (`<span {...readable("…")}>`) rather
 * than wrapping it, so marking something adds no box to the picture.
 *
 */
export function readable(className?: string): {
  className: string;
  [key: string]: string;
} {
  return { className: `cursor-auto ${className ?? ""}`, [CONTENT]: "" };
}

/**
 * Where the board opens. The surface knows nothing about stories — the board
 * marks the one thing a reader should be looking at when the picture appears,
 * and the surface puts THAT in the middle.
 */
export const ORIGIN = "data-story-origin";

export function originAttribute(origin: boolean): Record<string, string> {
  return origin ? { [ORIGIN]: "" } : {};
}
