"use client";

/**
 * The lobby's onboarding: four cards on a blank page, one at a time, and we set
 * the pace.
 *
 * There is no progress bar and no step count — orientation would cost more
 * attention than it buys when the whole flow is four short screens. The only
 * controls are the card's own action, a "Next" that appears when the card has
 * had its moment (read it, or take its action), and a "Back" that is always
 * there (it is an escape, not a push, so it never waits). Position persists in
 * localStorage, so a reload resumes rather than restarts, and a returning user
 * who finished lands straight on the last card — going back never rewinds
 * that landing point, only where you're looking right now.
 *
 * The stage owns the choreography: it is the one element on the page, its
 * height follows whatever card is inside it, and each card sits in a soft-
 * shadowed box painted in by a left→right wipe (onboarding-motion.module.css).
 * The very first card gets a slower, three-beat entrance instead of the plain
 * wipe: a caret blinks at the box's left edge, grows to the box's full height,
 * then sweeps rightward across it — drawing the card into existence rather
 * than just cutting to it.
 */

import { useEffect, useRef, useState } from "react";

import { buttonClass } from "@/components/ui";

import { ConnectCard } from "./ConnectCard";
import { DoneCard } from "./DoneCard";
import { IdeasCard } from "./IdeasCard";
import { SkillCard } from "./SkillCard";
import styles from "./onboarding-motion.module.css";

const STORAGE_KEY = "listen-fire-home-step";

/** The cards you can be "on": connect, skill, ideas. Past the last one is the
 *  completion state, which shows the fourth (done) card. */
const STEP_COUNT = 3;

/** The intro's three beats — the caret drawing the first card into existence.
 *  Played once, for a first-ever visit only (never on resume, never under
 *  reduced motion): a considered pause (blink), the caret becoming full-height
 *  (grow), then the rightward sweep that reveals the card (sweep). */
const INTRO_BLINK_MS = 3000;
const INTRO_GROW_MS = 350;
const INTRO_SWEEP_MS = 1100;

/** Reading time we give a card before offering to move on. */
const IDLE_NEXT_MS = 6000;

/** After the card's action is taken (or its ideas land) the user is already
 *  looking for what's next — just long enough not to feel snatched away. */
const ACTED_NEXT_MS = 1500;

type IntroPhase = "blink" | "grow" | "sweep" | null;

interface Progress {
  current: number;
  furthest: number;
}

function loadProgress(): Progress {
  if (typeof window === "undefined") return { current: 0, furthest: 0 };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { current: 0, furthest: 0 };
    const parsed: Partial<Progress> = JSON.parse(raw);
    // `STEP_COUNT` itself is a valid position: it is the completion state.
    const clamp = (n: unknown) =>
      typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= STEP_COUNT ? n : 0;
    return { current: clamp(parsed.current), furthest: clamp(parsed.furthest) };
  } catch {
    return { current: 0, furthest: 0 };
  }
}

export function OnboardingFlow() {
  // The server (and the pre-hydration client) render an empty stage — the
  // persisted position, and the motion preference, only exist on the client.
  const [progress, setProgress] = useState<Progress>({ current: 0, furthest: 0 });
  const [hydrated, setHydrated] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [introPhase, setIntroPhase] = useState<IntroPhase>(null);
  const [wipeKey, setWipeKey] = useState(0);
  const [acted, setActed] = useState(false);
  const [showNext, setShowNext] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const [stageHeight, setStageHeight] = useState<number | null>(null);

  useEffect(() => {
    const stored = loadProgress();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setProgress(stored);
    setReducedMotion(reduce);
    // Only a first-ever visit gets the intro; anyone resuming has seen it.
    const firstEverVisit = stored.current === 0 && stored.furthest === 0;
    setIntroPhase(firstEverVisit && !reduce ? "blink" : null);
    setHydrated(true);
    // Read once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  }, [progress, hydrated]);

  // The stage is exactly as tall as whatever is in it, and eases between sizes
  // — the real card is mounted (just hidden under the intro's cover) from the
  // start, so the box is already at its true, final height for the whole
  // intro; this only fires later, for a card-to-card size change.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const sync = () => setStageHeight(el.offsetHeight);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (introPhase !== "blink") return;
    const timer = setTimeout(() => setIntroPhase("grow"), INTRO_BLINK_MS);
    return () => clearTimeout(timer);
  }, [introPhase]);

  useEffect(() => {
    if (introPhase !== "grow") return;
    const timer = setTimeout(() => setIntroPhase("sweep"), INTRO_GROW_MS);
    return () => clearTimeout(timer);
  }, [introPhase]);

  useEffect(() => {
    if (introPhase !== "sweep") return;
    const timer = setTimeout(() => setIntroPhase(null), INTRO_SWEEP_MS);
    return () => clearTimeout(timer);
  }, [introPhase]);

  const { current } = progress;
  const complete = current === STEP_COUNT;

  // The ideas card's gate is its own content arriving, never a timer — there is
  // nothing to read until then.
  const idleCard = introPhase === null && hydrated && !complete && current < 2 ? current : null;
  useEffect(() => {
    if (idleCard === null) return;
    const timer = setTimeout(() => setShowNext(true), IDLE_NEXT_MS);
    return () => clearTimeout(timer);
  }, [idleCard]);

  useEffect(() => {
    if (!acted) return;
    const timer = setTimeout(() => setShowNext(true), ACTED_NEXT_MS);
    return () => clearTimeout(timer);
  }, [acted]);

  const advance = () => {
    setShowNext(false);
    setActed(false);
    setProgress((p) => {
      const next = Math.min(p.current + 1, STEP_COUNT);
      return { current: next, furthest: Math.max(p.furthest, next) };
    });
    setWipeKey((k) => k + 1);
  };

  // Back is an escape, not a push: no pacing, and it only moves `current` —
  // `furthest` (what the intro-skip check and a returning user's landing card
  // depend on) never rewinds. Reuses the same wipe rather than a mirrored one.
  const goBack = () => {
    setShowNext(false);
    setActed(false);
    setProgress((p) => ({ ...p, current: Math.max(p.current - 1, 0) }));
    setWipeKey((k) => k + 1);
  };

  const canGoBack = hydrated && introPhase === null && current > 0;

  const card = () => {
    if (complete) return <DoneCard />;
    if (current === 0) return <ConnectCard onAction={() => setActed(true)} />;
    if (current === 1) return <SkillCard onAction={() => setActed(true)} />;
    return <IdeasCard onIdeas={() => setActed(true)} />;
  };

  return (
    <>
      <div className="flex min-h-dvh flex-col items-center justify-center px-6">
        {/* The padding/negative-margin pair moves the stage's clip boundary
            clear of the card's shadow (which overflow:hidden would truncate)
            without changing the card's size or position; the padding lives
            inside contentRef so the measured stage height includes it. */}
        <div className="w-full max-w-2xl">
          <div
            className={`-mx-6 -mt-10 -mb-14 sm:-mx-10 ${styles.stage}`}
            style={stageHeight === null ? undefined : { height: stageHeight }}
          >
            <div ref={contentRef} className="relative px-6 pt-10 pb-14 sm:px-10">
            {/* During the intro the whole card — border and shadow included —
                is clip-hidden and drawn in by the sweep, so the box does not
                pre-exist around the caret. wipeIn only runs on card-to-card
                swaps (wipeKey moves off 0), never against the intro clip. */}
            <div
              key={wipeKey}
              className={`relative overflow-hidden rounded-2xl border border-gray-100 bg-white p-10 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_18px_45px_-18px_rgba(15,23,42,0.22)] ${
                introPhase
                  ? `${styles.introHidden} ${
                      introPhase === "sweep" ? styles.introRevealing : ""
                    }`
                  : wipeKey !== 0 && !reducedMotion
                    ? styles.wipeIn
                    : ""
              }`}
            >
              {hydrated && card()}
            </div>

            {introPhase && (
              <div
                className="pointer-events-none absolute bottom-14 left-6 right-6 top-10 z-10 sm:left-10 sm:right-10"
                aria-hidden
              >
                <span
                  className={`${styles.introCaret} ${
                    introPhase !== "blink" ? styles.introCaretFull : ""
                  } ${introPhase === "sweep" ? styles.introCaretSweep : ""}`}
                />
                <span
                  className={`${styles.introDots} ${
                    introPhase !== "blink" ? styles.introDotsHidden : ""
                  }`}
                >
                  <span className={`${styles.dot} h-2 w-2`} />
                  <span className={`${styles.dot} h-2 w-2`} />
                  <span className={`${styles.dot} h-2 w-2`} />
                </span>
              </div>
            )}

            {/* Always rendered at fixed height so a button appearing never
                shifts the card or re-eases the stage. */}
            <div className="mt-10 flex h-8 items-center justify-between">
              <div>
                {canGoBack && (
                  <button
                    type="button"
                    onClick={goBack}
                    className={buttonClass({ variant: "ghost", size: "sm" })}
                    data-testid="onboarding-back"
                  >
                    ‹ Back
                  </button>
                )}
              </div>
              <div>
                {showNext && !complete && (
                  <button
                    type="button"
                    onClick={advance}
                    className={`${buttonClass({ variant: "ghost", size: "sm" })} ${styles.fadeIn}`}
                    data-testid="onboarding-next"
                  >
                    Next
                  </button>
                )}
              </div>
            </div>
            </div>
          </div>
        </div>
      </div>

    </>
  );
}
